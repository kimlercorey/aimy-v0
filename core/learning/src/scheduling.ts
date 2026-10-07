/**
 * scheduling.ts — idle-gated review scheduling (architecture §3.5).
 *
 * On local hardware a review fork must never fight the user's GPU: the
 * review queue waits for idle (settle window, max age, one slot per
 * session with newest-snapshot-wins coalescing). Explicit user-invoked
 * refinement never defers and never waits for idle.
 *
 * The idle signal is an injectable Effect interface (`IdleSignal`) so tests
 * never need real GPU state; production provides the GPU-lease-backed
 * implementation.
 */
import { Clock, Context, Duration, Effect, Layer, Ref } from "effect"
import {
  DEFAULT_LEARNING_CONFIG,
  type ReviewRequest
} from "./review-types.js"
import type { ConversationSnapshot } from "./snapshot.js"
import type { WriteProvenance } from "./provenance.js"
import { ReviewForks, type ReviewForksService } from "./forks.js"

export interface IdleSignalService {
  /**
   * Resolve once the machine has been continuously idle for `settle`.
   * Never rejects.
   */
  readonly waitForIdle: (settle: Duration.Input) => Effect.Effect<void, never>
  readonly isIdleNow: () => Effect.Effect<boolean, never>
}

export class IdleSignal extends Context.Service<IdleSignal, IdleSignalService>()(
  "aimy/learning/IdleSignal"
) {}

/** One queued background review: one slot per session. */
export interface QueuedReview {
  readonly sessionId: string
  readonly snapshot: ConversationSnapshot
  readonly provenance: WriteProvenance
  /** `Clock.currentTimeMillis` at enqueue; entries older than maxAge are dropped. */
  readonly enqueuedAtMs: number
}

export interface DrainReport {
  readonly processed: number
  readonly droppedStale: number
  readonly remaining: number
}

export interface ReviewSchedulerService {
  /**
   * Queue a background review. One slot per session: re-enqueueing
   * replaces the older snapshot (newest-snapshot-wins coalescing) and
   * refreshes its age.
   */
  readonly enqueue: (req: ReviewRequest) => Effect.Effect<void, never>
  /**
   * Explicit user-invoked refinement: spawns the review IMMEDIATELY —
   * never queued, never idle-gated, never deferred.
   */
  readonly refineNow: (req: ReviewRequest) => Effect.Effect<void, never>
  /**
   * Process the queue in insertion order: drop entries older than maxAge
   * (never run a stale review), otherwise wait for idle (settle window)
   * and spawn the review.
   */
  readonly drain: () => Effect.Effect<DrainReport, never>
  readonly pending: () => Effect.Effect<ReadonlyArray<QueuedReview>, never>
}

export class ReviewScheduler extends Context.Service<ReviewScheduler, ReviewSchedulerService>()(
  "aimy/learning/ReviewScheduler"
) {}

export interface ReviewSchedulerOpts {
  readonly settleWindowMs?: number | undefined
  readonly maxAgeMs?: number | undefined
}

export const layerReviewScheduler = (
  opts?: ReviewSchedulerOpts
): Layer.Layer<ReviewScheduler, never, ReviewForks | IdleSignal> =>
  Layer.effect(
    ReviewScheduler,
    Effect.gen(function* () {
      const forks: ReviewForksService = yield* ReviewForks
      const idle: IdleSignalService = yield* IdleSignal
      const queue = yield* Ref.make(new Map<string, QueuedReview>())
      const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_LEARNING_CONFIG.maxAgeMs
      const settleWindowMs = opts?.settleWindowMs ?? DEFAULT_LEARNING_CONFIG.settleWindowMs

      const service: ReviewSchedulerService = {
        enqueue: (req) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const entry: QueuedReview = {
              sessionId: req.sessionId,
              snapshot: req.snapshot,
              provenance: req.provenance,
              enqueuedAtMs: now
            }
            // One slot per session, newest-snapshot-wins.
            yield* Ref.update(queue, (m) => new Map(m).set(req.sessionId, entry))
          }),

        refineNow: (req) => forks.spawnReview({ ...req, mode: "user-invoked" }),

        drain: () =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            let processed = 0
            let droppedStale = 0
            const entries = Array.from((yield* Ref.get(queue)).values())
            for (const entry of entries) {
              if (now - entry.enqueuedAtMs > maxAgeMs) {
                droppedStale += 1
                yield* Ref.update(queue, (m) => {
                  const next = new Map(m)
                  next.delete(entry.sessionId)
                  return next
                })
                continue
              }
              yield* idle.waitForIdle(Duration.millis(settleWindowMs))
              yield* forks.spawnReview({
                sessionId: entry.sessionId,
                snapshot: entry.snapshot,
                mode: "background",
                provenance: entry.provenance
              })
              processed += 1
              yield* Ref.update(queue, (m) => {
                const next = new Map(m)
                next.delete(entry.sessionId)
                return next
              })
            }
            const remaining = (yield* Ref.get(queue)).size
            return { processed, droppedStale, remaining }
          }),

        pending: () =>
          Ref.get(queue).pipe(Effect.map((m) => Array.from(m.values())))
      }
      return service
    })
  )

/** Default scheduler layer: architecture reference timings. */
export const ReviewSchedulerLive: Layer.Layer<ReviewScheduler, never, ReviewForks | IdleSignal> =
  layerReviewScheduler()

/**
 * Test/production-seam helper: a manually-driven `IdleSignal`.
 * `waitForIdle` polls the flag (100ms) then requires it to STAY set across
 * the settle window — mirroring continuous-idle semantics without GPU state.
 */
export const makeFakeIdleSignal = (initialIdle: boolean) =>
  Effect.gen(function* () {
    const idleRef = yield* Ref.make(initialIdle)
    const service: IdleSignalService = {
      waitForIdle: (settle) =>
        Effect.gen(function* () {
          for (;;) {
            if (yield* Ref.get(idleRef)) {
              yield* Effect.sleep(settle)
              if (yield* Ref.get(idleRef)) return
            } else {
              yield* Effect.sleep("100 millis")
            }
          }
        }),
      isIdleNow: () => Ref.get(idleRef)
    }
    return {
      signal: service,
      setIdle: (idle: boolean) => Ref.set(idleRef, idle)
    }
  })

/** Layer form of the fake: idle (or not) from the start. */
export const FakeIdleSignalLive = (initialIdle: boolean): Layer.Layer<IdleSignal> =>
  Layer.effect(
    IdleSignal,
    makeFakeIdleSignal(initialIdle).pipe(Effect.map(({ signal }) => signal))
  )
