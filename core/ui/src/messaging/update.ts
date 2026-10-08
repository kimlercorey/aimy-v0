/**
 * ui/src/messaging/update.ts — pure update for the messaging slice.
 *
 * The wizard state machine: each `*Requested`/`*Submitted` message answers
 * with its command (busy while in flight); each outcome message advances or
 * reports. `draftToken` is cleared the moment validation is submitted — the
 * token is never held in the model longer than the round-trip.
 */
import * as Update from "foldkit/update"

import { Message } from "./messages.js"
import { initialModel, type Model } from "./model.js"
import { MessagingIpc } from "./seam.js"
import {
  CheckPairing,
  IssueCode,
  RefreshStatus,
  SaveForwarding,
  SendTest,
  ValidateToken,
} from "./commands.js"

export type MessagingResources = MessagingIpc
export type MessagingUpdateReturn = Update.Return<Model, Message, MessagingResources>

const idle = (model: Model): Model => ({
  ...initialModel(),
  status: model.status,
  forwardingKinds: model.status?.forwardingKinds ?? [],
})

export const update = (model: Model, message: Message): MessagingUpdateReturn =>
  Message.match<MessagingUpdateReturn>(message, {
    StatusRequested: () => ({
      model: { ...model, busy: true, statusError: undefined },
      commands: [RefreshStatus({})],
    }),

    StatusReceived: ({ configured, botUsername, paired, forwardingKinds }) => ({
      model: {
        ...model,
        busy: false,
        status: { configured, botUsername, paired, forwardingKinds: [...forwardingKinds] },
        forwardingKinds: [...forwardingKinds],
      },
    }),

    StatusFailed: ({ reason }) => ({
      model: { ...model, busy: false, statusError: reason },
    }),

    WizardStarted: () => ({ model: { ...idle(model), step: "token" } }),

    WizardCancelled: () => ({ model: idle(model) }),

    TokenDraftChanged: ({ token }) => ({
      model: { ...model, draftToken: token },
    }),

    TokenSubmitted: ({ token }) => {
      const clean = token.trim()
      if (clean === "") {
        return {
          model: { ...model, tokenError: "Paste the token from @BotFather first." },
        }
      }
      // The draft is cleared on submit — never rendered back, never retained.
      return {
        model: { ...model, draftToken: "", step: "validating", busy: true, tokenError: undefined },
        commands: [ValidateToken({ token: clean })],
      }
    },

    TokenValidated: ({ botUsername }) => ({
      model: { ...model, step: "code", busy: true, botUsername },
      commands: [IssueCode({})],
    }),

    TokenFailed: ({ reason }) => ({
      model: { ...model, step: "token", busy: false, tokenError: reason },
    }),

    CodeIssued: ({ code, expiresAt }) => ({
      model: {
        ...model,
        busy: false,
        step: "pairing",
        pairingCode: code,
        pairingExpiresAt: expiresAt,
        pairingError: undefined,
      },
    }),

    CodeFailed: ({ reason }) => ({
      model: { ...model, busy: false, step: "token", tokenError: reason },
    }),

    PairingCheckRequested: () => ({
      model: { ...model, busy: true, pairingError: undefined },
      commands: [CheckPairing({})],
    }),

    PairingPaired: () => ({
      model: { ...model, busy: false, step: "prefs", pairingCode: undefined },
    }),

    PairingWaiting: () => ({ model: { ...model, busy: false } }),

    PairingFailed: ({ reason }) => ({
      model: { ...model, busy: false, pairingError: reason },
    }),

    ForwardingKindToggled: ({ kind }) => ({
      model: {
        ...model,
        forwardingKinds: model.forwardingKinds.includes(kind)
          ? model.forwardingKinds.filter((k) => k !== kind)
          : [...model.forwardingKinds, kind],
      },
    }),

    ForwardingSubmitRequested: () => ({
      model: { ...model, busy: true, forwardingError: undefined },
      commands: [SaveForwarding({ kinds: [...model.forwardingKinds] })],
    }),

    ForwardingSaved: () => ({
      model: { ...model, step: "testing", busy: true, forwardingError: undefined },
      commands: [SendTest({})],
    }),

    ForwardingFailed: ({ reason }) => ({
      model: { ...model, forwardingError: reason },
    }),

    TestRequested: () => ({
      model: { ...model, busy: true, testError: undefined },
      commands: [SendTest({})],
    }),

    TestSucceeded: () => ({ model: { ...model, busy: false, step: "done" } }),

    TestFailed: ({ reason }) => ({
      model: { ...model, busy: false, testError: reason },
    }),
  })

export { initialModel }
