/**
 * loop.test.ts — AgentLoop, tested against StubProvider only (no network).
 *
 * The REAL SafetyKernel wires behind ModuleHooks' SafetyKernelSeam
 * (via SafetyKernel.layerFromPolicy) and behind MemoryService's
 * PermissionGate — the trust-boundary composition from integration.test.ts,
 * extended to the loop. No fake gates anywhere in this file.
 *
 * Stack builders live in ./fixtures.ts (shared with the M3 honesty wiring
 * tests and the honesty demo).
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  InferenceError,
  InferencePool,
  StubProvider,
  type GenerateRequest,
  type Token
} from "../../inference-pool/index.js"
import { MemoryService } from "../../memory/index.js"
import { Allow, HookError, type ModuleHookImpls } from "../../module-seam/src/index.js"
import { AgentLoop } from "../src/index.js"
import {
  buildStack,
  collectChat,
  denySessionInfoPolicy,
  doneReport,
  tmpRoot,
  tokenDeltas,
  toolBlock
} from "./fixtures.js"

/** Provider with a real `stream` method (StubProvider has none). */
class StreamingStub extends StubProvider {
  readonly stream = (_request: GenerateRequest): Stream.Stream<Token, InferenceError> =>
    Stream.fromIterable([{ delta: "The " }, { delta: "time " }, { delta: "is now." }])
}

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
