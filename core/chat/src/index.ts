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
import { AgentLoop, type AgentToolDef, type ChatChunk, type TurnReport } from "../../agent-loop/src/index.js"
import { HonestyService } from "../../honesty/index.js"
import { InferencePool } from "../../inference-pool/index.js"
import { ModuleHost } from "../../module-seam/src/index.js"
import { HttpClient } from "../../web-retrieval/src/http.js"
import { buildChatStack } from "./stack.js"
import { DEFAULT_SESSION, USAGE, parseArgs } from "./args.js"
import {
  bootRetrievalModule,
  braveSearchConfigured,
  makeBraveMediaAgentTools,
  makeBraveMediaToolsForChat,
  makeRetrievalAgentTool,
  makeRetrievalToolForChat,
  retrievalViaSeam,
  RETRIEVAL_MODULE,
  type BraveMediaTool,
  type RetrievalTool
} from "./retrieval.js"
import {
  bootResearchModule,
  makePoolPlanModel,
  makeResearchAgentTool,
  makeResearchToolForChat,
  renderResearchReport,
  RESEARCH_MODULE,
  type ResearchTool,
  type ResearchToolFactory
} from "./research.js"
import { makeBackgroundJobRegistry } from "../../agent-loop/src/background-job.js"
import {
  formatHonestySummary,
  formatToolResult,
  friendlyErrorMessage,
  parseCommand,
  parseResearchCommand,
  parseRetrievalCommand,
  renderRetrievalReport
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
 * One "retrieval <query>" through the module seam, in the background: the
 * prompt stays live so /retrieval-off can land mid-run. Uses the stashed
 * boot-built host+tool (the layer rebuilds on every provide, so re-providing
 * would lose the module install).
 */
const runRetrievalBackground = (
  host: import("../../module-seam/src/index.js").ModuleHostApi | undefined,
  tool: RetrievalTool | undefined,
  retrievalHookCounts: { beforeToolCall: number; afterToolCall: number },
  query: string,
  sessionId: string
): void => {
  if (host === undefined || tool === undefined) {
    process.stdout.write("retrieval module is not booted\n")
    return
  }
  const turnId = `cli-retrieval-${Date.now().toString(36)}`
  process.stdout.write(`🔍 retrieving "${query}" through the module seam…\n`)
  const prog = Effect.gen(function* () {
    const report = yield* retrievalViaSeam(host, tool, query, sessionId, turnId)
    process.stdout.write(renderRetrievalReport(report) + "\n")
    process.stdout.write(
      `[retrieval] hooks fired: beforeToolCall=${retrievalHookCounts.beforeToolCall} afterToolCall=${retrievalHookCounts.afterToolCall}\n`
    )
  })
  void Effect.runPromise(Effect.catch(prog, (e) => Effect.sync(() => printFriendlyError(e))))
}

/**
 * One "research <query>" in the background (prompt stays live), invoking
 * the module tool directly — the same flow the model's research.query
 * agent tool wraps (project binding + run records ride in that wrapper
 * when the model calls it; this prefix runs the bare module tool).
 */
const runResearchBackground = (
  tool: ResearchTool | undefined,
  query: string,
  sessionId: string
): void => {
  if (tool === undefined) {
    process.stdout.write("research module is not booted\n")
    return
  }
  const turnId = `cli-research-${Date.now().toString(36)}`
  process.stdout.write(`🔬 researching "${query}"…\n`)
  const prog = Effect.gen(function* () {
    const report = yield* tool.invoke({ query, sessionId, turnId })
    process.stdout.write(renderResearchReport(report) + "\n")
  })
  void Effect.runPromise(Effect.catch(prog, (e) => Effect.sync(() => printFriendlyError(e))))
}

/** /retrieval-off and /retrieval-on: disable/enable the module mid-run-capable. */
const setRetrievalEnabled = (
  host: import("../../module-seam/src/index.js").ModuleHostApi | undefined,
  retrievalHookCounts: { beforeToolCall: number; afterToolCall: number },
  on: boolean
): void => {
  if (host === undefined) {
    process.stdout.write("retrieval module is not booted\n")
    return
  }
  const prog = Effect.gen(function* () {
    if (on) {
      yield* host.enable(RETRIEVAL_MODULE)
      yield* host.start(RETRIEVAL_MODULE)
    } else {
      yield* host.disable(RETRIEVAL_MODULE)
    }
    const runtime = yield* host.runtimeModules()
    process.stdout.write(
      on
        ? `retrieval module enabled — runtime: [${runtime.join(", ")}]\n`
        : `retrieval module disabled — hooks fired so far: beforeToolCall=${retrievalHookCounts.beforeToolCall} afterToolCall=${retrievalHookCounts.afterToolCall}; runtime: [${runtime.join(", ")}]\n`
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

  // The retrieval tool as a MODEL-CALLABLE agent tool (not just the CLI
  // `retrieval <query>` prefix). It closes over the same mutable ref the
  // boot build stashes — the loop only runs tools during chat, after boot.
  // Shared factory with the desktop engine: one definition, one description.
  let retrievalTool: RetrievalTool | undefined
  const retrievalAgentTool = makeRetrievalAgentTool(() => retrievalTool)
  // Brave media tools (2026-10-13): registered only when a Brave key
  // is configured, same gate as the desktop engine.
  let braveMediaTools: ReadonlyArray<BraveMediaTool> | undefined
  const braveMediaAgentTools = makeBraveMediaAgentTools(() => braveMediaTools)
  let researchToolFactory: ResearchToolFactory | undefined
  const researchAgentTool = makeResearchAgentTool((onStage) => researchToolFactory?.(onStage))
  // The CLI gains a background registry (charter E17): job.spawn works
  // here exactly as in the desktop engine.
  const backgroundJobs = await Effect.runPromise(makeBackgroundJobRegistry())
  const { layer, provider, retrievalHookCounts } = buildChatStack({
    baseUrl: args.baseUrl,
    model,
    extraTools: [retrievalAgentTool, researchAgentTool, ...(braveSearchConfigured() ? braveMediaAgentTools : [])],
    backgroundJobs
  })

  const reachable = await preflight(args.baseUrl)
  if (!reachable) {
    process.stdout.write(
      `⚠️  nothing listening at ${args.baseUrl}\n` +
        "   start your local model first — `ollama serve` (Ollama) or `llama-server -m <model.gguf>` (llama.cpp)\n" +
        "   (you can start it in another terminal; this chat will keep trying)\n"
    )
  }

  // The layer rebuilds on every Effect.provide, so the retrieval module's
  // host + tool are stashed from the boot build (same close-over pattern as
  // `provider` above): every "retrieval <query>" must hit the SAME ModuleHost
  // the module was installed on, or the install would be lost.
  let retrievalHost: import("../../module-seam/src/index.js").ModuleHostApi | undefined

  // Register once; the same provider object also feeds the loop's streamer.
  const boot = Effect.gen(function* () {
    const pool = yield* InferencePool
    yield* pool.register(provider)
    const host = yield* ModuleHost
    const honesty = yield* HonestyService
    const http = yield* HttpClient
    yield* bootRetrievalModule(host)
    retrievalHost = host
    retrievalTool = makeRetrievalToolForChat(http, honesty)
    braveMediaTools = makeBraveMediaToolsForChat(http)
    yield* bootResearchModule(host)
    researchToolFactory = (onStage) => makeResearchToolForChat(http, honesty, makePoolPlanModel(pool), onStage)
  })
  await Effect.runPromise(Effect.provide(boot, layer)).catch((e) => {
    printFriendlyError(e)
    process.exit(1)
  })

  let sessionId = args.session ?? DEFAULT_SESSION
  process.stdout.write(
    `connected: ${args.baseUrl} · model ${model} · session "${sessionId}"\n` +
      `retrieval module "${RETRIEVAL_MODULE}" installed+started (tier T1, egress: html.duckduckgo.com)\n` +
      `research module "${RESEARCH_MODULE}" installed+started (tier T1) — or just ask her to research something\n` +
      "type a message, `retrieval <query>`, `research <query>`, or /help\n\n"
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
    // "retrieval <query>" runs through the module seam in the BACKGROUND, so
    // the prompt stays live: /retrieval-off can land mid-run (true mid-run
    // disable — the in-flight call's trailing hooks stop firing).
    const retrievalQuery = parseRetrievalCommand(line)
    if (retrievalQuery !== undefined) {
      if (retrievalQuery.trim() === "") {
        process.stdout.write("usage: retrieval <query>\n")
        continue
      }
      runRetrievalBackground(retrievalHost, retrievalTool, retrievalHookCounts, retrievalQuery.trim(), sessionId)
      continue
    }
    const researchQuery = parseResearchCommand(line)
    if (researchQuery !== undefined) {
      if (researchQuery.trim() === "") {
        process.stdout.write("usage: research <query>\n")
        continue
      }
      runResearchBackground(researchToolFactory?.(), researchQuery.trim(), sessionId)
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
        "commands: /new (fresh session)  /quit  /help  /retrieval-off  /retrieval-on\n" +
          "          retrieval <query> — sourced answer with per-claim verification badges\n" +
          "          research <query> — planned, multi-query investigation with ledger-backed claims\n"
      )
      continue
    }
    if (cmd === "retrievalOff") {
      setRetrievalEnabled(retrievalHost, retrievalHookCounts, false)
      continue
    }
    if (cmd === "retrievalOn") {
      setRetrievalEnabled(retrievalHost, retrievalHookCounts, true)
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
