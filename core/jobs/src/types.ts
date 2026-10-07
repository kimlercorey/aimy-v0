/**
 * jobs/types.ts — shared types for the JobRunner (architecture §1.1 row 9, §12 M7).
 *
 * A job is an Effect program run on a schedule. Every job records the
 * permission tier of its scheduling context and executes with AT MOST that
 * tier (see capabilities.ts); the runner provides `JobCapabilities` and
 * `AlertSink` to every job body.
 */
import type { Effect } from "effect"

import type { Tier } from "../../substrate/errors.js"

export type { Tier } from "../../substrate/errors.js"
import type { TierEscalationDenied } from "./errors.js"
import type { AlertSink } from "./runner.js"
import type { JobCapabilities } from "./capabilities.js"

/** Job identifier. Restricted to `[a-z0-9][a-z0-9_-]{0,63}` so it is safe as a path segment. */
export type JobId = string

/**
 * One field of a cron schedule. `Any` matches every value; `Values` matches
 * the listed values. Ranges: minute 0-59, hour 0-23, dayOfMonth 1-31,
 * month 1-12, dayOfWeek 0-6 (0 = Sunday). All matching is in UTC.
 */
export type CronField =
  | { readonly _tag: "Any" }
  | { readonly _tag: "Values"; readonly values: ReadonlySet<number> }

export interface CronSpec {
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
}

export type JobSchedule =
  | { readonly _tag: "OneShot"; readonly atMs: number }
  | { readonly _tag: "Cron"; readonly cron: CronSpec }

/**
 * Restart policy, per job.
 * - Never: a finished run is never restarted.
 * - OnFailure: restart after a failed run, with exponential backoff
 *   (`backoffMs * 2^retriesUsed`, capped at 1h), up to `maxAttempts` restarts.
 * - Always: restart after ANY completed run (success or failure) with the
 *   same backoff/budget. On a one-shot job this is a bounded loop of
 *   1 + maxAttempts runs.
 *
 * A restart is a NEW supervised fiber (a sibling of the failed run under the
 * runner's scope), never a resurrection of the dead fiber. Interruption
 * (cancel) never triggers a restart. Exhausting the budget parks the job.
 */
export type RestartPolicy =
  | { readonly _tag: "Never" }
  | { readonly _tag: "OnFailure"; readonly maxAttempts: number; readonly backoffMs: number }
  | { readonly _tag: "Always"; readonly maxAttempts: number; readonly backoffMs: number }

/**
 * Banner-alert policy for terminal run outcomes. Parked jobs ALWAYS alert,
 * regardless of this setting (a parked job is never silent).
 */
export type NotifyPolicy = "on-failure" | "always" | "never"

export interface JobSpec<A, E> {
  readonly id: JobId
  readonly name: string
  readonly description?: string | undefined
  /**
   * The tier of the scheduling context. Recorded at schedule time; the job
   * body executes with AT MOST this tier via the `JobCapabilities` gate.
   */
  readonly tier: Tier
  readonly schedule: JobSchedule
  readonly restart: RestartPolicy
  readonly notify?: NotifyPolicy | undefined
  /**
   * The job body — an Effect program, never a shell command. The runner
   * provides `JobCapabilities` (tier gate at/below `tier`) and `AlertSink`
   * (raise the job's own banner alerts).
   */
  readonly run: Effect.Effect<A, E, JobCapabilities | AlertSink>
}

export type JobStatus = "enabled" | "disabled" | "parked"

export interface JobDescriptor {
  readonly id: JobId
  readonly name: string
  readonly tier: Tier
  readonly status: JobStatus
  /** Human-readable schedule, e.g. `once at 2026-10-07T12:00:00.000Z` or `cron 0 3 1 * *`. */
  readonly schedule: string
  readonly restart: RestartPolicy
  readonly nextRunAtMs: number | undefined
  readonly consecutiveFailures: number
  readonly totalRuns: number
}

/** Run-log entry status. Lifecycle and outcome are separate (Hermes #68499). */
export type RunStatus = "started" | "succeeded" | "failed" | "cancelled" | "parked"

export interface RunRecord {
  readonly jobId: JobId
  /** `${jobId}#${attempt}` — unique per job. */
  readonly runId: string
  /** 1-based run counter for the job. */
  readonly attempt: number
  readonly tier: Tier
  /** True when this run is a backoff retry rather than a scheduled tick. */
  readonly isRetry: boolean
  readonly status: RunStatus
  readonly startedAtMs: number
  readonly endedAtMs?: number | undefined
  readonly durationMs?: number | undefined
  /**
   * Typed reason, e.g.
   * `JobFailed(jobId=j attempt=2 reason=TierEscalationDenied(...))`,
   * `defect: Error: kaput`, `interrupted`.
   */
  readonly reason?: string | undefined
}

export type JobAlertKind = "job-parked" | "job-failed" | "job-succeeded" | "job-info"

export interface JobAlert {
  readonly kind: JobAlertKind
  readonly jobId: JobId
  readonly jobName: string
  readonly atMs: number
  readonly detail: string
}

/**
 * Structural seam for the banner channel (M7 CommsBanner). The coordinator
 * wires the real banner; the jobs library never imports it.
 */
export interface AlertSinkService {
  /** Deliver a banner alert. Never fails — a sink that cannot deliver must handle it internally. */
  readonly alert: (alert: JobAlert) => Effect.Effect<void, never>
}

/**
 * The tier gate a job body acts through. `tier` is inherited from the
 * scheduling context and can never be raised. Any tiered side effect a job
 * performs MUST go through `check`/`perform`; escalation fails closed with
 * `TierEscalationDenied` BEFORE the effect runs (no side effect on denial).
 */
export interface JobCapabilitiesService {
  readonly jobId: JobId
  /** Maximum tier this job may act at — inherited, never escalated. */
  readonly tier: Tier
  readonly check: (requested: Tier, action: string) => Effect.Effect<void, TierEscalationDenied>
  readonly perform: <A, E>(
    requested: Tier,
    action: string,
    effect: Effect.Effect<A, E>
  ) => Effect.Effect<A, E | TierEscalationDenied>
}
