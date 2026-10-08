/**
 * ui/src/messaging/messages.ts — the messaging slice's Message vocabulary.
 *
 * The wizard is a linear state machine driven by the renderer:
 * idle → token → validating → code → pairing → prefs → testing → done.
 * Each IPC round-trip lands as a `*Completed` / `*Failed` message; the view
 * is pure and only renders the current step.
 */
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

export const Message = defineMessageUnion({
  /** Panel opened / refresh requested: read status from main. */
  StatusRequested: {},
  StatusReceived: {
    configured: Schema.Boolean,
    botUsername: Schema.optional(Schema.String),
    paired: Schema.Boolean,
    forwardingKinds: Schema.Array(Schema.String),
  },
  StatusFailed: { reason: Schema.String },

  /** Wizard step 1: token pasted. */
  TokenDraftChanged: { token: Schema.String },
  TokenSubmitted: { token: Schema.String },
  TokenValidated: { botUsername: Schema.String },
  TokenFailed: { reason: Schema.String },

  /** Wizard step 2: pairing code issued. */
  CodeIssued: { code: Schema.String, expiresAt: Schema.String },
  CodeFailed: { reason: Schema.String },
  PairingCheckRequested: {},
  PairingPaired: {},
  PairingWaiting: {},
  PairingFailed: { reason: Schema.String },

  /** Wizard step 3: forwarding prefs. */
  ForwardingKindToggled: { kind: Schema.String },
  ForwardingSubmitRequested: {},
  ForwardingSaved: { kinds: Schema.Array(Schema.String) },
  ForwardingFailed: { reason: Schema.String },

  /** Wizard step 4: test message. */
  TestRequested: {},
  TestSucceeded: {},
  TestFailed: { reason: Schema.String },

  /** Leave the wizard (back to status). */
  WizardCancelled: {},
  WizardStarted: {},
})
export type Message = typeof Message.Type
