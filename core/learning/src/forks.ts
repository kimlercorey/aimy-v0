/**
 * forks.ts — background-review forks (architecture §3.5).
 *
 * After a turn completes, a review fiber may spawn holding an IMMUTABLE
 * SNAPSHOT of the conversation (never a live reference — the main
 * conversation and prompt cache are untouched by construction: the fork is
 * never given them).
 *
 * - Dispatch-side tool whitelist: the fork's toolset is restricted AT
 *   DISPATCH — `proposeWrite` + `readContext` only. The worker is a pure
 *   function of `(snapshot, toolset)`; it cannot reach MemoryService,
 *   InferencePool, or any other service because it is never given them.
 * - Structured concurrency: supervised fibers in a layer-lifetime scope;
 *   cancellation propagates; post-cancel side effects are impossible by
 *   construction (a cancelled fork records no outcome and applies no
 *   further writes — the fiber is simply dead).
 * - Foreground-priority cancel with bounded handshake: `noteLiveTurn`
 *   interrupts the in-flight review and waits for acknowledgement up to
 *   `ackDeadlineMs` (default 2000). On timeout the live turn proceeds
 *   anyway — the fork NEVER blocks the user.
 * - Aux-model routing: the default worker replays a COMPACT DIGEST (never
 *   the full snapshot) through `InferencePool.generateAux` — background
 *   cognition never competes with the foreground for the best model.
 */
import { Cause, Context, Data, Deferred, Duration, Effect, Fiber, Layer, Option, Ref, Scope } from "effect"
import { InferencePool, type InferencePoolService } from "../../inference-pool/index.js"
import type { MemoryOpError } from "../../memory/index.js"
import { MemoryService, type KvNamespace, type MemoryServiceShape } from "../../memory/index.js"
import { UnattributedWrite, type WriteProvenance } from "./provenance.js"
import { makeDigest, type ConversationSnapshot } from "./snapshot.js"
import { REVIEW_SYSTEM_PROMPT, ReviewParseError, parseProposals } from "./prompts.js"
import {
  DEFAULT_LEARNING_CONFIG,
  type CancelAck,
  type ForkOutcome,
  type RawProposal,
  type ReviewRequest,
  type WriteDisposition
} from "./review-types.js"
import { UnattendedWriteGate, type UnattendedWriteGateService } from "./writes.js"

/** The review worker failed (aux lane down, unparseable output, gate denial…). Typed. */
export class ReviewWorkerError extends Data.TaggedError("ReviewWorkerError")<{
  readonly reason: string
}> {}

/** `readContext` could not serve the query. Typed, never a crash. */
export class ReviewReadError extends Data.TaggedError("ReviewReadError")<{
  readonly reason: string
}> {}

/**
 * The dispatch-side tool whitelist. This is the ENTIRE capability surface a
 * review worker receives — proposing memory/skill writes and read-only
 * context reads. No arbitrary tool execution exists on this interface.
 */
export interface ReviewToolset {
  /**
   * Propose one write. `add` applies (provenance-checked, atomic);
   * `replace`/`remove` stage for human approval; staging failure degrades
   * to `Denied`. Provenance is attached by the runner from the request —
   * never model-supplied, never worker-supplied.
   */
  readonly proposeWrite: (
    proposal: RawProposal
  ) => Effect.Effect<WriteDisposition, UnattributedWrite | MemoryOpError>
  /**
   * Read-only context for the reviewer: `"<namespace>:<key>"`
   * (e.g. `"profile:likes"`). Returns the JSON value or a not-found note.
   */
  readonly readContext: (query: string) => Effect.Effect<string, ReviewReadError>
}

export interface WorkerResult {
  readonly proposals: ReadonlyArray<RawProposal>
  readonly dispositions: ReadonlyArray<WriteDisposition>
}

/**
 * A review worker: pure function of (immutable snapshot, whitelisted
 * toolset). It cannot touch anything it was not given.
 */
export type ReviewWorker = (
  snapshot: ConversationSnapshot,
  toolset: ReviewToolset
) => Effect.Effect<WorkerResult, ReviewWorkerError>

export interface ReviewForkHandle {
  readonly fiber: Fiber.Fiber<void, never>
  readonly sessionId: string
  readonly startedAt: number
  /** Completed by `noteLiveTurn`/replace BEFORE the interrupt is sent. */
  readonly cancelled: Deferred.Deferred<void>
}

export interface ReviewForksService {
  /**
   * Spawn a review fiber for a finished turn. Newest-wins: an in-flight
   * review for the same session is retired (bounded handshake, not
   * blocking the spawn) and replaced.
   */
  readonly spawnReview: (req: ReviewRequest) => Effect.Effect<void, never>
  /**
   * A new live turn started: cancel any in-flight review for the session
   * with a bounded acknowledgement handshake. Never blocks past the
   * deadline — the fork never blocks the user.
   */
  readonly noteLiveTurn: (sessionId: string) => Effect.Effect<CancelAck, never>
  /** The in-flight handle for a session, if any. */
  readonly inFlight: (sessionId: string) => Effect.Effect<Option.Option<ReviewForkHandle>, never>
  /** The last recorded outcome for a session (completed/failed reviews only). */
  readonly lastOutcome: (sessionId: string) => Effect.Effect<Option.Option<ForkOutcome>, never>
}

export class ReviewForks extends Context.Service<ReviewForks, ReviewForksService>()(
  "aimy/learning/ReviewForks"
) {}

/**
 * Default worker: aux-model routing. Builds the compact digest, sends it
 * (never the full snapshot) through the pool's aux lane, parses the
 * JSON-lines proposals, and proposes each through the whitelisted toolset.
 */
export const makeAuxDigestWorker = (
  pool: InferencePoolService,
  digestCharBudget: number
): ReviewWorker => (snapshot, toolset) =>
  Effect.gen(function* () {
    const digest = makeDigest(snapshot, digestCharBudget)
    const response = yield* pool
      .generateAux({
        messages: [
          { role: "system", content: REVIEW_SYSTEM_PROMPT },
          { role: "user", content: `Review this turn digest and propose writes:\n\n${digest}` }
        ],
        params: {},
        maxTokens: 1024
      })
      .pipe(
        Effect.catch((e) =>
          Effect.fail(new ReviewWorkerError({ reason: `aux lane failed: ${e._tag}: ${e.reason}` }))
        )
      )
    const parsed = parseProposals(response.text)
    if (!Array.isArray(parsed)) {
      const err: ReviewParseError = parsed.error
      return yield* Effect.fail(
        new ReviewWorkerError({
          reason: `unparseable reviewer output (${err.reason}): ${err.line.slice(0, 120)}`
        })
      )
    }
    const dispositions: Array<WriteDisposition> = []
    for (const raw of parsed) {
      const disposition = yield* toolset.proposeWrite(raw).pipe(
        Effect.catch((e) =>
          Effect.fail(new ReviewWorkerError({ reason: `write gate failed: ${e._tag}: ${e.reason}` }))
        )
      )
      dispositions.push(disposition)
    }
    return { proposals: parsed, dispositions }
  })

export interface ReviewForksOpts {
  /** Override the worker (tests). Defaults to the aux-digest worker. */
  readonly worker?: ReviewWorker | undefined
  /** Bounded-cancel handshake deadline. Default 2000ms. */
  readonly ackDeadlineMs?: number | undefined
  /** Char budget for the compact digest. Default 4000. */
  readonly digestCharBudget?: number | undefined
}

interface Deps {
  readonly gate: UnattendedWriteGateService
  readonly memory: MemoryServiceShape
  readonly worker: ReviewWorker
  readonly ackDeadlineMs: number
  readonly forkScope: Scope.Scope
  readonly inFlightRef: Ref.Ref<Map<string, ReviewForkHandle>>
  readonly outcomesRef: Ref.Ref<Map<string, ForkOutcome>>
}

/**
 * Bounded-cancel handshake. Marks the handle cancelled, sends the
 * interrupt, and waits for the fiber to actually terminate — up to the
 * deadline. Past the deadline the caller proceeds anyway (`Timeout`); the
 * interrupt was already sent, so the fork still dies as soon as it can,
 * and can never apply a post-cancel write.
 */
const cancelWithAck = (
  handle: ReviewForkHandle,
  ackDeadlineMs: number
): Effect.Effect<CancelAck, never> =>
  Effect.gen(function* () {
    yield* Deferred.succeed(handle.cancelled, undefined)
    const acked = yield* Effect.raceFirst(
      Effect.as(Fiber.interrupt(handle.fiber), true),
      Effect.as(Effect.sleep(Duration.millis(ackDeadlineMs)), false)
    )
    return (acked ? { _tag: "Acked" } : { _tag: "Timeout" }) as CancelAck
  })

const makeService = (deps: Deps): ReviewForksService => {
  const inFlightRef = deps.inFlightRef
  const outcomesRef = deps.outcomesRef

  const recordOutcome = (sessionId: string, outcome: ForkOutcome) =>
    Ref.update(outcomesRef, (m) => new Map(m).set(sessionId, outcome))

  /** The whitelisted toolset, closed over the request (provenance source). */
  const makeToolset = (req: ReviewRequest): ReviewToolset => ({
    proposeWrite: (proposal) =>
      deps.gate.applyUnattended({ ...proposal, provenance: req.provenance }),
    readContext: (query) =>
      Effect.gen(function* () {
        const idx = query.indexOf(":")
        if (idx < 0) {
          return yield* Effect.fail(
            new ReviewReadError({ reason: `query must be "<namespace>:<key>", got ${JSON.stringify(query)}` })
          )
        }
        const namespace = query.slice(0, idx) as KvNamespace
        const key = query.slice(idx + 1)
        if (namespace !== "profile" && namespace !== "environment" && namespace !== "skills") {
          return yield* Effect.fail(new ReviewReadError({ reason: `unknown namespace ${JSON.stringify(namespace)}` }))
        }
        if (key.length === 0) {
          return yield* Effect.fail(new ReviewReadError({ reason: "key must be non-empty" }))
        }
        const value = yield* deps.memory.get(namespace, key).pipe(
          Effect.catch((e) =>
            Effect.fail(new ReviewReadError({ reason: `memory read failed: ${e._tag}: ${e.reason}` }))
          )
        )
        if (value === undefined || value === null) return `${namespace}:${key} — not set`
        const text = JSON.stringify(value) ?? "?"
        return text.length > 500 ? `${text.slice(0, 500)}…` : text
      })
  })

  /**
   * Render a worker failure for the outcome record. The typed
   * `ReviewWorkerError` carries the actionable reason; anything else
   * (defects) falls back to the full pretty-printed cause.
   */
  const describeWorkerFailure = (cause: Cause.Cause<ReviewWorkerError>): string => {
    const err = Cause.findErrorOption(cause)
    if (Option.isSome(err)) return `ReviewWorkerError: ${err.value.reason}`
    return Cause.pretty(cause)
  }

  const runFork = (req: ReviewRequest, handle: ReviewForkHandle): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const toolset = makeToolset(req)
      const exit = yield* Effect.exit(deps.worker(req.snapshot, toolset))
      // Cancelled by a live turn (or replaced): record NOTHING, do NOTHING
      // more. Post-cancel side effects are impossible by construction —
      // this fiber performs no further effects after this point.
      if (yield* Deferred.isDone(handle.cancelled)) return
      if (exit._tag === "Success") {
        const provenance: WriteProvenance = req.provenance
        yield* recordOutcome(req.sessionId, {
          _tag: "Completed",
          proposals: exit.value.proposals.map((p) => ({ ...p, provenance })),
          dispositions: exit.value.dispositions
        })
      } else {
        yield* recordOutcome(req.sessionId, {
          _tag: "WorkerFailed",
          reason: describeWorkerFailure(exit.cause)
        })
      }
      // Done: drop our own handle if it is still current (a live turn or a
      // replacement already removed cancelled/superseded handles).
      yield* Ref.update(inFlightRef, (m) => {
        if (m.get(req.sessionId) !== handle) return m
        const next = new Map(m)
        next.delete(req.sessionId)
        return next
      })
    })

  return {
    spawnReview: (req) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(inFlightRef)).get(req.sessionId)
        if (existing !== undefined) {
          // Newest-wins: retire the old fork without blocking the spawn.
          // The old fork's cancel handshake runs supervised; the new fork
          // starts immediately.
          yield* Ref.update(
            inFlightRef,
            (m) => {
              const next = new Map(m)
              next.delete(req.sessionId)
              return next
            }
          )
          yield* Effect.forkIn(cancelWithAck(existing, deps.ackDeadlineMs), deps.forkScope)
        }
        const cancelled = yield* Deferred.make<void>()
        // The child must observe its own handle (for the cancellation
        // flag): publish it through a Deferred so there is no race between
        // the fork and the handle's creation.
        const handleDeferred = yield* Deferred.make<ReviewForkHandle>()
        const fiber = yield* Effect.forkIn(
          Deferred.await(handleDeferred).pipe(Effect.andThen((h) => runFork(req, h))),
          deps.forkScope
        )
        const handle: ReviewForkHandle = {
          fiber,
          sessionId: req.sessionId,
          startedAt: Date.now(),
          cancelled
        }
        yield* Deferred.succeed(handleDeferred, handle)
        yield* Ref.update(inFlightRef, (m) => new Map(m).set(req.sessionId, handle))
      }),

    noteLiveTurn: (sessionId) =>
      Effect.gen(function* () {
        const handle = (yield* Ref.get(inFlightRef)).get(sessionId)
        if (handle === undefined) return { _tag: "NoReview" } as CancelAck
        yield* Ref.update(inFlightRef, (m) => {
          const next = new Map(m)
          next.delete(sessionId)
          return next
        })
        return yield* cancelWithAck(handle, deps.ackDeadlineMs)
      }),

    inFlight: (sessionId) =>
      Ref.get(inFlightRef).pipe(Effect.map((m) => Option.fromUndefinedOr(m.get(sessionId)))),

    lastOutcome: (sessionId) =>
      Ref.get(outcomesRef).pipe(Effect.map((m) => Option.fromUndefinedOr(m.get(sessionId))))
  }
}

/**
 * Build the `ReviewForks` layer. Review fibers are supervised in a
 * layer-lifetime scope: they die with the layer, never leak past it.
 * Requirements are additive: `UnattendedWriteGate` (write disposal),
 * `InferencePool` (the default aux-digest worker's lane), and
 * `MemoryService` (the toolset's `readContext`). Pass `opts.worker` to run
 * a custom worker — the pool is still required by the layer shape, but an
 * unused pool (no providers) is a valid zero-socket construction.
 */
export const layerReviewForks = (opts?: ReviewForksOpts): Layer.Layer<ReviewForks, never, UnattendedWriteGate | InferencePool | MemoryService> =>
  Layer.effect(
    ReviewForks,
    Effect.gen(function* () {
      const gate = yield* UnattendedWriteGate
      const memory = yield* MemoryService
      const pool = yield* InferencePool
      const ackDeadlineMs = opts?.ackDeadlineMs ?? DEFAULT_LEARNING_CONFIG.ackDeadlineMs
      const digestCharBudget = opts?.digestCharBudget ?? DEFAULT_LEARNING_CONFIG.digestCharBudget
      // Layer-lifetime supervision scope: review fibers are children of the
      // layer, so teardown of the layer cancels every in-flight review.
      const forkScope = yield* Effect.acquireRelease(
        Scope.make(),
        (scope, exit) => Scope.close(scope, exit)
      )
      const worker = opts?.worker ?? makeAuxDigestWorker(pool, digestCharBudget)
      const inFlightRef = yield* Ref.make(new Map<string, ReviewForkHandle>())
      const outcomesRef = yield* Ref.make(new Map<string, ForkOutcome>())
      return makeService({ gate, memory, worker, ackDeadlineMs, forkScope, inFlightRef, outcomesRef })
    })
  )
