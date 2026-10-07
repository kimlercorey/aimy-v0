/**
 * jobs/runner.ts — the JobRunner service (architecture §1.1 row 9, §12 M7).
 *
 * In-app scheduler for background tasks, cron jobs, and long-running work.
 * Jobs are Effect programs (never shell commands). The runner owns a
 * layer-lifetime supervision scope; every scheduled trigger forks a
 * supervised fiber into it (see README § "Supervision policy" — the
 * JobRunner side of architecture open risk #6).
 *
 * Failure discipline:
 * - Every non-interruption failure (typed error OR defect) produces a typed
 *   `JobFailed`, always written to the job's run history. Never silent.
 * - Restart policy per job: Never / OnFailure(backoff, maxAttempts) /
 *   Always(backoff, maxAttempts). A restart is a NEW fiber, never a
 *   resurrection. Interruption never restarts.
 * - Exhausting the restart budget parks the job (typed `JobParked`) and
 *   fires a banner alert via the `AlertSink` seam — always, regardless of
 *   the job's notify policy.
 * - `disable` is graceful (in-flight runs finish); `remove` interrupts
 *   in-flight runs (each records its own `cancelled` entry).
 */
import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Ref, Result, Scope } from "effect"

import type { Tier } from "../../substrate/errors.js"
import { describeCron, nextRunAfter, validateCronSpec } from "./cron.js"
import {
  InvalidJobSpec,
  JobAlreadyExists,
  JobFailed,
  JobNotFound,
  JobNotRunnable,
  JobParked,
  JobStoreError
} from "./errors.js"
import { RunHistory } from "./history.js"
import type { RunHistoryService } from "./history.js"
import { JobCapabilities, makeJobCapabilities } from "./capabilities.js"
import type {
  AlertSinkService,
  JobAlert,
  JobDescriptor,
  JobId,
  JobSchedule,
  JobSpec,
  JobStatus,
  RestartPolicy,
  RunRecord,
  RunStatus
} from "./types.js"

// ---------------------------------------------------------------------------
// AlertSink — structural seam for the banner channel (M7 CommsBanner).
// ---------------------------------------------------------------------------

export class AlertSink extends Context.Service<AlertSink, AlertSinkService>()(
  "aimy/jobs/AlertSink"
) {}

/** Drops every alert. For contexts where the banner is not wired yet. */
export const SilentAlertSink: Layer.Layer<AlertSink> = Layer.succeed(
  AlertSink,
  AlertSink.of({ alert: () => Effect.void })
)

export interface CollectingAlertSink {
  readonly layer: Layer.Layer<AlertSink>
  readonly alerts: Ref.Ref<ReadonlyArray<JobAlert>>
}

/** Test/dev helper: an AlertSink that records every alert in a Ref. */
export const collectingAlertSink = (): Effect.Effect<CollectingAlertSink> =>
  Effect.gen(function* () {
    const alerts = yield* Ref.make<ReadonlyArray<JobAlert>>([])
    return {
      layer: Layer.succeed(
        AlertSink,
        AlertSink.of({ alert: (alert) => Ref.update(alerts, (xs) => [...xs, alert]) })
      ),
      alerts
    }
  })

// ---------------------------------------------------------------------------
// JobRunner service
// ---------------------------------------------------------------------------

export interface JobRunnerService {
  /** Schedule a job. Fails with `InvalidJobSpec` (bad id/tier/schedule/restart) or `JobAlreadyExists`. */
  readonly schedule: <A, E>(
    spec: JobSpec<A, E>
  ) => Effect.Effect<void, InvalidJobSpec | JobAlreadyExists>
  /** Snapshot of every known job. */
  readonly list: () => Effect.Effect<ReadonlyArray<JobDescriptor>, never>
  /** Enable a job. Re-enabling a parked job resets its restart budget. */
  readonly enable: (jobId: JobId) => Effect.Effect<void, JobNotFound>
  /** Disable a job. In-flight runs finish gracefully; no new triggers fire. */
  readonly disable: (jobId: JobId) => Effect.Effect<void, JobNotFound>
  /** Remove a job and interrupt its in-flight runs (each records `cancelled`). */
  readonly remove: (jobId: JobId) => Effect.Effect<void, JobNotFound>
  /** Trigger an enabled job immediately, outside its schedule. */
  readonly runNow: (jobId: JobId) => Effect.Effect<void, JobNotFound | JobNotRunnable>
}

export class JobRunner extends Context.Service<JobRunner, JobRunnerService>()(
  "aimy/jobs/JobRunner"
) {}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ManagedJob {
  readonly spec: JobSpec<unknown, unknown>
  readonly status: JobStatus
  readonly consecutiveFailures: number
  /** Restarts consumed since the last fresh (non-retry) trigger. */
  readonly retriesUsed: number
  readonly totalRuns: number
  readonly nextRunAtMs: number | undefined
  readonly isRetry: boolean
  readonly inFlight: ReadonlySet<Fiber.Fiber<void, unknown>>
}

interface RunnerState {
  readonly jobs: Ref.Ref<ReadonlyMap<JobId, ManagedJob>>
  readonly scope: Scope.Scope
  /** The deferred the scheduler loop is currently parked on (if any). */
  readonly wakeup: Ref.Ref<Deferred.Deferred<void>>
  /** Monotonic poke counter — closes the schedule-while-computing race. */
  readonly pokeSeq: Ref.Ref<number>
  readonly history: RunHistoryService
  readonly sink: AlertSinkService
}

const JOB_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TIERS: ReadonlyArray<Tier> = ["T0", "T1", "T2", "T3"]
/** Backoff cap: `backoffMs * 2^retriesUsed` never exceeds this. */
const MAX_BACKOFF_MS = 3_600_000

const backoffDelayMs = (baseMs: number, retriesUsed: number): number =>
  Math.min(baseMs * 2 ** retriesUsed, MAX_BACKOFF_MS)

const nextTickAtMs = (schedule: JobSchedule, fromMs: number): number | undefined =>
  schedule._tag === "OneShot" ? undefined : nextRunAfter(schedule.cron, fromMs)

const validateRestartPolicy = (policy: RestartPolicy): string | undefined => {
  if (policy._tag === "Never") return undefined
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 0) {
    return `restart maxAttempts must be a non-negative integer; got ${policy.maxAttempts}`
  }
  if (!Number.isFinite(policy.backoffMs) || policy.backoffMs < 0) {
    return `restart backoffMs must be a non-negative finite number; got ${policy.backoffMs}`
  }
  return undefined
}

// --- failure description ----------------------------------------------------

const describeFailureValue = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const record = error as Record<string, unknown>
    const tag = String(record._tag)
    const fields = Object.entries(record)
      .filter(([key]) => key !== "_tag")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ")
    return fields.length > 0 ? `${tag}(${fields})` : tag
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Typed reason for a failed run. Typed failures render as
 * `Tag(field=…)`; defects render as `defect: Error: message`.
 */
const describeCause = (cause: Cause.Cause<unknown>): string => {
  const failed = Cause.findFail(cause)
  if (Result.isSuccess(failed)) {
    return describeFailureValue(failed.success.error)
  }
  const defect = Cause.findDefect(cause)
  if (Result.isSuccess(defect)) {
    const value = defect.success
    return `defect: ${value instanceof Error ? `${value.name}: ${value.message}` : String(value)}`
  }
  return "unknown failure cause"
}

const renderJobFailed = (e: JobFailed): string =>
  `JobFailed(jobId=${e.jobId} attempt=${e.attempt} reason=${e.reason})`

const renderJobParked = (e: JobParked): string =>
  `JobParked(jobId=${e.jobId} attempts=${e.attempts} lastReason=${e.lastReason})`

// --- scheduler loop ---------------------------------------------------------

/**
 * Wake the scheduler loop so it recomputes deadlines. The poke-sequence
 * protocol closes the lost-wakeup race: `pokeSeq` is incremented BEFORE the
 * wakeup deferred is completed, and the loop re-checks the counter after
 * installing its fresh deferred. A poke that lands mid-computation forces a
 * recompute; a poke that lands later completes the deferred and wins the
 * race below.
 */
const poke = (state: RunnerState): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Ref.update(state.pokeSeq, (n) => n + 1)
    yield* Deferred.succeed(yield* Ref.get(state.wakeup), void 0)
  })

const triggerDue = (state: RunnerState): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const jobs = yield* Ref.get(state.jobs)
    for (const [jobId, managed] of jobs) {
      if (managed.status !== "enabled") continue
      if (managed.nextRunAtMs === undefined || managed.nextRunAtMs > now) continue
      yield* startRun(state, jobId, managed, now)
    }
  })

const schedulerLoop = (state: RunnerState): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    for (;;) {
      // Read (do NOT bump) the poke counter: only `poke()` increments it.
      // A poke that lands after this read forces a recompute; a poke that
      // lands later completes the fresh wakeup deferred and wins the race.
      const seq = yield* Ref.get(state.pokeSeq)
      yield* triggerDue(state)
      const now = yield* Clock.currentTimeMillis
      let deadlineMs: number | undefined
      for (const managed of (yield* Ref.get(state.jobs)).values()) {
        if (managed.status !== "enabled" || managed.nextRunAtMs === undefined) continue
        const delay = managed.nextRunAtMs - now
        if (deadlineMs === undefined || delay < deadlineMs) deadlineMs = delay
      }
      const wakeup = yield* Deferred.make<void>()
      yield* Ref.set(state.wakeup, wakeup)
      if ((yield* Ref.get(state.pokeSeq)) > seq) continue
      if (deadlineMs === undefined) {
        yield* Deferred.await(wakeup)
      } else if (deadlineMs <= 0) {
        continue
      } else {
        yield* Effect.race(Deferred.await(wakeup), Effect.sleep(Duration.millis(deadlineMs)))
      }
    }
  })

/**
 * Fork one supervised run fiber. The fiber is parented to the runner's
 * scope via `forkIn`: layer teardown cancels the loop and every in-flight
 * run. The trigger is CLAIMED here (retry wakeups parked, fresh ticks
 * advanced) so a second loop pass can never double-fire; the attempt
 * re-arms the next wakeup when it settles and pokes the loop.
 */
const startRun = (
  state: RunnerState,
  jobId: JobId,
  snapshot: ManagedJob,
  now: number
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const attempt = snapshot.totalRuns + 1
    const isRetry = snapshot.isRetry
    const fiberDeferred = yield* Deferred.make<Fiber.Fiber<void, unknown>>()
    const fiber = yield* Effect.forkIn(
      Effect.andThen(Deferred.await(fiberDeferred), (self) =>
        Effect.ensuring(
          executeAttempt(state, jobId, attempt, isRetry),
          Ref.update(state.jobs, (jobs) => {
            const cur = jobs.get(jobId)
            if (cur === undefined) return jobs
            const next = new Map(jobs)
            const inFlight = new Set(cur.inFlight)
            inFlight.delete(self)
            next.set(jobId, { ...cur, inFlight })
            return next
          })
        )
      ),
      state.scope
    )
    // Track the fiber BEFORE releasing it: the fiber parks on `fiberDeferred`
    // until the update below completes it, so by the time the fiber can run,
    // `remove()` is guaranteed to find it in `inFlight`. (Claiming the
    // trigger rides on the same update so a second loop pass can never
    // double-fire.)
    yield* Ref.update(state.jobs, (jobs) => {
      const cur = jobs.get(jobId)
      if (cur === undefined || cur.status !== "enabled") return jobs
      const next = new Map(jobs)
      const inFlight = new Set(cur.inFlight)
      inFlight.add(fiber)
      next.set(jobId, {
        ...cur,
        inFlight,
        totalRuns: attempt,
        isRetry: false,
        nextRunAtMs: isRetry ? undefined : nextTickAtMs(cur.spec.schedule, now)
      })
      return next
    })
    yield* Deferred.succeed(fiberDeferred, fiber)
  })

const executeAttempt = (
  state: RunnerState,
  jobId: JobId,
  attempt: number,
  isRetry: boolean
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const runId = `${jobId}#${attempt}`
    const startedAtMs = yield* Clock.currentTimeMillis
    const managed = (yield* Ref.get(state.jobs)).get(jobId)
    if (managed === undefined) {
      // Removed between trigger and run: record, run nothing.
      yield* state.history.append({
        jobId,
        runId,
        attempt,
        tier: "T0",
        isRetry,
        status: "cancelled",
        startedAtMs,
        endedAtMs: startedAtMs,
        durationMs: 0,
        reason: "job removed before the run started"
      })
      return
    }
    const spec = managed.spec
    // NOTE (Effect 4): `Effect.exit` does NOT trap interruption — an
    // interrupted run fiber dies before any code after `exit` runs. The
    // terminal outcome (succeeded/failed/cancelled) is therefore recorded in
    // an `onExit` finalizer, which observes every exit INCLUDING
    // interruption. The recording itself is uninterruptible, so a cancelled
    // run ALWAYS leaves its record — failures are never silent, even under
    // cancel. The body stays interruptible so `remove()` can stop it.
    yield* Effect.onExit(
      Effect.gen(function* () {
        yield* state.history.append({
          jobId,
          runId,
          attempt,
          tier: spec.tier,
          isRetry,
          status: "started",
          startedAtMs
        })
        const caps = makeJobCapabilities(jobId, spec.tier)
        yield* spec.run.pipe(
          Effect.provideService(JobCapabilities, caps),
          Effect.provideService(AlertSink, state.sink)
        )
      }),
      (exit) =>
        Effect.uninterruptible(
          recordOutcome(state, jobId, attempt, isRetry, spec, startedAtMs, exit)
        )
    )
  })

const recordOutcome = (
  state: RunnerState,
  jobId: JobId,
  attempt: number,
  isRetry: boolean,
  spec: JobSpec<unknown, unknown>,
  startedAtMs: number,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void, JobStoreError> =>
  Effect.gen(function* () {
    const endedAtMs = yield* Clock.currentTimeMillis
    const runId = `${jobId}#${attempt}`
    const durationMs = endedAtMs - startedAtMs
    const base = {
      jobId,
      runId,
      attempt,
      tier: spec.tier,
      isRetry,
      startedAtMs,
      endedAtMs,
      durationMs
    }

    if (exit._tag === "Success") {
      const succeeded: RunRecord = { ...base, status: "succeeded" }
      yield* state.history.append(succeeded)
      yield* afterSucceeded(state, jobId, spec, attempt, endedAtMs, durationMs)
      return
    }

    if (Cause.hasInterruptsOnly(exit.cause)) {
      // Cancellation is external (remove / layer teardown): record it, never
      // restart, never park. The job's wakeup stays parked; re-enable
      // recomputes it.
      const cancelled: RunRecord = { ...base, status: "cancelled", reason: "interrupted" }
      yield* state.history.append(cancelled)
      yield* poke(state)
      return
    }

    const reason = describeCause(exit.cause)
    const failed = new JobFailed({ jobId, attempt, reason })
    const record: RunRecord = { ...base, status: "failed", reason: renderJobFailed(failed) }
    yield* state.history.append(record)
    yield* afterFailed(state, jobId, spec, attempt, isRetry, endedAtMs, failed)
  })

const afterSucceeded = (
  state: RunnerState,
  jobId: JobId,
  spec: JobSpec<unknown, unknown>,
  attempt: number,
  endedAtMs: number,
  durationMs: number
): Effect.Effect<void, JobStoreError> =>
  Effect.gen(function* () {
    const restart = spec.restart
    yield* Ref.update(state.jobs, (jobs) => {
      const cur = jobs.get(jobId)
      if (cur === undefined) return jobs
      const next = new Map(jobs)
      if (restart._tag === "Always" && cur.retriesUsed < restart.maxAttempts) {
        // "Always" restarts after success too, consuming the restart budget.
        next.set(jobId, {
          ...cur,
          consecutiveFailures: 0,
          retriesUsed: cur.retriesUsed + 1,
          isRetry: true,
          nextRunAtMs: endedAtMs + backoffDelayMs(restart.backoffMs, cur.retriesUsed)
        })
      } else {
        next.set(jobId, {
          ...cur,
          consecutiveFailures: 0,
          retriesUsed: 0,
          isRetry: false,
          nextRunAtMs: nextTickAtMs(spec.schedule, endedAtMs)
        })
      }
      return next
    })
    yield* poke(state)
    if (spec.notify === "always") {
      yield* state.sink.alert({
        kind: "job-succeeded",
        jobId,
        jobName: spec.name,
        atMs: endedAtMs,
        detail: `run #${attempt} succeeded in ${durationMs}ms`
      })
    }
  })

const afterFailed = (
  state: RunnerState,
  jobId: JobId,
  spec: JobSpec<unknown, unknown>,
  attempt: number,
  isRetry: boolean,
  endedAtMs: number,
  failed: JobFailed
): Effect.Effect<void, JobStoreError> =>
  Effect.gen(function* () {
    const restart = spec.restart
    const cur = (yield* Ref.get(state.jobs)).get(jobId)
    if (cur === undefined) {
      // Job removed mid-run: the failure is already in history; nothing to re-arm.
      return
    }

    if (
      (restart._tag === "OnFailure" || restart._tag === "Always") &&
      cur.retriesUsed < restart.maxAttempts
    ) {
      const delay = backoffDelayMs(restart.backoffMs, cur.retriesUsed)
      yield* Ref.update(state.jobs, (jobs) => {
        const c = jobs.get(jobId)
        if (c === undefined) return jobs
        const next = new Map(jobs)
        next.set(jobId, {
          ...c,
          consecutiveFailures: c.consecutiveFailures + 1,
          retriesUsed: c.retriesUsed + 1,
          isRetry: true,
          nextRunAtMs: endedAtMs + delay
        })
        return next
      })
      yield* poke(state)
      return
    }

    if (restart._tag === "Never") {
      // No restart budget: advance the cadence, alert per the notify policy.
      yield* Ref.update(state.jobs, (jobs) => {
        const c = jobs.get(jobId)
        if (c === undefined) return jobs
        const next = new Map(jobs)
        next.set(jobId, {
          ...c,
          consecutiveFailures: c.consecutiveFailures + 1,
          retriesUsed: 0,
          isRetry: false,
          nextRunAtMs: nextTickAtMs(spec.schedule, endedAtMs)
        })
        return next
      })
      yield* poke(state)
      if (spec.notify !== "never") {
        yield* state.sink.alert({
          kind: "job-failed",
          jobId,
          jobName: spec.name,
          atMs: endedAtMs,
          detail: renderJobFailed(failed)
        })
      }
      return
    }

    // Restart budget exhausted → park. Typed JobParked, run-history entry,
    // and a banner alert that fires REGARDLESS of the notify policy.
    const parked = new JobParked({
      jobId,
      attempts: cur.retriesUsed,
      lastReason: failed.reason
    })
    yield* Ref.update(state.jobs, (jobs) => {
      const c = jobs.get(jobId)
      if (c === undefined) return jobs
      const next = new Map(jobs)
      next.set(jobId, {
        ...c,
        status: "parked",
        consecutiveFailures: c.consecutiveFailures + 1,
        isRetry: false,
        nextRunAtMs: undefined
      })
      return next
    })
    const parkedRecord = {
      jobId,
      runId: `${jobId}#${attempt}`,
      attempt,
      tier: spec.tier,
      isRetry,
      status: "parked" as RunStatus,
      startedAtMs: endedAtMs,
      endedAtMs,
      durationMs: 0,
      reason: renderJobParked(parked)
    }
    yield* state.history.append(parkedRecord)
    yield* poke(state)
    yield* state.sink.alert({
      kind: "job-parked",
      jobId,
      jobName: spec.name,
      atMs: endedAtMs,
      detail: renderJobParked(parked)
    })
  })

// --- service operations -----------------------------------------------------

const describeJob = (managed: ManagedJob): JobDescriptor => ({
  id: managed.spec.id,
  name: managed.spec.name,
  tier: managed.spec.tier,
  status: managed.status,
  schedule:
    managed.spec.schedule._tag === "OneShot"
      ? `once at ${new Date(managed.spec.schedule.atMs).toISOString()}`
      : `cron ${describeCron(managed.spec.schedule.cron)}`,
  restart: managed.spec.restart,
  nextRunAtMs: managed.nextRunAtMs,
  consecutiveFailures: managed.consecutiveFailures,
  totalRuns: managed.totalRuns
})

const scheduleJob = <A, E>(
  state: RunnerState,
  spec: JobSpec<A, E>
): Effect.Effect<void, InvalidJobSpec | JobAlreadyExists> =>
  Effect.gen(function* () {
    const jobId = spec.id
    if (!JOB_ID_RE.test(jobId)) {
      return yield* Effect.fail(
        new InvalidJobSpec({
          jobId,
          reason: `id must match ${JOB_ID_RE.source}; got ${JSON.stringify(jobId)}`
        })
      )
    }
    if (!TIERS.includes(spec.tier)) {
      return yield* Effect.fail(
        new InvalidJobSpec({ jobId, reason: `unknown tier ${JSON.stringify(spec.tier)}` })
      )
    }
    if ((yield* Ref.get(state.jobs)).has(jobId)) {
      return yield* Effect.fail(new JobAlreadyExists({ jobId }))
    }
    const restartProblem = validateRestartPolicy(spec.restart)
    if (restartProblem !== undefined) {
      return yield* Effect.fail(new InvalidJobSpec({ jobId, reason: restartProblem }))
    }
    const now = yield* Clock.currentTimeMillis
    let nextRunAtMs: number | undefined
    if (spec.schedule._tag === "OneShot") {
      const atMs = spec.schedule.atMs
      if (!Number.isFinite(atMs) || atMs < 0) {
        return yield* Effect.fail(
          new InvalidJobSpec({
            jobId,
            reason: `one-shot atMs must be a non-negative finite timestamp; got ${atMs}`
          })
        )
      }
      nextRunAtMs = atMs
    } else {
      const problems = validateCronSpec(spec.schedule.cron)
      if (problems.length > 0) {
        return yield* Effect.fail(
          new InvalidJobSpec({ jobId, reason: `invalid cron: ${problems.join("; ")}` })
        )
      }
      const next = nextRunAfter(spec.schedule.cron, now)
      if (next === undefined) {
        return yield* Effect.fail(
          new InvalidJobSpec({ jobId, reason: "cron schedule never matches within 366 days" })
        )
      }
      nextRunAtMs = next
    }
    // Effect is covariant in its success/error types here: the runner only
    // ever observes the run through Effect.exit as unknown/unknown.
    const stored: JobSpec<unknown, unknown> = {
      ...spec,
      run: spec.run as Effect.Effect<unknown, unknown, JobCapabilities | AlertSink>
    }
    const managed: ManagedJob = {
      spec: stored,
      status: "enabled",
      consecutiveFailures: 0,
      retriesUsed: 0,
      totalRuns: 0,
      nextRunAtMs,
      isRetry: false,
      inFlight: new Set()
    }
    yield* Ref.update(state.jobs, (jobs) => new Map(jobs).set(jobId, managed))
    yield* poke(state)
  })

const enableJob = (state: RunnerState, jobId: JobId): Effect.Effect<void, JobNotFound> =>
  Effect.gen(function* () {
    const managed = (yield* Ref.get(state.jobs)).get(jobId)
    if (managed === undefined) return yield* Effect.fail(new JobNotFound({ jobId }))
    const now = yield* Clock.currentTimeMillis
    yield* Ref.update(state.jobs, (jobs) => {
      const cur = jobs.get(jobId)
      if (cur === undefined || cur.status === "enabled") return jobs
      const next = new Map(jobs)
      // Re-enabling a parked job resets its restart budget (documented).
      const wasParked = cur.status === "parked"
      let nextRunAtMs = cur.nextRunAtMs
      if (nextRunAtMs === undefined || nextRunAtMs <= now) {
        nextRunAtMs =
          cur.spec.schedule._tag === "OneShot" ? now : nextRunAfter(cur.spec.schedule.cron, now)
      }
      next.set(jobId, {
        ...cur,
        status: "enabled",
        consecutiveFailures: wasParked ? 0 : cur.consecutiveFailures,
        retriesUsed: wasParked ? 0 : cur.retriesUsed,
        isRetry: false,
        nextRunAtMs
      })
      return next
    })
    yield* poke(state)
  })

const disableJob = (state: RunnerState, jobId: JobId): Effect.Effect<void, JobNotFound> =>
  Effect.gen(function* () {
    const managed = (yield* Ref.get(state.jobs)).get(jobId)
    if (managed === undefined) return yield* Effect.fail(new JobNotFound({ jobId }))
    // Graceful: in-flight runs finish; no new triggers fire.
    yield* Ref.update(state.jobs, (jobs) => {
      const cur = jobs.get(jobId)
      if (cur === undefined || cur.status !== "enabled") return jobs
      const next = new Map(jobs)
      next.set(jobId, { ...cur, status: "disabled" })
      return next
    })
    yield* poke(state)
  })

const removeJob = (state: RunnerState, jobId: JobId): Effect.Effect<void, JobNotFound> =>
  Effect.gen(function* () {
    const managed = (yield* Ref.get(state.jobs)).get(jobId)
    if (managed === undefined) return yield* Effect.fail(new JobNotFound({ jobId }))
    yield* Ref.update(state.jobs, (jobs) => {
      const next = new Map(jobs)
      next.delete(jobId)
      return next
    })
    yield* poke(state)
    // Interrupt in-flight runs. Each run's uninterruptible bookkeeping
    // records its own `cancelled` entry — removal is never silent.
    // NOTE: in Effect 4 `Fiber.interrupt` only SIGNALS; `Fiber.await` waits
    // for actual termination, so the `cancelled` record is guaranteed present
    // when `remove()` returns.
    for (const fiber of managed.inFlight) {
      yield* Fiber.interrupt(fiber)
      yield* Fiber.await(fiber)
    }
  })

const runNowJob = (
  state: RunnerState,
  jobId: JobId
): Effect.Effect<void, JobNotFound | JobNotRunnable> =>
  Effect.gen(function* () {
    const managed = (yield* Ref.get(state.jobs)).get(jobId)
    if (managed === undefined) return yield* Effect.fail(new JobNotFound({ jobId }))
    if (managed.status !== "enabled") {
      return yield* Effect.fail(new JobNotRunnable({ jobId, status: managed.status }))
    }
    const now = yield* Clock.currentTimeMillis
    yield* Ref.update(state.jobs, (jobs) => {
      const cur = jobs.get(jobId)
      if (cur === undefined || cur.status !== "enabled") return jobs
      const next = new Map(jobs)
      next.set(jobId, { ...cur, isRetry: false, retriesUsed: 0, nextRunAtMs: now })
      return next
    })
    yield* poke(state)
  })

const makeService = (state: RunnerState): JobRunnerService => ({
  schedule: (spec) => scheduleJob(state, spec),
  list: () =>
    Effect.map(Ref.get(state.jobs), (jobs) =>
      [...jobs.values()].map(describeJob).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    ),
  enable: (jobId) => enableJob(state, jobId),
  disable: (jobId) => disableJob(state, jobId),
  remove: (jobId) => removeJob(state, jobId),
  runNow: (jobId) => runNowJob(state, jobId)
})

const buildRunner: Effect.Effect<JobRunnerService, never, AlertSink | RunHistory | Scope.Scope> =
  Effect.gen(function* () {
    const sink = yield* AlertSink
    const history = yield* RunHistory
    // Layer-lifetime supervision scope: every job fiber is a child of this
    // scope via forkIn — teardown cancels the scheduler loop and all
    // in-flight runs. This is the JobRunner side of the supervision tree
    // (architecture open risk #6); the full policy is in README.md.
    const scope = yield* Effect.acquireRelease(Scope.make(), (s, exit) => Scope.close(s, exit))
    const state: RunnerState = {
      jobs: yield* Ref.make<ReadonlyMap<JobId, ManagedJob>>(new Map()),
      scope,
      wakeup: yield* Ref.make<Deferred.Deferred<void>>(yield* Deferred.make<void>()),
      pokeSeq: yield* Ref.make(0),
      history,
      sink
    }
    yield* Effect.forkIn(schedulerLoop(state), scope)
    return makeService(state)
  })

/**
 * The layer. Declared after `buildRunner` (not as a class static) because
 * statics evaluate eagerly at class-definition time.
 */
export const JobRunnerLive: Layer.Layer<JobRunner, never, AlertSink | RunHistory> =
  Layer.effect(JobRunner, buildRunner)
