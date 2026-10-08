/**
 * agent-loop/background-job.ts — ad-hoc background jobs spawned from chat turns.
 *
 * A background job is a unit of work the agent forks to run asynchronously
 * while the conversation continues. The turn returns immediately ("I'll have
 * that research ready in ~30 minutes") and the job resolves independently.
 *
 * This is the seam for non-blocking interaction: the chat never blocks on
 * long-running work. Each job runs in its own Effect fiber (its own
 * "container with a promise"), tracked in a registry, with completion
 * routed to the notification sink.
 *
 * v1 scope: types + spawn + registry + completion callback. The
 * notification sink logs by default; wiring it to in-chat re-entry or
 * external messaging (text/Telegram) is the next step, not this one.
 */
import { Effect, Fiber, Ref } from "effect"

/** Unique job identifier. */
export type BackgroundJobId = string

/** Lifecycle states for a background job. */
export type BackgroundJobStatus =
  | { readonly _tag: "Running"; readonly startedAtMs: number }
  | { readonly _tag: "Succeeded"; readonly startedAtMs: number; readonly completedAtMs: number }
  | { readonly _tag: "Failed"; readonly startedAtMs: number; readonly completedAtMs: number; readonly reason: string }
  | { readonly _tag: "Cancelled"; readonly startedAtMs: number; readonly completedAtMs: number }

/** How the user wants to be notified when this job completes. */
export type JobNotification =
  | { readonly _tag: "InChat" }
  | { readonly _tag: "TextMessage"; readonly phone: string }
  | { readonly _tag: "Silent" }

/**
 * A background job record. The `estimateMs` is the agent's time estimate
 * given to the user ("ready in ~30 minutes") — informational, not a timeout.
 */
export interface BackgroundJob {
  readonly id: BackgroundJobId
  readonly description: string
  readonly sessionId: string
  readonly turnId: string
  readonly estimateMs: number | undefined
  readonly notification: JobNotification
  readonly status: BackgroundJobStatus
  readonly result: unknown | undefined
}

/** Parameters for spawning a background job. */
export interface SpawnJobParams {
  readonly description: string
  readonly sessionId: string
  readonly turnId: string
  readonly estimateMs?: number | undefined
  readonly notification?: JobNotification | undefined
  readonly work: Effect.Effect<unknown, unknown>
}

/** Called when a job reaches a terminal state. v1 default logs; replace with real routing. */
export type JobCompletionSink = (job: BackgroundJob) => void

const defaultSink: JobCompletionSink = (job) => {
  // eslint-disable-next-line no-console
  console.log(`[background-job] ${job.id} ${job.status._tag}: ${job.description}`)
}

/**
 * Registry for background jobs. `spawn` forks the work into a supervised
 * fiber and returns the job ID immediately — the caller never blocks.
 * A job failure is recorded in the registry; it never crashes the spawner.
 */
export interface BackgroundJobRegistry {
  readonly spawn: (params: SpawnJobParams) => Effect.Effect<BackgroundJobId, never, never>
  readonly get: (id: BackgroundJobId) => Effect.Effect<BackgroundJob | undefined, never, never>
  readonly list: () => Effect.Effect<ReadonlyArray<BackgroundJob>, never, never>
  readonly cancel: (id: BackgroundJobId) => Effect.Effect<boolean, never, never>
}

let jobCounter = 0

const newJobId = (): BackgroundJobId => {
  jobCounter += 1
  return `bg-${Date.now().toString(36)}-${jobCounter.toString(36)}`
}

export const makeBackgroundJobRegistry = (
  onComplete: JobCompletionSink = defaultSink
): Effect.Effect<BackgroundJobRegistry, never, never> =>
  Effect.gen(function* () {
    const jobs = yield* Ref.make(new Map<BackgroundJobId, BackgroundJob>())
    const fibers = new Map<BackgroundJobId, Fiber.Fiber<unknown, unknown>>()

    const setStatus = (id: BackgroundJobId, status: BackgroundJobStatus, result?: unknown) =>
      Ref.update(jobs, (m) => {
        const existing = m.get(id)
        if (existing === undefined) return m
        const updated: BackgroundJob = {
          ...existing,
          status,
          result: result !== undefined ? result : existing.result
        }
        // Notify on terminal states.
        if (status._tag !== "Running") {
          try {
            onComplete(updated)
          } catch {
            // Notification sink must never break the registry.
          }
        }
        return new Map(m).set(id, updated)
      })

    const spawn = (params: SpawnJobParams): Effect.Effect<BackgroundJobId, never, never> =>
      Effect.gen(function* () {
        const id = newJobId()
        const startedAtMs = Date.now()
        const job: BackgroundJob = {
          id,
          description: params.description,
          sessionId: params.sessionId,
          turnId: params.turnId,
          estimateMs: params.estimateMs,
          notification: params.notification ?? { _tag: "InChat" },
          status: { _tag: "Running", startedAtMs },
          result: undefined
        }
        yield* Ref.update(jobs, (m) => new Map(m).set(id, job))

        // Fork the work detached — it outlives the spawning turn.
        // The spawner gets the job ID back immediately; completion
        // (success or failure) lands in the registry. All errors are
        // caught and recorded; the forked fiber never fails.
        const fiber = yield* params.work.pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              setStatus(id, {
                _tag: "Failed",
                startedAtMs,
                completedAtMs: Date.now(),
                reason: String(cause)
              }),
            onSuccess: (result) =>
              setStatus(id, { _tag: "Succeeded", startedAtMs, completedAtMs: Date.now() }, result)
          }),
          Effect.orElseSucceed(() => undefined),
          Effect.forkDetach
        )
        fibers.set(id, fiber)
        return id
      })

    const cancel = (id: BackgroundJobId): Effect.Effect<boolean, never, never> =>
      Effect.gen(function* () {
        const fiber = fibers.get(id)
        const m = yield* Ref.get(jobs)
        const job = m.get(id)
        if (fiber === undefined || job === undefined || job.status._tag !== "Running") {
          return false
        }
        yield* Fiber.interrupt(fiber)
        fibers.delete(id)
        yield* setStatus(id, {
          _tag: "Cancelled",
          startedAtMs: job.status.startedAtMs,
          completedAtMs: Date.now()
        })
        return true
      })

    return {
      spawn,
      get: (id) => Ref.get(jobs).pipe(Effect.map((m) => m.get(id))),
      list: () => Ref.get(jobs).pipe(Effect.map((m) => [...m.values()])),
      cancel
    } satisfies BackgroundJobRegistry
  })
