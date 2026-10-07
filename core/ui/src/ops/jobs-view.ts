/**
 * ui/src/ops/jobs-view.ts — the job-runner view.
 *
 * Pure function of the jobs slice Model. Sections follow architecture §3.1:
 * scheduled / running / completed / failed, plus paused+parked. Each job shows
 * its provenance (tier, schedule, restart policy, failure streak, run counts)
 * and its controls: pause (disable), resume, run now, cancel (remove). The
 * pause→disable / cancel→remove mapping is stated on the buttons, not hidden.
 */
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"

import {
  completedRuns,
  describeRestart,
  failedRuns,
  inactiveJobs,
  Message,
  runningRuns,
  scheduledJobs,
  type Model,
  type UiJobDescriptor,
  type UiRunRecord,
} from "./jobs-slice.js"

const fmtTime = (ms: number): string => new Date(ms).toISOString()

const viewJobRow = (model: Model, job: UiJobDescriptor, h: HtmlBuilder<Message>): Html => {
  const selected = model.selectedJobId === job.id
  return h.li(
    [h.Class(`job-row${selected ? " selected" : ""}`), h.Key(job.id)],
    [
      h.div([h.Class("job-head")], [
        h.span([h.Class("job-name")], [job.name]),
        h.span([h.Class("job-id")], [job.id]),
        h.span([h.Class(`job-status job-status-${job.status}`)], [job.status]),
        h.span([h.Class("job-tier")], [`tier ${job.tier}`]),
      ]),
      h.div([h.Class("job-provenance")], [
        h.span([], [`schedule: ${job.schedule}`]),
        h.span([], [`restart: ${describeRestart(job)}`]),
        h.span([], [`runs: ${job.totalRuns}`]),
        h.span([], [`failures: ${job.consecutiveFailures}`]),
        ...(job.nextRunAtMs !== undefined
          ? [h.span([], [`next run: ${fmtTime(job.nextRunAtMs)}`])]
          : []),
      ]),
      h.div([h.Class("job-controls")], [
        h.button(
          [h.OnClick(Message.JobSelected({ jobId: job.id }))],
          [selected ? "hide runs" : "runs"],
        ),
        job.status === "enabled"
          ? h.button([h.OnClick(Message.JobPauseRequested({ jobId: job.id }))], [
              "pause (disable)",
            ])
          : h.button([h.OnClick(Message.JobResumeRequested({ jobId: job.id }))], [
              "resume (enable)",
            ]),
        h.button([h.OnClick(Message.JobRunNowRequested({ jobId: job.id }))], ["run now"]),
        h.button([h.OnClick(Message.JobCancelRequested({ jobId: job.id }))], [
          "cancel (remove)",
        ]),
      ]),
      ...(selected
        ? [
            h.ul(
              [h.Class("job-runs")],
              (model.history[job.id] ?? []).map((run) => viewRunRow(run, h)),
            ),
          ]
        : []),
    ],
  )
}

const viewRunRow = (run: UiRunRecord, h: HtmlBuilder<Message>): Html =>
  h.li([h.Class(`run-row run-${run.status}`), h.Key(run.runId)], [
    h.span([h.Class("run-id")], [run.runId]),
    h.span([h.Class(`run-status`)], [run.status]),
    h.span([], [`attempt ${run.attempt}${run.isRetry ? " (retry)" : ""}`]),
    h.span([], [fmtTime(run.startedAtMs)]),
    ...(run.durationMs !== undefined ? [h.span([], [`${run.durationMs}ms`])] : []),
    ...(run.reason !== undefined ? [h.span([h.Class("run-reason")], [run.reason])] : []),
  ])

const viewSection = (
  title: string,
  count: number,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section([h.Class("jobs-section")], [
    h.h3([], [`${title} (${count})`]),
    children.length > 0 ? h.ul([h.Class("jobs-list")], children) : h.p([], ["none"]),
  ])

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const scheduled = scheduledJobs(model)
  const running = runningRuns(model)
  const completed = completedRuns(model)
  const failed = failedRuns(model)
  const inactive = inactiveJobs(model)
  return h.section([h.Class("jobs-panel")], [
    h.h2([], ["jobs"]),
    h.p([h.Class("jobs-sub")], [
      "the job runner: scheduled, running, completed, failed. pause = disable (no new triggers); cancel = remove (interrupts in-flight runs).",
    ]),
    model.status === "loading" ? h.p([], ["loading jobs…"]) : null,
    model.status === "error"
      ? h.p([h.Class("error")], [`jobs failed to load: ${model.lastError ?? "unknown"}`])
      : null,
    model.lastError !== undefined && model.status !== "error"
      ? h.p([h.Class("error")], [`last control failed: ${model.lastError}`])
      : null,
    h.p([], [h.button([h.OnClick(Message.JobsRefreshRequested())], ["refresh"])]),
    viewSection(
      "scheduled",
      scheduled.length,
      scheduled.map((job) => viewJobRow(model, job, h)),
      h,
    ),
    viewSection(
      "running",
      running.length,
      running.map((run) => viewRunRow(run, h)),
      h,
    ),
    viewSection(
      "completed",
      completed.length,
      completed.slice(0, 20).map((run) => viewRunRow(run, h)),
      h,
    ),
    viewSection(
      "failed",
      failed.length,
      failed.slice(0, 20).map((run) => viewRunRow(run, h)),
      h,
    ),
    viewSection(
      "paused / parked",
      inactive.length,
      inactive.map((job) => viewJobRow(model, job, h)),
      h,
    ),
  ])
}

/** Submodel view for foldChild composition by the shell (Track 1). */
export const jobsSubmodelView = defineView<Model, Message>((model, h) => view(model, h))
