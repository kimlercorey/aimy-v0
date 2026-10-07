/**
 * jobs/test/helpers.ts — shared test scaffolding (not a test file).
 *
 * `withRunner` builds a JobRunner over an in-memory run history and a
 * collecting alert sink, inside the test's own scope — so layer teardown
 * (and supervision-scope cancellation) happens at test end. Time-based
 * tests run under @effect/vitest's `it.effect`, which provides the
 * TestClock; `TestClock.adjust` drives the scheduler loop.
 */
import { Effect, Layer, Ref } from "effect"

import { collectingAlertSink, JobRunner, JobRunnerLive } from "../src/runner.js"
import type { JobRunnerService } from "../src/runner.js"
import type { JobAlert } from "../src/types.js"
import { InMemoryRunHistory, RunHistory } from "../src/history.js"
import type { RunHistoryService } from "../src/history.js"
import type { JobStoreError } from "../src/errors.js"
import type { RunStatus } from "../src/types.js"

export interface RunnerCtx {
  readonly runner: JobRunnerService
  readonly alerts: Ref.Ref<ReadonlyArray<JobAlert>>
  readonly history: RunHistoryService
}

export const withRunner = <A, E>(
  test: (ctx: RunnerCtx) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const { layer: alertLayer, alerts } = yield* collectingAlertSink()
    // provideMerge (not provide): the test needs AlertSink/RunHistory
    // alongside JobRunner from the same composed layer.
    const layer = Layer.provideMerge(
      JobRunnerLive,
      Layer.mergeAll(alertLayer, InMemoryRunHistory)
    )
    return yield* Effect.gen(function* () {
      const runner = yield* JobRunner
      const history = yield* RunHistory
      return yield* test({ runner, alerts, history })
    }).pipe(Effect.provide(layer))
  })

/** Poll a condition cooperatively; dies loudly (failing the test) on timeout. */
export const eventually = (
  check: Effect.Effect<boolean, JobStoreError>,
  label: string,
  maxSteps = 500
): Effect.Effect<void, JobStoreError> =>
  Effect.gen(function* () {
    for (let i = 0; i < maxSteps; i++) {
      if (yield* check) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error(`eventually timed out: ${label}`))
  })

export const hasStatus = (
  history: RunHistoryService,
  jobId: string,
  status: RunStatus
): Effect.Effect<boolean, JobStoreError> =>
  history.list(jobId).pipe(Effect.map((records) => records.some((r) => r.status === status)))

export const countStatus = (
  history: RunHistoryService,
  jobId: string,
  status: RunStatus
): Effect.Effect<number, JobStoreError> =>
  history.list(jobId).pipe(Effect.map((records) => records.filter((r) => r.status === status).length))

export const alertsOf = (
  alerts: Ref.Ref<ReadonlyArray<JobAlert>>,
  kind: JobAlert["kind"]
): Effect.Effect<ReadonlyArray<JobAlert>> =>
  Effect.map(Ref.get(alerts), (xs) => xs.filter((a) => a.kind === kind))
