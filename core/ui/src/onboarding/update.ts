/**
 * onboarding/update.ts — the first-run state machine, pure.
 *
 * done is terminal: from there the only moves are replay (out of scope for
 * the slice) — the shell owns what happens after. Skipping lands on done
 * with `skipped: true` and emits no persistence command: the preference is
 * recorded, nothing is applied behind the user's back.
 */
import type { Return as UpdateReturn } from "foldkit/update"

import { ApplyInitialConfig } from "./commands.js"
import { OnboardingPersistence } from "./seam.js"
import { Message } from "./messages.js"
import { buildInitialConfig, type Model, type OnboardingStep } from "./model.js"

type Return = UpdateReturn<Model, Message, OnboardingPersistence>

const NEXT: Record<Exclude<OnboardingStep, "done" | "sovereigntyDefaults">, OnboardingStep> = {
  welcome: "identitySetup",
  identitySetup: "modelEndpoint",
  modelEndpoint: "sovereigntyDefaults"
}

const PREV: Record<Exclude<OnboardingStep, "welcome" | "done">, OnboardingStep> = {
  identitySetup: "welcome",
  modelEndpoint: "identitySetup",
  sovereigntyDefaults: "modelEndpoint"
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    OnboardingAdvanced: () => {
      if (model.step === "done" || model.step === "sovereigntyDefaults") return { model }
      const next = NEXT[model.step]
      return { model: { ...model, step: next } }
    },
    OnboardingBack: () => {
      if (model.step === "welcome" || model.step === "done") return { model }
      return { model: { ...model, step: PREV[model.step] } }
    },
    OnboardingSkipped: () => ({
      model: { ...model, step: "done", skipped: true }
    }),
    OnboardingDisplayNameSet: ({ displayName }) => ({
      model: { ...model, displayName }
    }),
    OnboardingEndpointSet: ({ baseUrl }) => ({
      model: { ...model, endpointBaseUrl: baseUrl }
    }),
    OnboardingSovereigntyConfirmed: () => {
      if (model.step !== "sovereigntyDefaults") return { model }
      const config = buildInitialConfig(model)
      return {
        model: { ...model, step: "done", sovereigntyConfirmed: true, persistError: undefined },
        commands: [ApplyInitialConfig({ config })]
      }
    },
    OnboardingConfigApplied: () => ({ model }),
    OnboardingApplyFailed: ({ reason }) => ({
      model: { ...model, persistError: reason }
    })
  })
