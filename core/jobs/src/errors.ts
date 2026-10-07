/**
 * jobs/errors.ts — typed errors for the jobs library.
 *
 * Contract (substrate/errors.ts): every error is an Effect `Data.TaggedError`
 * and is NEVER thrown across library boundaries. These errors are job-scoped;
 * promoting `TierEscalationDenied` to the shared substrate taxonomy is a
 * coordinator decision (other M7 tracks build concurrently).
 */
import { Data } from "effect"

import type { Tier } from "../../substrate/errors.js"

/**
 * A job attempted an action above its inherited tier. Fail-closed: the
 * denial happens BEFORE the action's effect runs, so no side effect occurs.
 */
export class TierEscalationDenied extends Data.TaggedError("TierEscalationDenied")<{
  readonly jobId: string
  readonly grantedTier: Tier
  readonly requestedTier: Tier
  readonly action: string
}> {}

/**
 * A job run crashed or failed. Produced by the supervised run fiber for
 * EVERY non-interruption failure (typed failure or defect) and always
 * written to the job's run history — a failed job is never silent.
 */
export class JobFailed extends Data.TaggedError("JobFailed")<{
  readonly jobId: string
  readonly attempt: number
  readonly reason: string
}> {}

/**
 * A job exhausted its restart budget. The job stops scheduling; a banner
 * alert fires; only an explicit `enable` resumes it (resetting the budget).
 */
export class JobParked extends Data.TaggedError("JobParked")<{
  readonly jobId: string
  /** Restart attempts consumed before parking. */
  readonly attempts: number
  readonly lastReason: string
}> {}

/** `enable`/`disable`/`remove`/`runNow` targeted a job id that is not scheduled. */
export class JobNotFound extends Data.TaggedError("JobNotFound")<{
  readonly jobId: string
}> {}

/** `schedule` with an id that is already scheduled. */
export class JobAlreadyExists extends Data.TaggedError("JobAlreadyExists")<{
  readonly jobId: string
}> {}

/** `schedule` with a malformed spec (bad id, bad tier, bad schedule, bad restart policy). */
export class InvalidJobSpec extends Data.TaggedError("InvalidJobSpec")<{
  readonly jobId: string
  readonly reason: string
}> {}

/** `runNow` on a job that is not enabled (disabled or parked). */
export class JobNotRunnable extends Data.TaggedError("JobNotRunnable")<{
  readonly jobId: string
  readonly status: string
}> {}

/** The run-history store failed (disk I/O). Infrastructure failure, loud by design. */
export class JobStoreError extends Data.TaggedError("JobStoreError")<{
  readonly reason: string
}> {}

/** The union of every typed error in the jobs library. */
export type JobError =
  | TierEscalationDenied
  | JobFailed
  | JobParked
  | JobNotFound
  | JobAlreadyExists
  | InvalidJobSpec
  | JobNotRunnable
  | JobStoreError
