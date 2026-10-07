/**
 * devtools/model.ts — Schema Model slice for the MCP-exposed DevTools.
 *
 * §3.9: the message-timeline view (inspect/history) over the live Model.
 * Gated behind the adversarial-review flag, which defaults OFF. When off,
 * the surface does not exist — messages are rejected by update, not hidden
 * by the view. Timeline entries align with foldkit's devtools protocol
 * (`SerializedEntry`), the same shape the MCP seam speaks.
 *
 * Local-only: the MCP exposure binds to loopback only. `MCP_BIND_HOST` is
 * the literal "127.0.0.1" — never 0.0.0.0 — and the relay shape carries it
 * as a literal type, so a non-loopback bind is a type error.
 */
import { Schema } from "effect"
import { SerializedEntry } from "foldkit/devtools-protocol"

export const MCP_BIND_HOST = "127.0.0.1" as const

export const Model = Schema.Struct({
  /** Adversarial-review gate. Defaults OFF. */
  adversarialReviewEnabled: Schema.Boolean,
  entries: Schema.Array(SerializedEntry),
  selectedIndex: Schema.optional(Schema.Number)
})
export type Model = typeof Model.Type

export const initialModel = (): Model => ({
  adversarialReviewEnabled: false,
  entries: []
})
