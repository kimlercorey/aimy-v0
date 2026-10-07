/**
 * onboarding/messages.ts — each onboarding step is a Message; the whole flow
 * is replayable in DevTools (§3.10).
 */
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

import { InitialConfigSchema } from "./model.js"

export const Message = defineMessageUnion({
  OnboardingAdvanced: {},
  OnboardingBack: {},
  OnboardingSkipped: {},
  OnboardingDisplayNameSet: { displayName: Schema.String },
  OnboardingEndpointSet: { baseUrl: Schema.String },
  OnboardingSovereigntyConfirmed: {},
  OnboardingConfigApplied: { config: InitialConfigSchema },
  OnboardingApplyFailed: { reason: Schema.String }
})
export type Message = typeof Message.Type
