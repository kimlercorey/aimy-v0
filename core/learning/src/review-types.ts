/**
 * review-types.ts — shared types for M6 Track 1: background-review forks +
 * unattended-write safety (architecture §3.5, §3.7).
 *
 * Lifecycle state and outcome records are separate types (Hermes #68499):
 * a fork's *lifecycle* (spawned → running → cancelled) is the fiber; its
 * *outcome* is `ForkOutcome`, recorded on completion only.
 */
import type { KvNamespace } from "../../memory/index.js"
import type { WriteProvenance } from "./provenance.js"

/**
 * One reviewer proposal as parsed from the aux model's JSON-lines output.
 * Provenance is NOT model-supplied — the fork runner attaches the request's
 * provenance when the proposal reaches the write gate, so a reviewer can
 * never forge attribution.
 */
export interface RawProposal {
  readonly kind: "add" | "replace" | "remove"
  readonly namespace: KvNamespace
  readonly key: string
  /** Absent for `remove`. */
  readonly value?: unknown
  /** Why this is worth remembering — surfaced on the learning timeline. */
  readonly reason: string
}

/** A proposal with the request's provenance attached, ready for the gate. */
export interface ReviewProposal extends RawProposal {
  readonly provenance: WriteProvenance
}

/** How an unattended write was disposed (architecture §3.7). */
export type WriteDisposition =
  | { readonly _tag: "Applied"; readonly namespace: KvNamespace; readonly key: string }
  | {
      readonly _tag: "Staged"
      readonly pendingId: string
      readonly kind: "replace" | "remove"
      readonly namespace: KvNamespace
      readonly key: string
    }
  | { readonly _tag: "Denied"; readonly reason: string }

/**
 * Outcome record of one review fork run — not its lifecycle state.
 * `Cancelled` forks record nothing: post-cancel side effects are impossible
 * by construction (the fiber is dead; see forks.ts).
 */
export type ForkOutcome =
  | {
      readonly _tag: "Completed"
      readonly proposals: ReadonlyArray<ReviewProposal>
      readonly dispositions: ReadonlyArray<WriteDisposition>
    }
  | { readonly _tag: "ParseFailed"; readonly reason: string; readonly line: string }
  | { readonly _tag: "WorkerFailed"; readonly reason: string }

/** A review of one finished turn. */
export interface ReviewRequest {
  readonly sessionId: string
  readonly snapshot: import("./snapshot.js").ConversationSnapshot
  /**
   * `user-invoked` refinement never defers and never waits for idle
   * (architecture §3.5: explicit `/refine` never defers).
   */
  readonly mode: "background" | "user-invoked"
  /** Attached to every proposal this review produces. */
  readonly provenance: WriteProvenance
}

/**
 * Result of the bounded-cancel handshake when a live turn preempts a
 * review (architecture §3.5): the fork acknowledged in time, it did not
 * (the live turn proceeds anyway — the fork never blocks the user), or
 * there was no review in flight.
 */
export type CancelAck =
  | { readonly _tag: "NoReview" }
  | { readonly _tag: "Acked" }
  | { readonly _tag: "Timeout" }

/** Track 1 configuration. Defaults are the architecture's reference values. */
export interface LearningConfig {
  /** Bounded-cancel handshake deadline (architecture §3.5: 2s reference). */
  readonly ackDeadlineMs: number
  /** Char budget for the compact digest replayed to the aux model. */
  readonly digestCharBudget: number
  /** Idle-gated scheduling: continuous-idle window before a queued review runs. */
  readonly settleWindowMs: number
  /** Queued reviews older than this are dropped, never run stale. */
  readonly maxAgeMs: number
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  ackDeadlineMs: 2000,
  digestCharBudget: 4000,
  settleWindowMs: 15_000,
  maxAgeMs: 30 * 60 * 1000
}
