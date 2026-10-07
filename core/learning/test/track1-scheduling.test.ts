/**
 * track1-scheduling.test.ts — idle-gated review scheduling (architecture §3.5).
 *
 * - The queue waits for idle: no review runs while the machine is busy.
 * - One slot per session with newest-snapshot-wins coalescing.
 * - Entries older than maxAge are dropped, never run stale.
 * - Explicit user-invoked refinement never defers and never waits for idle.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
  FakeIdleSignalLive,
  layerReviewScheduler,
  ReviewScheduler,
  type ReviewSchedulerService
} from "../src/scheduling.js"
import {
  makeProposingWorker,
  testForksLayer,
  testProvenance,
  testSnapshot
} from "./track1-fixtures.js"

const req = (sessionId: string, text = "hello") => ({
  sessionId,
  snapshot: { ...testSnapshot(sessionId), turns: [{ role: "user" as const, text, toolCalls: [] }] },
  mode: "background" as const,
  provenance: testProvenance(sessionId)
})

/** Scheduler layer with a recording worker and a controllable idle signal. */
const schedulerLayer = (spawned: Array<string>, idle: boolean) => {
  const forks = testForksLayer(makeProposingWorker([], spawned))
  return Layer.provide(layerReviewScheduler(), Layer.mergeAll(forks, FakeIdleSignalLive(idle)))
}

/** Run drain (which waits on the TestClock) and return its report. */
const runDrain = (sched: ReviewSchedulerService) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(sched.drain())
    yield* Effect.yieldNow
    // Generous: each queued entry waits out a 15s settle window.
    yield* TestClock.adjust("5 minutes")
    return yield* Fiber.join(fiber)
  })

describe("ReviewScheduler", () => {
  it.effect("coalesces: one slot per session, newest snapshot wins", () =>
    Effect.gen(function* () {
      const spawned: Array<string> = []
      const layer = schedulerLayer(spawned, true)
      yield* Effect.gen(function* () {
        const sched = yield* ReviewScheduler
        yield* sched.enqueue(req("s-1", "first"))
        yield* sched.enqueue(req("s-1", "second"))
        yield* sched.enqueue(req("s-2", "other"))
        const pending = yield* sched.pending()
        expect(pending).toHaveLength(2)
        const s1 = pending.find((p) => p.sessionId === "s-1")!
        expect(s1.snapshot.turns[0]!.text).toBe("second")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("drain waits for idle, then spawns every queued review", () =>
    Effect.gen(function* () {
      const spawned: Array<string> = []
      const layer = schedulerLayer(spawned, true)
      yield* Effect.gen(function* () {
        const sched = yield* ReviewScheduler
        yield* sched.enqueue(req("s-1"))
        yield* sched.enqueue(req("s-2"))
        const report = yield* runDrain(sched)
        expect(report).toEqual({ processed: 2, droppedStale: 0, remaining: 0 })
        // The worker ran for both sessions (background mode).
        for (let i = 0; i < 200 && spawned.length < 2; i++) yield* Effect.yieldNow
        expect(spawned.sort()).toEqual(["s-1", "s-2"])
        expect(yield* sched.pending()).toEqual([])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("drain drops entries older than maxAge instead of running them stale", () =>
    Effect.gen(function* () {
      const spawned: Array<string> = []
      const layer = schedulerLayer(spawned, true)
      yield* Effect.gen(function* () {
        const sched = yield* ReviewScheduler
        yield* sched.enqueue(req("s-old"))
        // Past the 30-minute max age.
        yield* TestClock.adjust("31 minutes")
        yield* sched.enqueue(req("s-fresh"))
        const report = yield* runDrain(sched)
        expect(report).toEqual({ processed: 1, droppedStale: 1, remaining: 0 })
        for (let i = 0; i < 200 && spawned.length < 1; i++) yield* Effect.yieldNow
        expect(spawned).toEqual(["s-fresh"])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("explicit refinement never defers: spawns immediately even when busy", () =>
    Effect.gen(function* () {
      const spawned: Array<string> = []
      // Never idle: the queue would wait forever.
      const layer = schedulerLayer(spawned, false)
      yield* Effect.gen(function* () {
        const sched = yield* ReviewScheduler
        yield* sched.enqueue(req("s-queued"))
        // Drain stalls on idle: fork it, observe nothing spawns, kill it.
        const drainFiber = yield* Effect.forkScoped(sched.drain())
        yield* TestClock.adjust("500 millis")
        yield* Effect.yieldNow
        expect(spawned).toEqual([])
        yield* Fiber.interrupt(drainFiber)
        // Explicit refinement does not wait: it spawns now.
        yield* sched.refineNow({ ...req("s-explicit"), mode: "user-invoked" })
        for (let i = 0; i < 200 && spawned.length < 1; i++) yield* Effect.yieldNow
        expect(spawned).toEqual(["s-explicit"])
        // The queued entry is still waiting — it was never stolen.
        expect((yield* sched.pending()).map((p) => p.sessionId)).toEqual(["s-queued"])
      }).pipe(Effect.provide(layer))
    })
  )
})
