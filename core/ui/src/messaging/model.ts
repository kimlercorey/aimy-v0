/**
 * ui/src/messaging/model.ts — Schema Model for the messaging panel.
 *
 * `step` is the wizard state machine. `draftToken` holds the pasted token
 * only until validation (the view clears it on submit — the token is never
 * rendered back). `status` is the last known main-process state.
 */
import { Schema } from "effect"

export const WizardStep = Schema.Literals([
  "idle",
  "token",
  "validating",
  "code",
  "pairing",
  "prefs",
  "testing",
  "done",
])
export type WizardStep = typeof WizardStep.Type

export const MessagingStatusSchema = Schema.Struct({
  configured: Schema.Boolean,
  botUsername: Schema.optional(Schema.String),
  paired: Schema.Boolean,
  forwardingKinds: Schema.Array(Schema.String),
})
export type MessagingStatusShape = typeof MessagingStatusSchema.Type

export const Model = Schema.Struct({
  step: WizardStep,
  status: Schema.optional(MessagingStatusSchema),
  statusError: Schema.optional(Schema.String),
  draftToken: Schema.String,
  tokenError: Schema.optional(Schema.String),
  botUsername: Schema.optional(Schema.String),
  pairingCode: Schema.optional(Schema.String),
  pairingExpiresAt: Schema.optional(Schema.String),
  pairingError: Schema.optional(Schema.String),
  forwardingKinds: Schema.Array(Schema.String),
  forwardingError: Schema.optional(Schema.String),
  testError: Schema.optional(Schema.String),
  busy: Schema.Boolean,
})
export type Model = typeof Model.Type

export const initialModel = (): Model => ({
  step: "idle",
  draftToken: "",
  forwardingKinds: [],
  busy: false,
})

export const SEVERITY_KINDS = ["info", "success", "warning", "critical"] as const
