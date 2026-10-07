/**
 * onboarding/view.ts — the "it was there" first-run flow.
 *
 * Copy is tight and warm: the flow should feel inevitable, not wizard-y.
 * Every step offers the skip — skipping is a recorded preference, not a
 * dark pattern.
 */
import type { Html, HtmlBuilder } from "foldkit/html"

import { Message } from "./messages.js"
import {
  sovereigntyDefaultsSummary,
  SPLASH_DEFAULT_ENDPOINT,
  type Model
} from "./model.js"

type H = HtmlBuilder<Message>

const skipLink = (h: H): Html =>
  h.button([h.OnClick(Message.OnboardingSkipped()), h.Class("link")], ["Skip for now"])

const navRow = (h: H, canGoBack: boolean, continueLabel: string, onContinue: ReturnType<typeof Message.OnboardingAdvanced>): Html =>
  h.div([h.Class("row")], [
    ...(canGoBack ? [h.button([h.OnClick(Message.OnboardingBack())], ["Back"])] : []),
    h.button([h.OnClick(onContinue), h.Class("primary")], [continueLabel]),
    skipLink(h)
  ])

const stepView = (model: Model, h: H): Html => {
  switch (model.step) {
    case "welcome":
      return h.section([h.Class("ob-step")], [
        h.h2([], ["AImy is yours."]),
        h.p([], [
          "It runs on your machine, learns what you show it, and forgets what you take away."
        ]),
        h.p([], ["Two minutes, then it's there."]),
        navRow(h, false, "Begin", Message.OnboardingAdvanced())
      ])
    case "identitySetup":
      return h.section([h.Class("ob-step")], [
        h.h2([], ["What should AImy call you?"]),
        h.input([
          h.Type("text"),
          h.Placeholder("Your name"),
          h.Value(model.displayName ?? ""),
          h.OnInput((displayName) => Message.OnboardingDisplayNameSet({ displayName }))
        ]),
        h.p([h.Class("note")], ["This becomes your install identity's display name. It never leaves this machine."]),
        navRow(h, true, "Continue", Message.OnboardingAdvanced())
      ])
    case "modelEndpoint":
      return h.section([h.Class("ob-step")], [
        h.h2([], ["Point AImy at your local model."]),
        h.input([
          h.Type("text"),
          h.Placeholder(SPLASH_DEFAULT_ENDPOINT),
          h.Value(model.endpointBaseUrl ?? ""),
          h.OnInput((baseUrl) => Message.OnboardingEndpointSet({ baseUrl }))
        ]),
        h.p([h.Class("note")], [
          "Your model runs on your hardware — Splash, Ollama, LM Studio, anything OpenAI-compatible. No cloud."
        ]),
        navRow(h, true, "Continue", Message.OnboardingAdvanced())
      ])
    case "sovereigntyDefaults":
      return h.section([h.Class("ob-step")], [
        h.h2([], ["Everything stays home unless you say so."]),
        h.p([], ["The defaults, stated plainly — change any of them later in the Sovereignty panel."]),
        h.ul(
          [],
          sovereigntyDefaultsSummary().map((row) =>
            h.li(
              [],
              [
                `${row.label}: `,
                h.strong([], [row.state === "absent" ? "does not exist" : row.state === "on" ? "on" : "off"])
              ]
            )
          )
        ),
        h.div([h.Class("row")], [
          h.button([h.OnClick(Message.OnboardingBack())], ["Back"]),
          h.button(
            [h.OnClick(Message.OnboardingSovereigntyConfirmed()), h.Class("primary")],
            ["These are my defaults"]
          ),
          skipLink(h)
        ])
      ])
    case "done":
      if (model.skipped) {
        return h.section([h.Class("ob-step")], [
          h.h2([], ["No problem."]),
          h.p([], ["Everything kept its defaults. You can run this again any time."])
        ])
      }
      return h.section([h.Class("ob-step")], [
        h.h2([], ["It was there."]),
        h.p([], [
          "AImy has an identity",
          ...(model.displayName !== undefined && model.displayName.length > 0
            ? [` — hello, ${model.displayName}`]
            : []),
          ", a local model, and its defaults."
        ]),
        h.p([], [
          "Now show it a folder and watch the timeline: you'll see exactly what it learned, where it lives, and the archive button right beside it."
        ]),
        ...(model.persistError !== undefined
          ? [h.p([h.Class("error-reason")], [`Couldn't save the setup: ${model.persistError}`])]
          : [])
      ])
  }
}

export const view = (model: Model, h: H): Html =>
  h.main([h.Class("onboarding")], [stepView(model, h)])
