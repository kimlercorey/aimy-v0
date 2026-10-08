/**
 * deep-research/errors.ts — typed failures for the deep-research module.
 *
 * Same convention as web-retrieval: every failure crossing the module
 * boundary is a tagged error, never an untyped throw (architecture §1.4).
 */
import { Data } from "effect"

/** The planner model call failed (transport, timeout, provider error). */
export class PlanError extends Data.TaggedError("PlanError")<{
  readonly reason: string
}> {}

/**
 * The planner answered but its output was not usable JSON matching the plan
 * schema. Distinct from PlanError: the model ran, but we couldn't understand
 * it. The flow falls back to the single-query plan (logged, not hidden).
 */
export class MalformedPlan extends Data.TaggedError("MalformedPlan")<{
  readonly reason: string
  readonly raw: string
}> {}

/** A search in the fan-out failed; the sub-question is dropped with its reason recorded. */
export class FanOutSearchError extends Data.TaggedError("FanOutSearchError")<{
  readonly subQuestion: string
  readonly reason: string
}> {}

/** A fetch in the read stage failed; recorded in coverage, never silent. */
export class ReadError extends Data.TaggedError("ReadError")<{
  readonly url: string
  readonly reason: string
}> {}

/** Invalid research.query arguments (empty query, bad depth). Fail-fast: no plan, no search. */
export class InvalidResearchArgs extends Data.TaggedError("InvalidResearchArgs")<{
  readonly reason: string
}> {}

export type DeepResearchError =
  | PlanError
  | MalformedPlan
  | FanOutSearchError
  | ReadError
  | InvalidResearchArgs
