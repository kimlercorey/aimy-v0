/**
 * track1-forks.test.ts — background-review forks (architecture §3.5).
 *
 * - The fork holds an immutable snapshot, never a live reference.
 * - Dispatch whitelist: the worker receives exactly `proposeWrite` +
 *   `readContext` — no arbitrary tool execution.
 * - Structured concurrency: supervised fibers; post-cancel side effects
 *   impossible by construction (cancelled forks record no outcome and
 *   apply no further writes).
 * - Bounded-cancel handshake: `noteLiveTurn` acks in time (Acked), or the
 *   live turn proceeds anyway on timeout (Timeout) — the fork never blocks
 *   the user.
 * - Aux-model routing: the default worker replays a compact digest through
 *   the aux lane, never the full snapshot, never the foreground provider.
 *
 * Timing note: workers perform real file I/O (memory store), so outcome
 * polling is time-based on the live clock, never a fixed yield count.
 * Only the timeout test uses the TestClock (deterministic deadline).
 */
import { describe, expect, it } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { InferencePool, InferencePoolLive, StubProvider } from "../../inference-pool/index.js"
import { MemoryService } from "../../memory/index.js"
import {
  makeAuxDigestWorker,
  ReviewForks,
  ReviewReadError,
  ReviewWorkerError,
  type ReviewForksService,
  type ReviewToolset,
  type ReviewWorker,
  type WorkerResult
} from "../src/forks.js"
import { REVIEW_SYSTEM_PROMPT } from "../src/prompts.js"
import type { ForkOutcome } from "../src/review-types.js"
import { deepFreeze } from "../src/snapshot.js"
import {
  makeBlockingWorker,
  makeProposingWorker,
  makeWhitelistProbeWorker,
  testForksLayer,
  testProvenance,
  testSnapshot
} from "./track1-fixtures.js"

const req = (sessionId: string) => ({
  sessionId,
  snapshot: testSnapshot(sessionId),
  mode: "background" as const,
  provenance: testProvenance(sessionId)
})

const runTest = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff)

/**
 * Poll until the predicate yields Some (or a real-time deadline passes).
 * Time-based: forked workers do real file I/O, so a fixed yield count
 * flakes under load.
 */
const pollSome = <A>(
  get: () => Effect.Effect<Option.Option<A>, never>,
  timeoutMs = 10_000
): Effect.Effect<Option.Option<A>, never> =>
  Effect.gen(function* () {
    const start = Date.now()
    for (;;) {
      const value = yield* get()
      if (Option.isSome(value)) return value
      if (Date.now() - start > timeoutMs) return Option.none()
      yield* Effect.sleep("10 millis")
    }
  })

const awaitOutcome = (
  forks: ReviewForksService,
  sessionId: string
): Effect.Effect<Option.Option<ForkOutcome>, never> =>
  pollSome(() => forks.lastOutcome(sessionId))

const awaitInFlight = (
  forks: ReviewForksService,
  sessionId: string
): Effect.Effect<Option.Option<{ readonly sessionId: string }>, never> =>
  pollSome(() => forks.inFlight(sessionId).pipe(Effect.map(Option.map((h) => ({ sessionId: h.sessionId })))))

const completedOutcome = (
  outcome: Option.Option<ForkOutcome>
): Extract<ForkOutcome, { _tag: "Completed" }> => {
  if (!Option.isSome(outcome)) throw new Error("expected an outcome to be recorded")
  const value = outcome.value
  expect(value._tag).toBe("Completed")
  if (value._tag !== "Completed") throw new Error("expected a Completed outcome")
  return value
}

describe("dispatch whitelist", () => {
  it("the worker receives exactly proposeWrite + readContext", async () => {
    const seen: { toolset?: object } = {}
    const layer = testForksLayer(makeWhitelistProbeWorker(seen))
    await runTest(
      Effect.gen(function* () {
        const forks = yield* ReviewForks
        yield* forks.spawnReview(req("s-1"))
        for (let i = 0; i < 500 && seen.toolset === undefined; i++) {
          yield* Effect.sleep("10 millis")
        }
        expect(Object.keys(seen.toolset ?? {}).sort()).toEqual(["proposeWrite", "readContext"])
      }).pipe(Effect.provide(layer))
    )
  })

  it("readContext serves namespaced reads, read-only", async () => {
    const seen: { toolset?: ReviewToolset } = {}
    const layer = testForksLayer(makeWhitelistProbeWorker(seen))
    await runTest(
      Effect.gen(function* () {
        const memory = yield* MemoryService
        yield* memory.set("profile", "greeting", "hello")
        const forks = yield* ReviewForks
        yield* forks.spawnReview(req("s-1"))
        for (let i = 0; i < 500 && seen.toolset === undefined; i++) {
          yield* Effect.sleep("10 millis")
        }
        const toolset = seen.toolset!
        expect(yield* toolset.readContext("profile:greeting")).toContain("hello")
        expect(yield* toolset.readContext("profile:missing")).toContain("not set")
        const bad = yield* Effect.flip(toolset.readContext("bogus"))
        expect(bad).toBeInstanceOf(ReviewReadError)
        const badNs = yield* Effect.flip(toolset.readContext("diary:k"))
        expect(badNs).toBeInstanceOf(ReviewReadError)
      }).pipe(Effect.provide(layer))
    )
  })
})

describe("spawn and outcome", () => {
  it("a proposed add is applied with the request's provenance attached", async () => {
    const layer = testForksLayer(
      makeProposingWorker([{ kind: "add", namespace: "profile", key: "tea", value: true, reason: "user likes tea" }])
    )
    await runTest(
      Effect.gen(function* () {
        const forks = yield* ReviewForks
        const memory = yield* MemoryService
        yield* forks.spawnReview(req("s-1"))
        const outcome = completedOutcome(yield* awaitOutcome(forks, "s-1"))
        expect(outcome.proposals).toHaveLength(1)
        expect(outcome.proposals[0]!.provenance).toEqual(testProvenance("s-1"))
        expect(outcome.dispositions[0]!._tag).toBe("Applied")
        expect(yield* memory.get("profile", "tea")).toBe(true)
        // Completed forks drop their own handle.
        expect(yield* forks.inFlight("s-1")).toEqual(Option.none())
      }).pipe(Effect.provide(layer))
    )
  })

  it("a worker failure is recorded, never thrown", async () => {
    const worker: ReviewWorker = () => Effect.fail(new ReviewWorkerError({ reason: "boom" }))
    const layer = testForksLayer(worker)
    await runTest(
      Effect.gen(function* () {
        const forks = yield* ReviewForks
        yield* forks.spawnReview(req("s-1"))
        const outcome = yield* awaitOutcome(forks, "s-1")
        if (!Option.isSome(outcome)) throw new Error("expected an outcome to be recorded")
        const value = outcome.value
        expect(value._tag).toBe("WorkerFailed")
        if (value._tag === "WorkerFailed") expect(value.reason).toContain("boom")
      }).pipe(Effect.provide(layer))
    )
  })

  it("newest-wins: a second spawn retires the in-flight review", async () => {
    const latchA = await runTest(Deferred.make<void>())
    const rawA = { kind: "add" as const, namespace: "profile" as const, key: "keyA", value: 1, reason: "a" }
    const rawB = { kind: "add" as const, namespace: "profile" as const, key: "keyB", value: 2, reason: "b" }
    const worker: ReviewWorker = (snapshot, toolset) => {
      const blocked = snapshot.turns[0]?.text === "BLOCK"
      return (blocked ? makeBlockingWorker(latchA, [rawA]) : makeProposingWorker([rawB]))(snapshot, toolset)
    }
    const layer = testForksLayer(worker)
    await runTest(
      Effect.gen(function* () {
        const forks = yield* ReviewForks
        const memory = yield* MemoryService
        const blockedSnap = deepFreeze({
          ...testSnapshot("s-1"),
          turns: [{ role: "user" as const, text: "BLOCK", toolCalls: [] }]
        })
        yield* forks.spawnReview({ ...req("s-1"), snapshot: blockedSnap })
        const first = yield* awaitInFlight(forks, "s-1")
        expect(Option.isSome(first)).toBe(true)
        // Second spawn retires the first (bounded handshake runs in the background).
        yield* forks.spawnReview(req("s-1"))
        const outcome = completedOutcome(yield* awaitOutcome(forks, "s-1"))
        expect(outcome.proposals[0]!.key).toBe("keyB")
        // Releasing A's latch now must not apply A's write: A is dead.
        yield* Deferred.succeed(latchA, undefined)
        yield* Effect.sleep("50 millis")
        expect(yield* memory.get("profile", "keyA")).toBeUndefined()
        expect(yield* memory.get("profile", "keyB")).toBe(2)
      }).pipe(Effect.provide(layer))
    )
  })
})

describe("bounded-cancel handshake", () => {
  it("a live turn cancels the review: Acked, no post-cancel writes, no outcome", async () => {
    const latch = await runTest(Deferred.make<void>())
    const raw = { kind: "add" as const, namespace: "profile" as const, key: "k", value: 1, reason: "r" }
    const layer = testForksLayer(makeBlockingWorker(latch, [raw]))
    await runTest(
      Effect.gen(function* () {
        const forks = yield* ReviewForks
        const memory = yield* MemoryService
        yield* forks.spawnReview(req("s-1"))
        // Let the fork start and block inside the worker.
        expect(Option.isSome(yield* awaitInFlight(forks, "s-1"))).toBe(true)
        yield* Effect.sleep("50 millis")
        const ack = yield* forks.noteLiveTurn("s-1")
        expect(ack._tag).toBe("Acked")
        // The write the worker WOULD have applied never happens.
        yield* Deferred.succeed(latch, undefined)
        yield* Effect.sleep("50 millis")
        expect(yield* memory.get("profile", "k")).toBeUndefined()
        // Cancelled forks record no outcome and hold no handle.
        expect(yield* forks.lastOutcome("s-1")).toEqual(Option.none())
        expect(yield* forks.inFlight("s-1")).toEqual(Option.none())
        // A second live turn finds nothing to cancel.
        expect((yield* forks.noteLiveTurn("s-1"))._tag).toBe("NoReview")
      }).pipe(Effect.provide(layer))
    )
  })

  effectIt("the live turn proceeds on timeout when the fork never acknowledges", () =>
    Effect.gen(function* () {
      // A worker that ignores interruption: uninterruptible sleep.
      const worker: ReviewWorker = () =>
        Effect.as(
          Effect.uninterruptible(Effect.sleep("10 seconds")),
          { proposals: [], dispositions: [] } satisfies WorkerResult
        )
      const layer = testForksLayer(worker, { ackDeadlineMs: 100 })
      yield* Effect.gen(function* () {
        const forks = yield* ReviewForks
        yield* forks.spawnReview(req("s-1"))
        for (let i = 0; i < 200; i++) {
          if (Option.isSome(yield* forks.inFlight("s-1"))) break
          yield* Effect.yieldNow
        }
        // noteLiveTurn blocks on the TestClock deadline: run it in a fiber.
        const ackFiber = yield* Effect.forkScoped(forks.noteLiveTurn("s-1"))
        yield* Effect.yieldNow
        yield* TestClock.adjust("200 millis")
        const ack = yield* Fiber.join(ackFiber)
        // The live turn was NOT blocked: it proceeded on timeout.
        expect(ack._tag).toBe("Timeout")
        expect(yield* forks.inFlight("s-1")).toEqual(Option.none())
        expect(yield* forks.lastOutcome("s-1")).toEqual(Option.none())
        // Let the stuck fork's sleep elapse so it terminates and the layer
        // scope closes cleanly. The interrupt was already sent: it still
        // dies, and records nothing.
        yield* TestClock.adjust("10 seconds")
        yield* Effect.yieldNow
        expect(yield* forks.lastOutcome("s-1")).toEqual(Option.none())
      }).pipe(Effect.provide(layer))
    })
  )
})

describe("aux-model routing", () => {
  it("the default worker replays a compact digest on the aux lane only", async () => {
    const built = await runTest(
      Effect.gen(function* () {
        const pool = yield* InferencePool
        const main = new StubProvider("main")
        const aux = new StubProvider(
          "aux",
          '{"kind":"add","namespace":"profile","key":"k","value":1,"reason":"r"}'
        )
        yield* pool.register(main)
        yield* pool.register(aux)
        yield* pool.setAuxProvider("aux")
        return { pool, main, aux }
      }).pipe(Effect.provide(InferencePoolLive))
    )

    const dispositions: Array<{ _tag: string; key: string }> = []
    const toolset: ReviewToolset = {
      proposeWrite: (raw) =>
        Effect.gen(function* () {
          dispositions.push({ _tag: "Applied", key: raw.key })
          return { _tag: "Applied", namespace: raw.namespace, key: raw.key } as const
        }),
      readContext: () => Effect.succeed("none")
    }
    const worker = makeAuxDigestWorker(built.pool, 300)
    const bigText = "x".repeat(20_000)
    const snapshot = deepFreeze({
      sessionId: "s-aux",
      capturedAt: "2026-10-07T06:30:00.000Z",
      turns: [
        { role: "user" as const, text: bigText, toolCalls: [] },
        { role: "assistant" as const, text: bigText, toolCalls: [] }
      ]
    })
    const result = await runTest(worker(snapshot, toolset))

    // Aux lane hit exactly once; the foreground provider never touched.
    expect(built.main.calls).toHaveLength(0)
    expect(built.aux.calls).toHaveLength(1)
    const sent = built.aux.calls[0]!.request.messages
    expect(sent[0]!.content).toBe(REVIEW_SYSTEM_PROMPT)
    const body = sent.map((m) => m.content).join("\n")
    expect(body).toContain("[review digest")
    expect(body).toContain("[digest truncated at 300 chars]")
    // The full snapshot was NOT replayed: compact digest, not the 40k chars.
    expect(body.length).toBeLessThan(20_000)
    expect(body).not.toContain("x".repeat(20_000))
    // Proposals parsed and proposed through the toolset.
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]!.key).toBe("k")
    expect(dispositions).toEqual([{ _tag: "Applied", key: "k" }])
  })
})
