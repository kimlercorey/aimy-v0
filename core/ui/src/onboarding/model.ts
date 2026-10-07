/**
 * onboarding/model.ts — Schema Model slice for the first-run flow.
 *
 * §3.10: the "it was there" moment — welcome → identity setup → local model
 * endpoint → sovereignty defaults → done. Skippable at any point; skipping is
 * a recorded preference, not a dark pattern. Completion produces the initial
 * Model configuration via `buildInitialConfig` (pure).
 */
import { Schema } from "effect"

import {
  INVENTORY,
  Model as SovereigntyModelSchema,
  initialModel as initialSovereignty,
  type Model as SovereigntyModel
} from "../sovereignty/model.js"

export const OnboardingStep = Schema.Literals([
  "welcome",
  "identitySetup",
  "modelEndpoint",
  "sovereigntyDefaults",
  "done"
])
export type OnboardingStep = typeof OnboardingStep.Type

export const Model = Schema.Struct({
  step: OnboardingStep,
  skipped: Schema.Boolean,
  displayName: Schema.optional(Schema.String),
  endpointBaseUrl: Schema.optional(Schema.String),
  sovereigntyConfirmed: Schema.Boolean,
  persistError: Schema.optional(Schema.String)
})
export type Model = typeof Model.Type

/** Kimler's local model server; the default the endpoint step offers. */
export const SPLASH_DEFAULT_ENDPOINT = "http://127.0.0.1:8000"

export const InitialConfigSchema = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  endpointBaseUrl: Schema.String,
  sovereignty: SovereigntyModelSchema
})
export type InitialConfig = typeof InitialConfigSchema.Type

export const initialModel = (): Model => ({
  step: "welcome",
  skipped: false,
  sovereigntyConfirmed: false
})

/** The initial configuration completion produces — pure, testable. */
export const buildInitialConfig = (model: Model): InitialConfig => ({
  displayName: model.displayName,
  endpointBaseUrl:
    model.endpointBaseUrl !== undefined && model.endpointBaseUrl.trim().length > 0
      ? model.endpointBaseUrl
      : SPLASH_DEFAULT_ENDPOINT,
  sovereignty: initialSovereignty()
})

export interface DefaultSummaryRow {
  readonly label: string
  readonly state: "on" | "off" | "absent"
  readonly statedDataFlow: string
}

/** The sovereignty defaults the flow walks visibly: everything off except local inference. */
export const sovereigntyDefaultsSummary = (): ReadonlyArray<DefaultSummaryRow> =>
  INVENTORY.map((row) => ({
    label: row.label,
    state: row.kind === "absent" ? ("absent" as const) : row.classId === "localInference" ? ("on" as const) : ("off" as const),
    statedDataFlow: row.statedDataFlow
  }))

export type { SovereigntyModel }
