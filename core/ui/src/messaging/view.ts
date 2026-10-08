/**
 * ui/src/messaging/view.ts — the messaging panel: status + stepped wizard.
 *
 * Pure function of the slice model. The wizard walks the user through the
 * same steps as the CLI wizard: BotFather token → validate → pairing code →
 * forwarding prefs → test message. The token input is a password field and
 * the draft is cleared from the model on submit.
 */
import type { Html, HtmlBuilder } from "foldkit/html"

import { Message } from "./messages.js"
import { SEVERITY_KINDS, type Model } from "./model.js"

type H = HtmlBuilder<Message>

const errorLine = (h: H, reason: string | undefined): ReadonlyArray<Html> =>
  reason === undefined ? [] : [h.p([h.Class("wz-error")], [reason])]

const stepHeader = (h: H, n: string, title: string, lede: string): Html =>
  h.header([h.Class("wz-step-head")], [
    h.span([h.Class("wz-step-n")], [n]),
    h.h3([], [title]),
    h.p([h.Class("lede")], [lede]),
  ])

const statusView = (h: H, model: Model): Html => {
  const s = model.status
  if (s === undefined) {
    return h.div([h.Class("msg-status")], [
      h.p([], ["Status unknown."]),
      h.button([h.OnClick(Message.StatusRequested({}))], ["Refresh status"]),
      ...errorLine(h, model.statusError),
    ])
  }
  return h.div([h.Class("msg-status")], [
    h.p([], [
      s.configured
        ? `Bot ${s.botUsername ?? "configured"} — token in the secret locker.`
        : "No bot configured.",
    ]),
    h.p([], [s.paired ? "Paired chat: connected." : "No paired chat."]),
    h.p([], [`Forwarding: ${s.forwardingKinds.length > 0 ? s.forwardingKinds.join(", ") : "off"}`]),
    h.div([h.Class("wz-actions")], [
      h.button([h.OnClick(Message.WizardStarted({}))], [
        s.configured ? "Re-run setup" : "Set up Telegram",
      ]),
      h.button([h.OnClick(Message.StatusRequested({}))], ["Refresh"]),
    ]),
    ...errorLine(h, model.statusError),
  ])
}

const tokenStep = (h: H, model: Model): Html =>
  h.div([h.Class("wz-step")], [
    stepHeader(
      h,
      "1",
      "Create the bot",
      "Talk to @BotFather on Telegram, send /newbot, and paste the token it gives you. The token goes straight to the secret locker — it is never shown again."
    ),
    h.input([
      h.Class("wz-token-input"),
      h.Value(model.draftToken),
      h.Placeholder("Bot token from @BotFather"),
      h.OnInput((value) => Message.TokenDraftChanged({ token: value })),
    ]),
    h.div([h.Class("wz-actions")], [
      h.button(
        [h.OnClick(Message.TokenSubmitted({ token: model.draftToken })), h.Disabled(model.busy)],
        [model.busy ? "Validating…" : "Validate & store"]
      ),
      h.button([h.OnClick(Message.WizardCancelled({}))], ["Cancel"]),
    ]),
    ...errorLine(h, model.tokenError),
  ])

const pairingStep = (h: H, model: Model): Html =>
  h.div([h.Class("wz-step")], [
    stepHeader(
      h,
      "2",
      "Pair your chat",
      "Send exactly these 6 digits to your bot on Telegram, then press the check button. The code expires in 5 minutes."
    ),
    h.div([h.Class("wz-code")], [model.pairingCode ?? "…"]),
    h.div([h.Class("wz-actions")], [
      h.button(
        [h.OnClick(Message.PairingCheckRequested({})), h.Disabled(model.busy)],
        [model.busy ? "Checking…" : "I've sent the code"]
      ),
      h.button([h.OnClick(Message.WizardCancelled({}))], ["Cancel"]),
    ]),
    ...errorLine(h, model.pairingError),
  ])

const prefsStep = (h: H, model: Model): Html =>
  h.div([h.Class("wz-step")], [
    stepHeader(
      h,
      "3",
      "What forwards to Telegram?",
      "Banners matching these severities are forwarded to your paired chat."
    ),
    h.div(
      [h.Class("wz-kinds")],
      SEVERITY_KINDS.map((kind) =>
        h.button(
          [
            h.OnClick(Message.ForwardingKindToggled({ kind })),
            h.Class(model.forwardingKinds.includes(kind) ? "toggle toggle-on" : "toggle toggle-off"),
          ],
          [kind]
        )
      )
    ),
    h.div([h.Class("wz-actions")], [
      h.button(
        [h.OnClick(Message.ForwardingSubmitRequested({})), h.Disabled(model.busy)],
        [model.busy ? "Saving…" : "Save & send test"]
      ),
      h.button([h.OnClick(Message.WizardCancelled({}))], ["Cancel"]),
    ]),
    ...errorLine(h, model.forwardingError),
  ])

const testingStep = (h: H, model: Model): Html =>
  h.div([h.Class("wz-step")], [
    stepHeader(h, "4", "Test message", "Sending a test message to your paired chat…"),
    h.div([h.Class("wz-actions")], [
      h.button([h.OnClick(Message.TestRequested({})), h.Disabled(model.busy)], ["Retry"]),
      h.button([h.OnClick(Message.WizardCancelled({}))], ["Cancel"]),
    ]),
    ...errorLine(h, model.testError),
  ])

const doneStep = (h: H, model: Model): Html =>
  h.div([h.Class("wz-step")], [
    stepHeader(h, "✓", "Gateway live", "Test message delivered. Talk to your bot from your phone — only the paired chat reaches your agent."),
    h.div([h.Class("wz-actions")], [
      h.button([h.OnClick(Message.WizardCancelled({}))], ["Done"]),
    ]),
  ])

const wizardView = (h: H, model: Model): Html => {
  switch (model.step) {
    case "token":
    case "validating":
      return tokenStep(h, model)
    case "code":
    case "pairing":
      return pairingStep(h, model)
    case "prefs":
      return prefsStep(h, model)
    case "testing":
      return testingStep(h, model)
    case "done":
      return doneStep(h, model)
    case "idle":
      return statusView(h, model)
  }
}

/** The messaging panel. Pure: identical model in → identical tree out. */
export const view = (model: Model, h: H): Html =>
  h.main([h.Class("messaging-panel")], [
    h.header([], [
      h.h2([], ["Messaging"]),
      h.p([h.Class("lede")], [
        "Talk to AImy from Telegram. One paired chat per instance; the bot token lives in the secret locker.",
      ]),
    ]),
    wizardView(h, model),
  ])
