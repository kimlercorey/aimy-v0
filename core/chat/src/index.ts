#!/usr/bin/env node
/**
 * chat/src/index.ts — `aimy-chat`: the minimal terminal chat harness.
 *
 * Boots the production-shape stack (kernel → memory → pool + local provider
 * → hooks → agent loop + honesty), then runs a REPL: type a line, watch the
 * tokens stream, see tool calls as they happen, get the honesty summary at
 * the end of every turn.
 *
 * Thin harness only: no product surface, no new framework.
 */
import { Effect, Layer, Stream } from "effect"
import * as net from "node:net"
import * as readline from "node:readline"
import { AgentLoop, type ChatChunk, type TurnReport } from "../../agent-loop/src/index.js"
import { HonestyService } from "../../honesty/index.js"
import { InferencePool } from "../../inference-pool/index.js"
import { ModuleHost } from "../../module-seam/src/index.js"
import { HttpClient } from "../../web-research/src/http.js"
import { buildChatStack } from "./stack.js"
import { DEFAULT_SESSION, USAGE, parseArgs } from "./args.js"
import {
  bootResearchModule,
  makeResearchToolForChat,
  researchViaSeam,
  RESEARCH_MODULE,
  type ResearchTool
} from "./research.js"
import {
  formatHonestySummary,
  formatToolResult,
  friendlyErrorMessage,
  parseCommand,
  parseResearchCommand,
  renderResearchReport
} from "./render.js"

const newSessionId = (): string => `cli-${Date.now().toString(36)}`

/** Light TCP preflight: is anything listening at the model endpoint? */
const preflight = (baseUrl: string): Promise<boolean> =>
  new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      resolve(false)
      return
    }
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port)
    const sock = net.connect({ host: url.hostname, port }, () => {
      sock.destroy()
      resolve(true)
    })
    sock.setTimeout(2500)
    sock.on("timeout", () => {
      sock.destroy()
      resolve(false)
    })
    sock.on("error", () => resolve(false))
  })

const renderChunk = (chunk: ChatChunk): void => {
  switch (chunk._tag) {
    case "Token":
      process.stdout.write(chunk.delta)
      break
    case "ToolCall":
      process.stdout.write(`\n🔧 ${chunk.tool} → ${formatToolResult(chunk.result)}\n`)
      break
    case "Done": {
      const report: TurnReport = chunk.report
      process.stdout.write("\n" + formatHonestySummary(report) + "\n")
      break
    }
  }
}

const printFriendlyError = (err: unknown): void => {
  const tagged = err !== null && typeof err === "object" && "_tag" in err
    ? (err as { readonly _tag: string } & Record<string, unknown>)
    : { _tag: "UnknownError", message: String(err) }
  const { headline, hint } = friendlyErrorMessage(tagged)
  process.stdout.write(`\n⚠️  ${headline}\n`)
  if (hint !== undefined) process.stdout.write(`   ${hint}\n`)
}

/**
 * One "research <query>" through the module seam, in the background: the
 * prompt stays live so /research-off can land mid-run. Uses the stashed
 * boot-built host+tool (the layer rebuilds on every provide, so re-providing
 * would lose the module install).
 */
const runResearchBackground = (
  host: import("../../module-seam/src/index.js").ModuleHostApi | undefined,
  tool: ResearchTool | undefined,
  researchHookCounts: { beforeToolCall: number; afterToolCall: number },
  query: string,
  sessionId: string
): void => {
  if (host === undefined || tool === undefined) {
    process.stdout.write("research module is not booted\n")
    return
  }
  const turnId = `cli-research-${Date.now().toString(36)}`
  process.stdout.write(`🔍 researching "${query}" through the module seam…\n`)
  const prog = Effect.gen(function* () {
    const report = yield* researchViaSeam(host, tool, query, sessionId, turnId)
    process.stdout.write(renderResearchReport(report) + "\n")
    process.stdout.write(
      `[research] hooks fired: beforeToolCall=${researchHookCounts.beforeToolCall} afterToolCall=${researchHookCounts.afterToolCall}\n`
    )
  })
  void Effect.runPromise(Effect.catch(prog, (e) => Effect.sync(() => printFriendlyError(e))))
}

/** /research-off and /research-on: disable/enable the module mid-run-capable. */
const setResearchEnabled = (
  host: import("../../module-seam/src/index.js").ModuleHostApi | undefined,
  researchHookCounts: { beforeToolCall: number; afterToolCall: number },
  on: boolean
): void => {
  if (host === undefined) {
    process.stdout.write("research module is not booted\n")
    return
  }
  const prog = Effect.gen(function* () {
    if (on) {
      yield* host.enable(RESEARCH_MODULE)
      yield* host.start(RESEARCH_MODULE)
    } else {
      yield* host.disable(RESEARCH_MODULE)
    }
    const runtime = yield* host.runtimeModules()
    process.stdout.write(
      on
        ? `research module enabled — runtime: [${runtime.join(", ")}]\n`
        : `research module disabled — hooks fired so far: beforeToolCall=${researchHookCounts.beforeToolCall} afterToolCall=${researchHookCounts.afterToolCall}; runtime: [${runtime.join(", ")}]\n`
    )
  })
  void Effect.runPromise(Effect.catch(prog, (e) => Effect.sync(() => printFriendlyError(e))))
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  if (args.model === undefined) {
    process.stderr.write("missing --model (or set AIMY_MODEL)\n\n" + USAGE + "\n")
    process.exit(2)
  }
  const model = args.model

  process.stdout.write("AImy chat — booting the stack…\n")
  const { layer, provider, researchHookCounts } = buildChatStack({ baseUrl: args.baseUrl, model })

  const reachable = await preflight(args.baseUrl)
  if (!reachable) {
    process.stdout.write(
      `⚠️  nothing listening at ${args.baseUrl}\n` +
        "   start your local model first — `ollama serve` (Ollama) or `llama-server -m <model.gguf>` (llama.cpp)\n" +
        "   (you can start it in another terminal; this chat will keep trying)\n"
    )
  }

  // The layer rebuilds on every Effect.provide, so the research module's
  // host + tool are stashed from the boot build (same close-over pattern as
  // `provider` above): every "research <query>" must hit the SAME ModuleHost
  // the module was installed on, or the install would be lost.
  let researchHost: import("../../module-seam/src/index.js").ModuleHostApi | undefined
  let researchTool: ResearchTool | undefined

  // Register once; the same provider object also feeds the loop's streamer.
  const boot = Effect.gen(function* () {
    const pool = yield* InferencePool
    yield* pool.register(provider)
    const host = yield* ModuleHost
    const honesty = yield* HonestyService
    const http = yield* HttpClient
    yield* bootResearchModule(host)
    researchHost = host
    researchTool = makeResearchToolForChat(http, honesty)
  })
  await Effect.runPromise(Effect.provide(boot, layer)).catch((e) => {
    printFriendlyError(e)
    process.exit(1)
  })

  let sessionId = args.session ?? DEFAULT_SESSION
  process.stdout.write(
    `connected: ${args.baseUrl} · model ${model} · session "${sessionId}"\n` +
      `research module "${RESEARCH_MODULE}" installed+started (tier T1, egress: html.duckduckgo.com)\n` +
      "type a message, `research <query>`, or /help\n\n"
  )

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  let closed = false
  rl.on("close", () => {
    closed = true
  })
  // null = stdin closed (Ctrl+D / EOF): end the session gracefully.
  const question = (prompt: string): Promise<string | null> =>
    new Promise((resolve) => {
      if (closed) return resolve(null)
      try {
        rl.question(prompt, resolve)
      } catch {
        resolve(null)
      }
    })

  for (;;) {
    const line = await question("you> ")
    if (line === null || closed) {
      process.stdout.write("\nbye\n")
      break
    }
    // "research <query>" runs through the module seam in the BACKGROUND, so
    // the prompt stays live: /research-off can land mid-run (true mid-run
    // disable — the in-flight call's trailing hooks stop firing).
    const researchQuery = parseResearchCommand(line)
    if (researchQuery !== undefined) {
      if (researchQuery.trim() === "") {
        process.stdout.write("usage: research <query>\n")
        continue
      }
      runResearchBackground(researchHost, researchTool, researchHookCounts, researchQuery.trim(), sessionId)
      continue
    }
    const cmd = parseCommand(line)
    if (cmd === "quit") {
      process.stdout.write("bye\n")
      break
    }
    if (cmd === "new") {
      sessionId = newSessionId()
      process.stdout.write(`new session "${sessionId}"\n`)
      continue
    }
    if (cmd === "help") {
      process.stdout.write(
        "commands: /new (fresh session)  /quit  /help  /research-off  /research-on\n" +
          "          research <query> — sourced answer with per-claim verification badges\n"
      )
      continue
    }
    if (cmd === "researchOff") {
      setResearchEnabled(researchHost, researchHookCounts, false)
      continue
    }
    if (cmd === "researchOn") {
      setResearchEnabled(researchHost, researchHookCounts, true)
      continue
    }
    if (cmd === "unknown") {
      process.stdout.write("unknown command — try /help\n")
      continue
    }
    if (cmd.input.trim() === "") continue

    const turn = Effect.gen(function* () {
      const loop = yield* AgentLoop
      process.stdout.write("AImy: ")
      yield* Stream.runForEach(loop.chat(sessionId, cmd.input), (chunk) =>
        Effect.sync(() => renderChunk(chunk))
      )
      process.stdout.write("\n")
    })
    await Effect.runPromise(Effect.provide(Effect.catch(turn, (e) => Effect.sync(() => printFriendlyError(e))), layer))
  }
  rl.close()
}

main().catch((e) => {
  printFriendlyError(e)
  process.exit(1)
})
