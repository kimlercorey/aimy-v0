/**
 * m1-wiring.test.ts — M1 acceptance: the production-shape full stack, wired
 * and driven end to end.
 *
 * Stack (Layers, no test doubles anywhere in the trust path):
 *   SafetyKernel.layerFromPolicy(policy)
 *     -> kernel-backed PermissionGate behind MemoryServiceLive (+ tmp MemoryPaths)
 *     -> InferencePoolLive with ONE registered LocalHttpProvider (real HTTP,
 *        loopback, against a node:http mock chat-completions server)
 *     -> ModuleHooks with the REAL kernel behind the SafetyKernelSeam plus a
 *        recording hook impl
 *     -> AgentLoop via layerAgentLoop({ streamProviders: [provider] }) —
 *        the same provider object is registered with the pool AND handed to
 *        the loop, so Token chunks stream live through Provider.stream.
 *
 * Covers:
 *   1. Zero-socket boot: the whole stack builds with no provider registered
 *      and no network call is made (M0/M1 invariant — must not regress).
 *   2. Streaming chat against the mock server: SSE deltas re-emit as Token
 *      chunks in order, ending with Done.
 *   3. A ```aimy-tool block for clock.now executes through the full hook
 *      gate (before/afterToolCall observed, real timestamp result,
 *      TurnReport.executed.length === 1).
 *   4. Network killed mid-turn: the chat stream fails with a typed
 *      InferenceError (no hang, no raw exception).
 *   5. Memory persistence across two turns through the full stack.
 *   6. Writes agent-loop/DEMO.md from a REAL run of the wired stack.
 */
import { Duration, Effect, Layer, Stream } from "effect"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http"
import { type AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"
import {
  InferenceError,
  InferencePool,
  InferencePoolLive,
  LocalHttpProvider,
  type Provider
} from "./inference-pool/index.js"
import {
  MemoryDirs,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
  PermissionGate
} from "./memory/index.js"
import {
  Allow,
  HookError,
  ModuleHooks,
  makeModuleHooks,
  type GateVerdict,
  type ModuleHookImpls,
  type SafetyKernelSeam
} from "./module-seam/src/index.js"
import {
  PolicyDocument,
  SafetyKernel,
  type SafetyKernelService
} from "./permission-kernel/index.js"
import { PermissionDenied } from "./substrate/errors.js"
import { ToolName } from "./substrate/types.js"
import {
  AgentLoop,
  layerAgentLoop,
  type ChatChunk,
  type TurnReport
} from "./agent-loop/src/index.js"

// ---------------------------------------------------------------------------
// Fixtures (the proven patterns from integration.test.ts / loop.test.ts)
// ---------------------------------------------------------------------------

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "aimy-m1-test-"))

const pathsLayer = (dir: string): Layer.Layer<MemoryPaths> =>
  Layer.succeed(MemoryPaths, {
    sessionsDir: path.join(dir, "sessions"),
    storesDir: path.join(dir, "stores")
  } satisfies MemoryDirs)

/** Production-shape gate: every memory op decided by the real SafetyKernel. */
const kernelBackedGate: Layer.Layer<PermissionGate, never, SafetyKernel> = Layer.effect(
  PermissionGate,
  Effect.gen(function* () {
    const kernel = yield* SafetyKernel
    return {
      checkMemory: (op: "read" | "write", store: string) =>
        Effect.gen(function* () {
          const tier = op === "read" ? ("T0" as const) : ("T1" as const)
          const tool = ToolName(`memory:${store}:${op}`)
          const decision = yield* kernel.check({
            tool,
            tier,
            // Distinguishing args: the kernel fingerprints intents by args,
            // so distinct operations must not share one fingerprint.
            args: { op, store },
            provenance: "m1-wiring-test/memory-gate"
          })
          if (decision === "ask") {
            return yield* Effect.fail(
              new PermissionDenied({
                tool,
                tier,
                reason: "ask unresolved: no interactive approver in headless tests"
              })
            )
          }
        })
    }
  })
)

/**
 * Adapt the REAL SafetyKernel behind the module-seam's structural
 * `SafetyKernelSeam` (same adapter as agent-loop/test/loop.test.ts).
 */
const seamFromKernel = (kernel: SafetyKernelService): SafetyKernelSeam => {
  const toKernelIntent = (intent: { tool: string; tier: "T0" | "T1" | "T2" | "T3"; module: string }) => ({
    tool: ToolName(intent.tool),
    tier: intent.tier,
    args: { module: intent.module, tool: intent.tool, tier: intent.tier },
    provenance: `m1-wiring:${intent.module}`
  })
  return {
    check: (intent) =>
      kernel.check(toKernelIntent(intent)).pipe(
        Effect.map(
          (decision): GateVerdict =>
            decision === "allow"
              ? Allow
              : Ask("ask unresolved: no interactive approver in headless tests")
        ),
        Effect.catch((denied: PermissionDenied) =>
          Effect.succeed<GateVerdict>({ _tag: "Deny", reason: denied.reason, terminate: false })
        )
      ),
    execute: (intent, run) => kernel.execute(toKernelIntent(intent), () => run)
  }
}

const hooksLayer = (
  impls: ReadonlyArray<ModuleHookImpls>
): Layer.Layer<ModuleHooks, never, SafetyKernel> =>
  Layer.effect(
    ModuleHooks,
    Effect.gen(function* () {
      const kernel = yield* SafetyKernel
      return makeModuleHooks({ impls, kernel: seamFromKernel(kernel) })
    })
  )

const openPolicy: PolicyDocument = {
  version: 1,
  rules: [
    { tool: "*", tier: "T0", decision: "allow", reason: "m1 wiring: T0 reads and tools" },
    { tool: "*", tier: "T1", decision: "allow", reason: "m1 wiring: memory writes" },
    { tool: "*", tier: "T2", decision: "deny", reason: "m1 wiring default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "m1 wiring default" }
  ]
}

interface StackOpts {
  readonly policy?: PolicyDocument
  readonly impls?: ReadonlyArray<ModuleHookImpls>
  /** Passed to the loop as streamProviders; registration with the pool is the program's job. */
  readonly streamProviders?: ReadonlyArray<Provider>
}

/**
 * The production-shape stack. The SAME provider object must be registered
 * with the pool (for powerhouse routing) and handed to the loop (for live
 * streaming) — the program does the registering.
 */
const buildStack = (dir: string, opts: StackOpts = {}): Layer.Layer<AgentLoop | InferencePool | MemoryService> => {
  const kernelLayer = SafetyKernel.layerFromPolicy(opts.policy ?? openPolicy)
  const memoryStack = Layer.provide(
    Layer.provide(MemoryServiceLive, Layer.mergeAll(kernelBackedGate, pathsLayer(dir))),
    kernelLayer
  )
  const hooksStack = Layer.provide(hooksLayer(opts.impls ?? []), kernelLayer)
  const base = Layer.mergeAll(InferencePoolLive, hooksStack, memoryStack)
  const loopOnly = Layer.provide(layerAgentLoop({ streamProviders: opts.streamProviders ?? [] }), base)
  return Layer.mergeAll(loopOnly, InferencePoolLive, memoryStack)
}

// ---------------------------------------------------------------------------
// Mock chat-completions server (node:http, same wire shape as
// llama.cpp-server / Ollama: JSON when stream=false, SSE when stream=true)
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void

interface MockServer {
  readonly url: string
  readonly close: () => Promise<void>
}

const startMock = (handler: Handler): Promise<MockServer> =>
  new Promise((resolve, reject) => {
    const server: Server = createServer(handler)
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done, failed) => server.close((err) => (err === undefined ? done() : failed(err))))
      })
    })
  })

const readJsonBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })

const jsonOk = (res: ServerResponse, payload: unknown): void => {
  const body = JSON.stringify(payload)
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

const sseChunk = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

const chatCompletionsPayload = (content: string): unknown => ({
  choices: [{ message: { role: "assistant", content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 }
})

/**
 * Scripted mock: `script` returns the response text per request (stateful —
 * different turns can get different replies). Captures request bodies so
 * tests can assert what the loop actually sent to the endpoint.
 */
const scriptedMock = (
  script: () => string,
  opts: { readonly bodies?: Array<Record<string, unknown>>; readonly killMidStream?: boolean } = {}
): Promise<MockServer> =>
  startMock((req, res) => {
    void readJsonBody(req).then((body) => {
      opts.bodies?.push(body)
      const text = script()
      if (body["stream"] === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        if (opts.killMidStream) {
          res.write(sseChunk(text.slice(0, Math.max(1, Math.floor(text.length / 2)))))
          // Abrupt drop mid-stream: no [DONE], socket destroyed.
          res.destroy()
          return
        }
        // Split into a few chunks so the loop sees more than one Token delta.
        const mid = Math.floor(text.length / 3)
        res.write(sseChunk(text.slice(0, mid)))
        res.write(sseChunk(text.slice(mid, 2 * mid)))
        res.write(sseChunk(text.slice(2 * mid)))
        res.write("data: [DONE]\n\n")
        res.end()
      } else {
        jsonOk(res, chatCompletionsPayload(text))
      }
    })
  })

const makeProvider = (url: string): LocalHttpProvider =>
  new LocalHttpProvider({ name: "m1-http", baseUrl: url, model: "m1-test-model", timeoutMs: 5000 })

/** Register the provider with the pool, run one chat, collect every chunk. */
const collectChat = (
  stack: Layer.Layer<AgentLoop | InferencePool | MemoryService>,
  provider: LocalHttpProvider,
  sessionId: string,
  input: string
): Promise<Array<ChatChunk>> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(provider)
        const loop = yield* AgentLoop
        return [...(yield* Stream.runCollect(loop.chat(sessionId, input)))]
      }),
      stack
    )
  )

const doneReport = (chunks: ReadonlyArray<ChatChunk>): TurnReport => {
  const last = chunks[chunks.length - 1]
  if (last === undefined || last._tag !== "Done") throw new Error("expected final Done chunk")
  return last.report
}

const tokenDeltas = (chunks: ReadonlyArray<ChatChunk>): Array<string> =>
  chunks.filter((c) => c._tag === "Token").map((c) => (c as { delta: string }).delta)

const toolBlock = (tool: string, args: unknown = {}): string =>
  "```aimy-tool\n" + JSON.stringify({ tool, args }) + "\n```"

const isoTs = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// ---------------------------------------------------------------------------
// 1. Zero-socket boot (the M0/M1 invariant)
// ---------------------------------------------------------------------------

describe("m1 wiring: zero-socket boot", () => {
  it("building the whole stack with NO provider registered opens zero sockets and performs no fetch", async () => {
    const connectSpy = vi.spyOn(net.Socket.prototype, "connect")
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    try {
      const dir = tmpRoot()
      // The provider object exists (construction is zero-I/O by design) but
      // is never registered — the stack must still build silently.
      const provider = makeProvider("http://127.0.0.1:1")
      void provider
      const stack = buildStack(dir, { streamProviders: [] })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(stack)
            // A trivial memory op proves the stack is live, not just built.
            const trivial = Effect.gen(function* () {
              const mem = yield* MemoryService
              yield* mem.set("kv-check", "k", "v")
            })
            yield* Effect.provide(trivial, ctx)
          })
        )
      )
      expect(connectSpy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      connectSpy.mockRestore()
      fetchSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Streaming chat against the real mock server
// ---------------------------------------------------------------------------

describe("m1 wiring: streaming chat", () => {
  it("SSE deltas from the mock server re-emit as Token chunks in order, ending with Done", async () => {
    const mock = await scriptedMock(() => "Hello there, this is the mock endpoint.")
    try {
      const provider = makeProvider(mock.url)
      const chunks = await collectChat(buildStack(tmpRoot(), { streamProviders: [provider] }), provider, "s1", "hi")
      const deltas = tokenDeltas(chunks)
      expect(deltas.length).toBeGreaterThan(1)
      expect(deltas.join("")).toBe("Hello there, this is the mock endpoint.")
      const report = doneReport(chunks)
      expect(report.text).toBe("Hello there, this is the mock endpoint.")
      expect(report.executed).toEqual([])
      expect(report.blocked).toEqual([])
    } finally {
      await mock.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Tool call executes through the hooks
// ---------------------------------------------------------------------------

describe("m1 wiring: tool call through hooks", () => {
  it("clock.now executes through before/afterToolCall; real timestamp result; TurnReport.executed.length === 1", async () => {
    const seen: Array<string> = []
    const impls: ReadonlyArray<ModuleHookImpls> = [
      {
        module: "agent-loop",
        beforeToolCall: (call) =>
          Effect.sync(() => {
            seen.push(`before:${call.tool}`)
            return Allow
          }),
        afterToolCall: (call, outcome) =>
          Effect.sync(() => {
            seen.push(`after:${call.tool}:${outcome._tag}`)
            return outcome
          })
      }
    ]
    let calls = 0
    const mock = await scriptedMock(() => {
      calls++
      return calls === 1 ? `Checking the time:\n${toolBlock("clock.now")}\nDone.` : "It is noon."
    })
    try {
      const provider = makeProvider(mock.url)
      const chunks = await collectChat(
        buildStack(tmpRoot(), { impls, streamProviders: [provider] }),
        provider,
        "s1",
        "what time is it"
      )

      // The recording hook observed the full gate lifecycle around the call.
      expect(seen).toEqual(["before:clock.now", "after:clock.now:Ok"])

      const toolChunks = chunks.filter((c) => c._tag === "ToolCall")
      expect(toolChunks.length).toBe(1)
      const tc = toolChunks[0]!
      if (tc._tag !== "ToolCall") throw new Error("unreachable")
      expect(tc.tool).toBe("clock.now")
      expect(typeof tc.result).toBe("string")
      expect(isoTs.test(tc.result as string)).toBe(true) // real timestamp, not a stub

      const report = doneReport(chunks)
      expect(report.executed.length).toBe(1)
      expect(report.executed[0]!.tool).toBe("clock.now")
      expect(report.blocked).toEqual([])
    } finally {
      await mock.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Network killed mid-turn
// ---------------------------------------------------------------------------

describe("m1 wiring: mid-turn network kill", () => {
  it("the chat stream fails with a typed InferenceError — no hang, no raw exception", async () => {
    const mock = await scriptedMock(() => "partial response that never finishes...", { killMidStream: true })
    try {
      const provider = makeProvider(mock.url)
      const stack = buildStack(tmpRoot(), { streamProviders: [provider] })
      const program = Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(provider)
        const loop = yield* AgentLoop
        return yield* Effect.flip(Stream.runCollect(loop.chat("s1", "hi")))
      })
      // The 10s timeout guard turns a hang into a TimeoutException failure —
      // a hang cannot pass silently.
      const err = await Effect.runPromise(
        Effect.provide(program.pipe(Effect.timeout(Duration.seconds(10))), stack)
      )
      expect(err).toBeInstanceOf(InferenceError)
      expect(err._tag).toBe("InferenceError")
      expect((err as InferenceError).provider).toBe("m1-http")
    } finally {
      await mock.close()
    }
  }, 15000)
})

// ---------------------------------------------------------------------------
// 5. Memory persistence across turns through the full stack
// ---------------------------------------------------------------------------

describe("m1 wiring: memory across turns", () => {
  it("the second chat sees the first turn's history (session tree + request the loop sent)", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const replies = ["first-reply", "second-reply"]
    let n = 0
    const mock = await scriptedMock(
      () => {
        const reply = replies[n] ?? "extra-reply"
        n += 1
        return reply
      },
      { bodies }
    )
    try {
      const provider = makeProvider(mock.url)
      const dir = tmpRoot()
      const stack = buildStack(dir, { streamProviders: [provider] })
      const program = Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(provider)
        const loop = yield* AgentLoop
        const first = [...(yield* Stream.runCollect(loop.chat("s1", "hello")))]
        const second = [...(yield* Stream.runCollect(loop.chat("s1", "again")))]
        const mem = yield* MemoryService
        const tree = yield* mem.read("s1")
        return { first, second, tree }
      })
      const { first, second, tree } = await Effect.runPromise(Effect.provide(program, stack))

      expect(doneReport(first).text).toBe("first-reply")
      expect(doneReport(second).text).toBe("second-reply")

      // The session tree holds both turns: message/message/message/message.
      expect(tree.entries.map((e) => e.kind)).toEqual(["message", "message", "message", "message"])
      const texts = tree.entries.map((e) => (e.payload as { text: string }).text)
      expect(texts).toEqual(["hello", "first-reply", "again", "second-reply"])

      // And the loop actually fed the first turn's history into the second request.
      expect(bodies.length).toBe(2)
      const secondBody = bodies[1]!
      const messages = secondBody["messages"] as Array<{ role: string; content: string }>
      expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
      expect(messages[1]!.content).toBe("hello")
      expect(messages[2]!.content).toBe("first-reply")
      expect(messages[3]!.content).toBe("again")
    } finally {
      await mock.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. DEMO.md — real transcript from a live run of the wired stack
// ---------------------------------------------------------------------------

const demoPath = (): string =>
  fileURLToPath(new URL("./agent-loop/DEMO.md", import.meta.url))

const formatChunks = (chunks: ReadonlyArray<ChatChunk>): string =>
  chunks
    .map((c) => {
      switch (c._tag) {
        case "Token":
          return `  Token  ${JSON.stringify(c.delta)}`
        case "ToolCall":
          return `  ToolCall  tool=${c.tool} result=${JSON.stringify(c.result)}`
        case "Done":
          return `  Done  text=${JSON.stringify(c.report.text)}\n` +
            `          executed=${c.report.executed.length} blocked=${c.report.blocked.length}` +
            ` parseFailures=${c.report.parseFailures.length} terminated=${c.report.terminated}`
      }
    })
    .join("\n")

describe("m1 wiring: demo", () => {
  it("writes agent-loop/DEMO.md with a real transcript proving all three M1 demo beats", async () => {
    const seen: Array<string> = []
    const impls: ReadonlyArray<ModuleHookImpls> = [
      {
        module: "agent-loop",
        beforeToolCall: (call) =>
          Effect.sync(() => {
            seen.push(`before:${call.tool}`)
            return Allow
          }),
        afterToolCall: (call, outcome) =>
          Effect.sync(() => {
            seen.push(`after:${call.tool}:${outcome._tag}`)
            return outcome
          })
      }
    ]
    const dir = tmpRoot()

    // Beat 1 + 2: streaming chat whose reply emits a clock.now tool call.
    // First response carries the tool block; the follow-up synthesis is plain.
    let beatCalls = 0
    const mock = await scriptedMock(() => {
      beatCalls++
      return beatCalls === 1 ? `The current time is:\n${toolBlock("clock.now")}` : "It is noon."
    })
    let beat1: Array<ChatChunk>
    let hookTrace: Array<string>
    let toolResult: unknown
    try {
      const provider = makeProvider(mock.url)
      const stack = buildStack(dir, { impls, streamProviders: [provider] })
      beat1 = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const pool = yield* InferencePool
            yield* pool.register(provider)
            const loop = yield* AgentLoop
            return [...(yield* Stream.runCollect(loop.chat("demo", "what time is it")))]
          }),
          stack
        )
      )
      hookTrace = [...seen]
      const toolChunks = beat1.filter((c) => c._tag === "ToolCall")
      if (toolChunks[0]?._tag !== "ToolCall") throw new Error("demo: expected a ToolCall chunk")
      toolResult = toolChunks[0].result
      // The assertions that make this doc a proof, not a story.
      expect(doneReport(beat1).executed.length).toBe(1)
      expect(hookTrace).toEqual(["before:clock.now", "after:clock.now:Ok"])
      expect(typeof toolResult).toBe("string")
      expect(isoTs.test(toolResult as string)).toBe(true)
    } finally {
      await mock.close()
    }

    // Beat 3: the network dies mid-turn; the typed error surfaces.
    const killer = await scriptedMock(() => "this answer never finishes...", { killMidStream: true })
    let killError: InferenceError
    try {
      const provider = makeProvider(killer.url)
      const stack = buildStack(dir, { impls, streamProviders: [provider] })
      const program = Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(provider)
        const loop = yield* AgentLoop
        return yield* Effect.flip(Stream.runCollect(loop.chat("demo-kill", "are you there")))
      })
      const err = await Effect.runPromise(
        Effect.provide(program.pipe(Effect.timeout(Duration.seconds(10))), stack)
      )
      expect(err).toBeInstanceOf(InferenceError)
      expect(err._tag).toBe("InferenceError")
      killError = err as InferenceError
    } finally {
      await killer.close()
    }

    const md = `# M1 demo — the wired stack, running

Real transcript from an actual run of the production-shape M1 stack, captured
by \`m1-wiring.test.ts\` ("writes agent-loop/DEMO.md…") — nothing here is
hand-transcribed. The stack: real \`SafetyKernel\` →
kernel-backed \`PermissionGate\` → \`MemoryService\` → \`InferencePool\` with
one registered \`LocalHttpProvider\` → \`ModuleHooks\` (real kernel behind the
seam + a recording hook) → \`AgentLoop\`.

> Environment note: the HTTP endpoint below is a \`node:http\` mock
> implementing the OpenAI-ish \`/v1/chat/completions\` wire shape — JSON when
> \`stream: false\`, SSE \`data:\` chunks when \`stream: true\`. It stands in
> for a \`llama.cpp-server\` or Ollama endpoint (no local model server was
> available in this environment). The provider speaks the same wire shape
> both target servers expose, so swapping the mock for
> \`http://127.0.0.1:8080\` (\`llama.cpp-server\`) or
> \`http://127.0.0.1:11434\` (Ollama) is a \`baseUrl\` change only.

## Beat 1 — streaming chat

\`AgentLoop.chat("demo", "what time is it")\` — token deltas streamed live
through the provider's \`stream()\` surface and re-emitted as \`Token\`
chunks in order:

\`\`\`
${formatChunks(beat1)}
\`\`\`

## Beat 2 — tool call executes through the hooks

The model emitted an \`aimy-tool\` fenced block for \`clock.now\`. The hook
gate fired around the execution and the real kernel allowed it (T0):

\`\`\`
hook trace: ${hookTrace.join(" -> ")}
\`\`\`

The \`ToolCall\` chunk above carries the tool's real result — the actual
system clock at run time (\`${toolResult}\`) — and the turn report records
\`executed.length === 1\`, \`blocked === []\`. The loop never executes tools
itself; \`ModuleHooks.runTurn\` owns the gate.

## Beat 3 — network killed mid-turn

The mock server wrote one SSE chunk, then destroyed the socket with no
\`[DONE]\`. The chat stream terminated with the typed error — no hang, no
raw exception:

\`\`\`
${killError._tag} { provider: ${JSON.stringify(killError.provider)}, reason: ${JSON.stringify(killError.reason)} }
\`\`\`

This is the architecture §12 M1 demo contract: streaming chat with a local
model, tool calls executing through hooks, and a mid-turn network kill
surfacing a clean typed error.
`

    fs.writeFileSync(demoPath(), md)
    expect(fs.existsSync(demoPath())).toBe(true)
  }, 30000)
})
