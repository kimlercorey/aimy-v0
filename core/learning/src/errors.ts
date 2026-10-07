/**
 * learning/errors.ts — the typed error taxonomy for the learning-loop library.
 *
 * Contract (substrate/errors.ts): every error is an Effect `Data.TaggedError`
 * and is NEVER thrown across library boundaries.
 */
import { Data } from "effect"

/** No timeline node with this id exists in the store. */
export class NodeNotFound extends Data.TaggedError("NodeNotFound")<{
  readonly nodeId: string
}> {}

/** `archiveNode` was called on a node that is already archived (delete is idempotent-free by design). */
export class NodeAlreadyArchived extends Data.TaggedError("NodeAlreadyArchived")<{
  readonly nodeId: string
}> {}

/** `restoreNode` was called on a node that is not archived. */
export class NodeNotArchived extends Data.TaggedError("NodeNotArchived")<{
  readonly nodeId: string
}> {}

/** An event payload was not JSON-serializable (cycle, function, or symbol). */
export class UnserializablePayload extends Data.TaggedError("UnserializablePayload")<{
  readonly reason: string
}> {}

/** The underlying timeline/avoidance store failed (reserved for the durable store seam). */
export class LearningStoreError extends Data.TaggedError("LearningStoreError")<{
  readonly operation: string
  readonly reason: string
}> {}

/** No avoidance rule with this id exists in the store. */
export class AvoidanceNotFound extends Data.TaggedError("AvoidanceNotFound")<{
  readonly ruleId: string
}> {}

/** The union of every typed error raised by the learning library. */
export type LearningError =
  | NodeNotFound
  | NodeAlreadyArchived
  | NodeNotArchived
  | UnserializablePayload
  | LearningStoreError
  | AvoidanceNotFound
