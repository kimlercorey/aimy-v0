/**
 * sovereignty/messages.ts — the sovereignty slice's Message vocabulary.
 *
 * Toggle flips are two-step: the view dispatches `ToggleFlipRequested` (pure
 * data — the view cannot stamp time), update answers with the `StampTime`
 * command, and the stamped message carries the ledger timestamp. Offline mode
 * follows the same pattern. `OptInGranted` / `OptInRevoked` are the
 * API-level grants (e.g. the trusted-broadcast subscribe flow); the view's
 * toggle flips record the ledger inline instead.
 */
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

export const Message = defineMessageUnion({
  ToggleFlipRequested: {
    classId: Schema.String,
    targetId: Schema.optional(Schema.String),
    enabled: Schema.Boolean
  },
  ToggleFlipStamped: {
    classId: Schema.String,
    targetId: Schema.optional(Schema.String),
    enabled: Schema.Boolean,
    at: Schema.String
  },
  OfflineModeRequested: { enabled: Schema.Boolean },
  OfflineModeStamped: { enabled: Schema.Boolean, at: Schema.String },
  OptInGranted: {
    classId: Schema.String,
    label: Schema.String,
    statedDataFlow: Schema.String,
    at: Schema.String
  },
  OptInRevoked: { entryId: Schema.String, at: Schema.String },
  /** Outcome of interrupting in-flight egress after a mid-flight toggle-off. */
  EgressInterruptCompleted: {
    classId: Schema.String,
    outcome: Schema.Literals(["Interrupted", "NotFound"])
  },
  /** Produced by the NetworkEgress command's Effect — the boundary's verdict. */
  EgressAllowed: { classId: Schema.String, host: Schema.String },
  EgressDenied: { classId: Schema.String, host: Schema.String, reason: Schema.String }
})
export type Message = typeof Message.Type
