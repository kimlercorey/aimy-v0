/**
 * onboarding/index.ts — the onboarding slice's public surface.
 */
export {
  buildInitialConfig,
  initialModel,
  InitialConfigSchema,
  Model,
  OnboardingStep,
  sovereigntyDefaultsSummary,
  SPLASH_DEFAULT_ENDPOINT
} from "./model.js"
export type {
  InitialConfig,
  Model as OnboardingModel,
  OnboardingStep as OnboardingStepT
} from "./model.js"
export { ApplyInitialConfig } from "./commands.js"
export { Message } from "./messages.js"
export type { Message as OnboardingMessage } from "./messages.js"
export { OnboardingError, OnboardingPersistence, OnboardingPersistenceUnwired } from "./seam.js"
export type { OnboardingPersistenceShape } from "./seam.js"
export { update } from "./update.js"
export { view } from "./view.js"
