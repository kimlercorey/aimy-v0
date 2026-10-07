/**
 * onboarding/seam.ts — the shell-provided persistence for the initial config.
 *
 * The slice computes the configuration (pure); the shell writes it — identity
 * document display name, local endpoint, sovereignty defaults — through the
 * real services. Unwired default fails closed.
 */
import { Context, Data, Effect } from "effect"

import type { InitialConfig } from "./model.js"

export class OnboardingError extends Data.TaggedError("OnboardingError")<{
  readonly reason: string
}> {}

export interface OnboardingPersistenceShape {
  /** Persist the initial configuration through the real services. */
  readonly apply: (config: InitialConfig) => Effect.Effect<void, OnboardingError>
}

export class OnboardingPersistence extends Context.Service<
  OnboardingPersistence,
  OnboardingPersistenceShape
>()("aimy/ui/OnboardingPersistence") {}

/** Fail-closed default: no persistence wired, no config claimed applied. */
export const OnboardingPersistenceUnwired: OnboardingPersistenceShape = {
  apply: (_config: InitialConfig): Effect.Effect<void, OnboardingError> =>
    Effect.fail(new OnboardingError({ reason: "onboarding:persistence-not-wired" }))
}
