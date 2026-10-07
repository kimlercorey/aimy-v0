/**
 * onboarding/commands.ts — the ApplyInitialConfig command.
 */
import { Effect, Schema } from "effect"
import * as Command from "foldkit/command"

import { InitialConfigSchema } from "./model.js"
import { Message } from "./messages.js"
import { OnboardingPersistence } from "./seam.js"

export const ApplyInitialConfig = Command.define("ApplyInitialConfig", {
  args: { config: InitialConfigSchema },
  messages: [Message.OnboardingConfigApplied, Message.OnboardingApplyFailed],
  execute: ({ config }) =>
    Effect.match(Effect.flatMap(OnboardingPersistence, (persistence) => persistence.apply(config)), {
      onFailure: (error) => Message.OnboardingApplyFailed({ reason: error.reason }),
      onSuccess: () => Message.OnboardingConfigApplied({ config })
    })
})
