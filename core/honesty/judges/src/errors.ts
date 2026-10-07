/**
 * honesty/judges/errors.ts
 *
 * Typed errors for the judges library. Every error is an Effect
 * `Data.TaggedError` and is NEVER thrown across library boundaries
 * (substrate convention: "must never throw").
 */
import { Data } from "effect"

/** A judge id, or a version/range of a known id, could not be resolved. */
export class JudgeNotFound extends Data.TaggedError("JudgeNotFound")<{
  readonly judgeId: string
  /** The requested version/range, when the id exists but the version does not. */
  readonly requestedVersion?: string
  readonly reason: string
}> {}

/** A JudgeInput failed structural validation (checked before any judge runs). */
export class JudgeInputInvalid extends Data.TaggedError("JudgeInputInvalid")<{
  /** Dotted path to the offending field, e.g. "sideEffects[2].outcome". */
  readonly path: string
  readonly reason: string
}> {}

/** A judge's `run` threw instead of returning a verdict (purity violation). */
export class JudgeThrew extends Data.TaggedError("JudgeThrew")<{
  readonly judgeId: string
  readonly judgeVersion: string
  readonly reason: string
}> {}

/**
 * A judge returned a verdict that fails the integrity contract:
 * wrong/missing verdictId, wrong judgeId/version, wrong taskId, or a
 * non-conforming verdict payload. Verdicts that fail this check are
 * discarded, never stored.
 */
export class JudgeVerdictInvalid extends Data.TaggedError("JudgeVerdictInvalid")<{
  readonly judgeId: string
  readonly judgeVersion: string
  readonly reason: string
}> {}
