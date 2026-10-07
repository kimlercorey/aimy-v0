/**
 * loop.test.ts — AgentLoop, tested against StubProvider only (no network).
 *
 * The REAL SafetyKernel wires behind ModuleHooks' SafetyKernelSeam
 * (via SafetyKernel.layerFromPolicy) and behind MemoryService's
 * PermissionGate — the trust-boundary composition from integration.test.ts,
 * extended to the loop. No fake gates anywhere in this file.
 */
import { Effect, Layer, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  InferenceError,
  InferencePool,
  InferencePoolLive,
  StubProvider,
  type GenerateRequest,
  type Provider,
  type Token
} from "../../inference-pool/index.js"
import {
  MemoryDirs,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
  PermissionGate
} from "../../memory/index.js"
import {
  Allow,
  Deny,
  HookError,
  ModuleHooks,
  makeModuleHooks,
  type GateVerdict,
  type ModuleHookImpls,
  type SafetyKernelSeam
} from "../../module-seam/src/index.js"
import {
  PolicyDocument,
  SafetyKernel,
  type SafetyKernelService
} from "../../permission-kernel/index.js"
import { PermissionDenied } from "../../substrate/errors.js"
import { ToolName } from "../../substrate/types.js"
import {
  AgentLoop,
  layerAgentLoop,
  type ChatChunk,
  type TurnReport
} from "../src/index.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "aimy-loop-test-"))

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
            provenance: "agent-loop-test/memory-gate"
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
 * `SafetyKernelSeam`. Deny becomes a `Deny` verdict (no terminate — the real
 * kernel has no terminate semantics); ask fails closed headless.
 */
const seamFromKernel = (kernel: SafetyKernelService): SafetyKernelSeam => {
  const toKernelIntent = (intent: { tool: string; tier: "T0" | "T1" | "T2" | "T3"; module: string }) => ({
    tool: ToolName(intent.tool),
    tier: intent.tier,
    // The seam carries no args, so the kernel's arg-fingerprint cannot see
    // them. Synthesize the intent identity from what the seam does carry —
    // denial then kills exactly this (module, tool, tier) intent. Limitation:
    // the kernel's rename-the-tool bypass protection is degraded at this
    // seam, because two tools with identical synthesized args share a
    // fingerprint only when they also share the tool name.
    args: { module: intent.module, tool: intent.tool, tier: intent.tier },
    provenance: `agent-loop:${intent.module}`
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
          Effect.succeed<GateVerdict>(Deny(denied.reason, false))
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
    { tool: "*", tier: "T0", decision: "allow", reason: "test: T0 reads and tools" },
    { tool: "*", tier: "T1", decision: "allow", reason: "test: memory writes" },
    { tool: "*", tier: "T2", decision: "deny", reason: "test default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "test default" }
  ]
}

const denySessionInfoPolicy: PolicyDocument = {
  version: 1,
  rules: [
    { tool: "session.info", tier: "T0", decision: "deny", reason: "test: session.info denied" },
    { tool: "*", tier: "T0", decision: "allow", reason: "test: other T0 tools" },
    { tool: "*", tier: "T1", decision: "allow", reason: "test: memory writes" },
    { tool: "*", tier: "T2", decision: "deny", reason: "test default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "test default" }
  ]
}

interface StackOpts {
  readonly policy?: PolicyDocument
  readonly impls?: ReadonlyArray<ModuleHookImpls>
  readonly streamProviders?: ReadonlyArray<Provider>
}

const buildStack = (dir: string, opts: StackOpts = {}): Layer.Layer<AgentLoop | InferencePool | MemoryService> => {
  const kernelLayer = SafetyKernel.layerFromPolicy(opts.policy ?? openPolicy)
  const memoryStack = Layer.provide(
    Layer.provide(MemoryServiceLive, Layer.mergeAll(kernelBackedGate, pathsLayer(dir))),
    kernelLayer
  )
  const hooksStack = Layer.provide(hooksLayer(opts.impls ?? []), kernelLayer)
  const base = Layer.mergeAll(InferencePoolLive, hooksStack, memoryStack)
  const loopOnly = Layer.provide(layerAgentLoop({ streamProviders: opts.streamProviders ?? [] }), base)
  // Test programs register the stub through the pool and assert on memory
  // directly, so both stay visible alongside the loop (same layer instances:
  // one build, memoized by identity).
  return Layer.mergeAll(loopOnly, InferencePoolLive, memoryStack)
}

/** Register the stub, run one chat, collect every chunk. */
const collectChat = (
  stack: Layer.Layer<AgentLoop | InferencePool | MemoryService>,
  stub: StubProvider,
  sessionId: string,
  input: string
): Promise<Array<ChatChunk>> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        yield* pool.register(stub)
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

/** Provider with a real `stream` method (StubProvider has none). */
class StreamingStub extends StubProvider {
  readonly stream = (_request: GenerateRequest): Stream.Stream<Token, InferenceError> =>
    Stream.fromIterable([{ delta: "The " }, { delta: "time " }, { delta: "is now." }])
}

const toolBlock = (tool: string, args: unknown = {}): string =>
  "```aimy-tool\n" + JSON.stringify({ tool, args }) + "\n```"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentLoop streaming", () => {
  it("re-emits provider stream deltas as Token chunks in order, then Done", async () => {
    const stub = new StreamingStub("stream-stub")
    const chunks = await collectChat(buildStack(tmpRoot(), { streamProviders: [stub] }), stub, "s1", "hi")
    expect(tokenDeltas(chunks)).toEqual(["The ", "time ", "is now."])
    const report = doneReport(chunks)
    expect(report.text).toBe("The time is now.")
    expect(report.executed).toEqual([])
    expect(report.blocked).toEqual([])
  })

  it("non-streaming provider emits the full text as one Token chunk", async () => {
    const stub = new StubProvider("plain", "hello world")
    const chunks = await collectChat(buildStack(tmpRoot()), stub, "s1", "hi")
    expect(tokenDeltas(chunks)).toEqual(["hello world"])
    expect(doneReport(chunks).text).toBe("hello world")
  })
})

describe("AgentLoop tool calls", () => {
  it("parses one aimy-tool block and executes it through before/afterToolCall hooks", async () => {
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
    const stub = new StubProvider("tools", `The time:\n${toolBlock("clock.now")}\ndone.`)
    const chunks = await collectChat(buildStack(tmpRoot(), { impls }), stub, "s1", "what time is it")

    // The recording hook observed the full gate lifecycle around the call.
    expect(seen).toEqual(["before:clock.now", "after:clock.now:Ok"])

    const toolChunks = chunks.filter((c) => c._tag === "ToolCall")
    expect(toolChunks.length).toBe(1)
    const tc = toolChunks[0]!
    if (tc._tag !== "ToolCall") throw new Error("unreachable")
    expect(tc.tool).toBe("clock.now")
    expect(typeof tc.result).toBe("string") // ISO timestamp

    const report = doneReport(chunks)
    expect(report.executed.length).toBe(1)
    expect(report.executed[0]!.tool).toBe("clock.now")
    expect(report.blocked).toEqual([])
  })

  it("executes multiple tool blocks in order", async () => {
    const stub = new StubProvider(
      "multi",
      `${toolBlock("clock.now")}\n${toolBlock("session.info")}`
    )
    const chunks = await collectChat(buildStack(tmpRoot()), stub, "s1", "both")
    const report = doneReport(chunks)
    expect(report.executed.map((e) => e.tool)).toEqual(["clock.now", "session.info"])
    const toolChunks = chunks.filter((c) => c._tag === "ToolCall")
    expect(toolChunks.length).toBe(2)
  })

  it("malformed JSON in a block surfaces as a typed parse failure; the turn completes", async () => {
    const stub = new StubProvider("bad-json", "oops:\n```aimy-tool\n{not json}\n```")
    const chunks = await collectChat(buildStack(tmpRoot()), stub, "s1", "hi")
    const report = doneReport(chunks) // stream did not fail
    expect(report.parseFailures.length).toBe(1)
    expect(report.parseFailures[0]!.reason).toContain("malformed JSON")
    expect(report.executed).toEqual([])
    expect(chunks.filter((c) => c._tag === "ToolCall")).toEqual([])
  })

  it("malformed block does not stop valid blocks from executing", async () => {
    const stub = new StubProvider(
      "mixed",
      "```aimy-tool\n{broken}\n```\n" + toolBlock("clock.now")
    )
    const chunks = await collectChat(buildStack(tmpRoot()), stub, "s1", "hi")
    const report = doneReport(chunks)
    expect(report.parseFailures.length).toBe(1)
    expect(report.executed.length).toBe(1)
    expect(report.executed[0]!.tool).toBe("clock.now")
  })

  it("unknown tool becomes an IoError outcome, never a crash", async () => {
    const stub = new StubProvider("unknown", toolBlock("nope.nope"))
    const chunks = await collectChat(buildStack(tmpRoot()), stub, "s1", "hi")
    const report = doneReport(chunks)
    expect(report.executed.length).toBe(1)
    const result = report.executed[0]!.result as { _tag: string; reason: string }
    expect(result._tag).toBe("IoError")
    expect(result.reason).toContain("unknown built-in tool")
  })

  it("persists tool-call and tool-result entries in the session", async () => {
    const dir = tmpRoot()
    const stub = new StubProvider("persist-tools", toolBlock("clock.now"))
    const program = Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(stub)
      const loop = yield* AgentLoop
      const chunks = [...(yield* Stream.runCollect(loop.chat("s1", "time please")))]
      const mem = yield* MemoryService
      const tree = yield* mem.read("s1")
      return { chunks, kinds: tree.entries.map((e) => e.kind) }
    })
    const { chunks, kinds } = await Effect.runPromise(Effect.provide(program, buildStack(dir)))
    expect(doneReport(chunks).executed.length).toBe(1)
    expect(kinds).toEqual(["message", "message", "tool-call", "tool-result"])
  })
})

describe("AgentLoop permission gating", () => {
  it("denied tool: intent killed, reported in TurnReport.blocked, loop does not crash", async () => {
    const dir = tmpRoot()
    const stub = new StubProvider("denied", `info:\n${toolBlock("session.info")}`)
    const program = Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(stub)
      const loop = yield* AgentLoop
      // Two turns in one scope: the kernel's denied-intent registry is live
      // for both, so the second identical call is denied again.
      const first = [...(yield* Stream.runCollect(loop.chat("s1", "session?")))]
      const second = [...(yield* Stream.runCollect(loop.chat("s1", "session?")))]
      return { first, second }
    })
    const { first, second } = await Effect.runPromise(
      Effect.provide(program, buildStack(dir, { policy: denySessionInfoPolicy }))
    )
    for (const chunks of [first, second]) {
      const report = doneReport(chunks) // completed, not crashed
      expect(report.executed).toEqual([])
      expect(report.blocked.length).toBe(1)
      expect(report.blocked[0]!.tool).toBe("session.info")
      expect(report.blocked[0]!.reason).toContain("denied")
      expect(chunks.filter((c) => c._tag === "ToolCall")).toEqual([])
    }
  })

  it("session.info reports the session id and completed turn count", async () => {
    const dir = tmpRoot()
    const stub = new StubProvider("info", toolBlock("session.info"))
    const program = Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(stub)
      const loop = yield* AgentLoop
      const first = [...(yield* Stream.runCollect(loop.chat("s9", "info")))]
      const second = [...(yield* Stream.runCollect(loop.chat("s9", "info")))]
      return { first, second }
    })
    const { first, second } = await Effect.runPromise(Effect.provide(program, buildStack(dir)))
    const r1 = doneReport(first).executed[0]!.result as { sessionId: string; turnCount: number }
    const r2 = doneReport(second).executed[0]!.result as { sessionId: string; turnCount: number }
    expect(r1).toEqual({ sessionId: "s9", turnCount: 0 })
    expect(r2).toEqual({ sessionId: "s9", turnCount: 1 })
  })
})

describe("AgentLoop memory", () => {
  it("second chat sees the first turn's history", async () => {
    const dir = tmpRoot()
    const stub = new StubProvider("mem", "ack")
    const program = Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(stub)
      const loop = yield* AgentLoop
      yield* Stream.runCollect(loop.chat("s1", "hello"))
      yield* Stream.runCollect(loop.chat("s1", "again"))
    })
    await Effect.runPromise(Effect.provide(program, buildStack(dir)))
    expect(stub.calls.length).toBe(2)
    const second = stub.calls[1]!.request.messages
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(second[1]!.content).toBe("hello")
    expect(second[2]!.content).toBe("ack")
    expect(second[3]!.content).toBe("again")
  })
})

describe("AgentLoop failure modes", () => {
  it("provider failure surfaces a typed InferenceError; no hang", async () => {
    const dir = tmpRoot()
    const stub = new StubProvider("flaky", "never seen")
    stub.failNextWith("boom")
    const program = Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(stub)
      const loop = yield* AgentLoop
      return yield* Effect.flip(Stream.runCollect(loop.chat("s1", "hi")))
    })
    const err = await Effect.runPromise(Effect.provide(program, buildStack(dir)))
    expect(err).toBeInstanceOf(InferenceError)
    expect((err as InferenceError).provider).toBe("flaky")
    expect((err as InferenceError).reason).toBe("boom")
  })

  it("hook defects become typed HookError at the boundary, not crashes", async () => {
    const impls: ReadonlyArray<ModuleHookImpls> = [
      {
        module: "agent-loop",
        beforeToolCall: () => Effect.die(new Error("impl exploded"))
      }
    ]
    const stub = new StubProvider("defect", toolBlock("clock.now"))
    const program = Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(stub)
      const loop = yield* AgentLoop
      return yield* Effect.flip(Stream.runCollect(loop.chat("s1", "hi")))
    })
    const err = await Effect.runPromise(
      Effect.provide(program, buildStack(tmpRoot(), { impls }))
    )
    expect(err).toBeInstanceOf(HookError)
  })
})
