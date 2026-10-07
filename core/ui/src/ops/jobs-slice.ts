/**
 * ui/src/ops/jobs-slice.ts — the job-runner slice: Schema Model, Messages,
 * pure update, and foldkit Commands against the real `JobRunner`.
 *
 * Architecture §3.1: the job-runner view — scheduled, running, completed,
 * failed; each job's provenance and controls (pause/cancel). Pause maps to
 * `JobRunner.disable` (no new triggers; in-flight runs finish gracefully);
 * cancel maps to `JobRunner.remove` (interrupts in-flight runs, each records
 * `cancelled`). The mapping is stated in the view, not hidden.
 */
import { Effect, Schema } from "effect"
import { define as defineCommand } from "foldkit/command"
import { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"

import { JobRunner } from "../../../jobs/src/runner.js"
import { RunHistory } from "../../../jobs/src/history.js"
import type { JobDescriptor } from "../../../jobs/src/types.js"

// ─── Model ───────────────────────────────────────────────────────────────────

export const TierSchema = Schema.Literals(["T0", "T1", "T2", "T3"])

export const RestartPolicySchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Never") }),
  Schema.Struct({
    _tag: Schema.Literal("OnFailure"),
    maxAttempts: Schema.Number,
    backoffMs: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Always"),
    maxAttempts: Schema.Number,
    backoffMs: Schema.Number,
  }),
])

export const JobDescriptorSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tier: TierSchema,
  status: Schema.Literals(["enabled", "disabled", "parked"]),
  schedule: Schema.String,
  restart: RestartPolicySchema,
  nextRunAtMs: Schema.optional(Schema.Number),
  consecutiveFailures: Schema.Number,
  totalRuns: Schema.Number,
})
export type UiJobDescriptor = typeof JobDescriptorSchema.Type

export const RunStatusSchema = Schema.Literals([
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "parked",
])

export const RunRecordSchema = Schema.Struct({
  jobId: Schema.String,
  runId: Schema.String,
  attempt: Schema.Number,
  tier: TierSchema,
  isRetry: Schema.Boolean,
  status: RunStatusSchema,
  startedAtMs: Schema.Number,
  endedAtMs: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
})
export type UiRunRecord = typeof RunRecordSchema.Type

export const JobsStatusSchema = Schema.Literals(["loading", "ready", "error"])

export const Model = Schema.Struct({
  /** Snapshot of `JobRunner.list()`. */
  jobs: Schema.Array(JobDescriptorSchema),
  /** Run history per job id (completed/failed/running derived from this). */
  history: Schema.Record(Schema.String, Schema.Array(RunRecordSchema)),
  selectedJobId: Schema.optional(Schema.String),
  status: JobsStatusSchema,
  lastError: Schema.optional(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  jobs: [],
  history: {},
  selectedJobId: undefined,
  status: "loading",
  lastError: undefined,
}

// ─── Messages ────────────────────────────────────────────────────────────────

export const Message = defineMessageUnion({
  JobsRefreshRequested: {},
  JobsRefreshed: {
    jobs: Schema.Array(JobDescriptorSchema),
    history: Schema.Record(Schema.String, Schema.Array(RunRecordSchema)),
  },
  JobsRefreshFailed: { reason: Schema.String },
  JobSelected: { jobId: Schema.String },
  /** Pause → `JobRunner.disable`: no new triggers, in-flight runs finish. */
  JobPauseRequested: { jobId: Schema.String },
  /** Resume a paused job. */
  JobResumeRequested: { jobId: Schema.String },
  /** Cancel → `JobRunner.remove`: interrupts in-flight runs. */
  JobCancelRequested: { jobId: Schema.String },
  JobRunNowRequested: { jobId: Schema.String },
  /** A control Command's success result: the refreshed snapshot. */
  JobsControlled: {
    jobs: Schema.Array(JobDescriptorSchema),
    history: Schema.Record(Schema.String, Schema.Array(RunRecordSchema)),
  },
  JobControlFailed: {
    jobId: Schema.String,
    action: Schema.String,
    reason: Schema.String,
  },
})
export type Message = typeof Message.Type

// ─── Commands ────────────────────────────────────────────────────────────────

const decodeJobs = Schema.decodeUnknownEffect(Schema.Array(JobDescriptorSchema))
const decodeHistory = Schema.decodeUnknownEffect(Schema.Array(RunRecordSchema))

const snapshot = Effect.gen(function* () {
  const runner = yield* JobRunner
  const historySvc = yield* RunHistory
  const descriptors: ReadonlyArray<JobDescriptor> = yield* runner.list()
  const history: Record<string, ReadonlyArray<UiRunRecord>> = {}
  for (const d of descriptors) {
    history[d.id] = yield* decodeHistory(yield* historySvc.list(d.id))
  }
  return { jobs: yield* decodeJobs(descriptors), history }
})

/** Read jobs + run history from the real services. */
export const RefreshJobs = defineCommand("jobs/refresh", {
  messages: [Message.JobsRefreshed, Message.JobsRefreshFailed],
  execute: snapshot.pipe(
    Effect.map(({ jobs, history }) => Message.JobsRefreshed({ jobs, history })),
    Effect.catch((cause) =>
      Effect.succeed(Message.JobsRefreshFailed({ reason: String(cause) })),
    ),
  ),
})

const control = (action: "pause" | "resume" | "cancel" | "run-now", jobId: string) =>
  Effect.gen(function* () {
    const runner = yield* JobRunner
    switch (action) {
      case "pause":
        yield* runner.disable(jobId)
        break
      case "resume":
        yield* runner.enable(jobId)
        break
      case "cancel":
        yield* runner.remove(jobId)
        break
      case "run-now":
        yield* runner.runNow(jobId)
        break
    }
    const { jobs, history } = yield* snapshot
    return Message.JobsControlled({ jobs, history })
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(Message.JobControlFailed({ jobId, action, reason: String(cause) })),
    ),
  )

export const PauseJob = defineCommand("jobs/pause", {
  args: { jobId: Schema.String },
  messages: [Message.JobsControlled, Message.JobControlFailed],
  execute: ({ jobId }) => control("pause", jobId),
})

export const ResumeJob = defineCommand("jobs/resume", {
  args: { jobId: Schema.String },
  messages: [Message.JobsControlled, Message.JobControlFailed],
  execute: ({ jobId }) => control("resume", jobId),
})

export const CancelJob = defineCommand("jobs/cancel", {
  args: { jobId: Schema.String },
  messages: [Message.JobsControlled, Message.JobControlFailed],
  execute: ({ jobId }) => control("cancel", jobId),
})

export const RunJobNow = defineCommand("jobs/run-now", {
  args: { jobId: Schema.String },
  messages: [Message.JobsControlled, Message.JobControlFailed],
  execute: ({ jobId }) => control("run-now", jobId),
})

// ─── Update ──────────────────────────────────────────────────────────────────

/** Services the slice's Commands need; the shell provides them as `resources`. */
export type JobsResources = JobRunner | RunHistory

export type JobsUpdateReturn = Update.Return<Model, Message, JobsResources>

export const update = (model: Model, message: Message): JobsUpdateReturn =>
  Message.match<JobsUpdateReturn>(message, {
    JobsRefreshRequested: () => ({
      model: modifyFields(model, {
        status: () => "loading" as const,
        lastError: () => undefined,
      }),
      commands: [RefreshJobs()],
    }),
    JobsRefreshed: ({ jobs, history }) => ({
      model: modifyFields(model, {
        jobs: () => jobs,
        history: () => history,
        status: () => "ready" as const,
        lastError: () => undefined,
      }),
    }),
    JobsControlled: ({ jobs, history }) => ({
      model: modifyFields(model, {
        jobs: () => jobs,
        history: () => history,
        status: () => "ready" as const,
        lastError: () => undefined,
      }),
    }),
    JobsRefreshFailed: ({ reason }) => ({
      model: modifyFields(model, {
        status: () => "error" as const,
        lastError: () => reason,
      }),
    }),
    JobSelected: ({ jobId }) => ({
      model: modifyFields(model, { selectedJobId: () => jobId }),
    }),
    JobPauseRequested: ({ jobId }) => ({ model, commands: [PauseJob({ jobId })] }),
    JobResumeRequested: ({ jobId }) => ({ model, commands: [ResumeJob({ jobId })] }),
    JobCancelRequested: ({ jobId }) => ({ model, commands: [CancelJob({ jobId })] }),
    JobRunNowRequested: ({ jobId }) => ({ model, commands: [RunJobNow({ jobId })] }),
    JobControlFailed: ({ reason }) => ({
      model: modifyFields(model, { lastError: () => reason }),
    }),
  })

// ─── Derived groupings (§3.1: scheduled / running / completed / failed) ──────

/** Jobs with `enabled` status — the schedule is live. */
export const scheduledJobs = (model: Model): ReadonlyArray<UiJobDescriptor> =>
  model.jobs.filter((j) => j.status === "enabled")

/**
 * Runs that started but have no terminal record yet. Lifecycle and outcome
 * stay separate (Hermes #68499): a `started` record with no later
 * succeeded/failed/cancelled record for the same runId is running.
 */
export const runningRuns = (model: Model): ReadonlyArray<UiRunRecord> => {
  const terminal = new Set<string>()
  for (const records of Object.values(model.history)) {
    for (const r of records) {
      if (r.status !== "started") terminal.add(r.runId)
    }
  }
  return Object.values(model.history)
    .flat()
    .filter((r) => r.status === "started" && !terminal.has(r.runId))
}

export const completedRuns = (model: Model): ReadonlyArray<UiRunRecord> =>
  Object.values(model.history)
    .flat()
    .filter((r) => r.status === "succeeded")
    .sort((a, b) => b.startedAtMs - a.startedAtMs)

export const failedRuns = (model: Model): ReadonlyArray<UiRunRecord> =>
  Object.values(model.history)
    .flat()
    .filter((r) => r.status === "failed" || r.status === "cancelled" || r.status === "parked")
    .sort((a, b) => b.startedAtMs - a.startedAtMs)

/** Disabled (paused) and parked jobs. */
export const inactiveJobs = (model: Model): ReadonlyArray<UiJobDescriptor> =>
  model.jobs.filter((j) => j.status !== "enabled")

export const describeRestart = (job: UiJobDescriptor): string => {
  switch (job.restart._tag) {
    case "Never":
      return "never"
    case "OnFailure":
      return `on failure (${job.restart.maxAttempts} attempts)`
    case "Always":
      return `always (${job.restart.maxAttempts} attempts)`
  }
}
