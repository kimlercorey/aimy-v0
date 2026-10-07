/**
 * ui/test/ops.test.ts — M8 acceptance: the jobs + banners slices against the
 * LIVE `JobRunner` and `CommsBanner` services (in-memory).
 *
 * Same harness as the timeline tests: pure update + real Commands + real
 * services (the layer is provided ONCE around the whole test body), then
 * assert displayed values === service state.
 */
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { inertHtml, type HtmlBuilder } from "foldkit/html"

import { JobRunner } from "../../jobs/src/runner.js"
import { CommsBanner } from "../../comms/service.js"
import {
  initialJobsModel,
  JobsMessage,
  jobsUpdate,
  jobsView,
  initialBannersModel,
  BannersMessage,
  bannersUpdate,
  bannersView,
} from "../src/ops/index.js"
import type {
  JobsModelType,
  JobsMessageType,
  BannersModelType,
  BannersMessageType,
} from "../src/ops/index.js"
import { normalized, textOf } from "../src/shared/text.js"
import { commsLayers, drain, jobsLayers, pollFor } from "./helpers.js"

const hj = inertHtml as unknown as HtmlBuilder<JobsMessageType>
const hb = inertHtml as unknown as HtmlBuilder<BannersMessageType>

const renderJobs = (model: JobsModelType): string => normalized(textOf(jobsView(model, hj)))
const renderBanners = (model: BannersModelType): string => normalized(textOf(bannersView(model, hb)))

/** Refresh the jobs slice from the live services. Layer provided by the caller. */
const refreshJobs = (model: JobsModelType): Effect.Effect<JobsModelType, unknown, any> =>
  drain(jobsUpdate, model, JobsMessage.JobsRefreshRequested()) as Effect.Effect<JobsModelType, unknown, any>

/** Refresh the banners slice from the live service. Layer provided by the caller. */
const refreshBanners = (model: BannersModelType): Effect.Effect<BannersModelType, unknown, any> =>
  drain(bannersUpdate, model, BannersMessage.BannersRefreshRequested()) as Effect.Effect<BannersModelType, unknown, any>

const scheduleJob = (id: string, name: string, run: Effect.Effect<unknown, unknown, never>, atMs: number) =>
  Effect.gen(function* () {
    const runner = yield* JobRunner
    yield* runner.schedule({
      id,
      name,
      tier: "T1",
      schedule: { _tag: "OneShot", atMs },
      restart: { _tag: "Never" },
      notify: "never",
      run: run as Effect.Effect<unknown, never, never>,
    })
  })

describe("jobs slice + live JobRunner", () => {
  it.effect("refresh shows scheduled jobs with provenance; displayed === runner.list()", () =>
    Effect.gen(function* () {
      const atMs = Date.now() + 60_000
      yield* scheduleJob("nightly-report", "Nightly report", Effect.succeed("ok"), atMs)
      yield* scheduleJob("cleanup", "Temp cleanup", Effect.succeed("ok"), atMs + 1000)

      const model = yield* refreshJobs(initialJobsModel)
      expect(model.jobs).toHaveLength(2)

      const runner = yield* JobRunner
      const listed = yield* runner.list()
      expect(model.jobs.map((j) => j.id).sort()).toEqual(listed.map((j) => j.id).sort())

      const text = renderJobs(model)
      expect(text).toContain("Nightly report")
      expect(text).toContain("Temp cleanup")
      expect(text).toContain("tier T1")
      expect(text).toContain("once at")
      expect(text).toContain("restart: never")
      expect(text).toContain("scheduled (2)")
    }).pipe(Effect.provide(jobsLayers())),
  )

  it.effect("pause/resume/run-now/cancel drive the real runner", () =>
    Effect.gen(function* () {
      yield* scheduleJob("adhoc", "Adhoc job", Effect.succeed("ok"), Date.now() + 60_000)
      let model = yield* refreshJobs(initialJobsModel)
      expect(model.jobs[0]?.status).toBe("enabled")

      // Pause → disable.
      model = (yield* drain(jobsUpdate, model, JobsMessage.JobPauseRequested({ jobId: "adhoc" }))) as JobsModelType
      expect(model.jobs[0]?.status).toBe("disabled")
      expect(renderJobs(model)).toContain("paused / parked (1)")

      // Resume → enable.
      model = (yield* drain(jobsUpdate, model, JobsMessage.JobResumeRequested({ jobId: "adhoc" }))) as JobsModelType
      expect(model.jobs[0]?.status).toBe("enabled")

      // Run now → a completed run lands in history.
      yield* drain(jobsUpdate, model, JobsMessage.JobRunNowRequested({ jobId: "adhoc" }))
      yield* pollFor(
        Effect.gen(function* () {
          const m = yield* refreshJobs(initialJobsModel)
          const runs = m.history["adhoc"] ?? []
          return runs.some((r) => r.status === "succeeded") ? m : undefined
        }),
        "adhoc succeeded run",
      )
      model = yield* refreshJobs(initialJobsModel)
      expect(renderJobs(model)).toContain("completed (1)")

      // Cancel → remove.
      model = (yield* drain(jobsUpdate, model, JobsMessage.JobCancelRequested({ jobId: "adhoc" }))) as JobsModelType
      expect(model.jobs).toHaveLength(0)
    }).pipe(Effect.provide(jobsLayers())),
  )

  it.effect("failed runs appear in the failed section with their reason", () =>
    Effect.gen(function* () {
      yield* scheduleJob("flaky", "Flaky job", Effect.fail(new Error("kaput")), Date.now() + 60_000)
      const started = yield* refreshJobs(initialJobsModel)
      yield* drain(jobsUpdate, started, JobsMessage.JobRunNowRequested({ jobId: "flaky" }))
      yield* pollFor(
        Effect.gen(function* () {
          const m = yield* refreshJobs(initialJobsModel)
          const runs = m.history["flaky"] ?? []
          return runs.some((r) => r.status === "failed") ? m : undefined
        }),
        "flaky failed run",
      )
      const model = yield* refreshJobs(initialJobsModel)
      const text = renderJobs(model)
      expect(text).toContain("failed (1)")
      expect(text).toContain("kaput")
    }).pipe(Effect.provide(jobsLayers())),
  )
})

describe("banners slice + live CommsBanner", () => {
  it.effect("refresh shows published banners priority-ordered; displayed === service state", () =>
    Effect.gen(function* () {
      const comms = yield* CommsBanner
      const info = yield* comms.publish({
        severity: "info",
        source: "system",
        title: "routine notice",
        body: "nothing urgent",
      })
      const warn = yield* comms.publish({
        severity: "warning",
        source: "job:nightly-report",
        title: "job warning",
        body: "disk nearly full",
        dedupeKey: "disk-warn",
      })
      const crit = yield* comms.publish({
        severity: "critical",
        source: "system",
        title: "security alert",
        body: "action required",
      })

      const model = yield* refreshBanners(initialBannersModel)
      expect(model.banners).toHaveLength(3)

      const listed = yield* comms.listBanners()
      expect(model.banners.map((b) => b.id).sort()).toEqual(listed.map((b) => b.id).sort())

      const text = renderBanners(model)
      // Priority: critical (security rung) first, regardless of publish order.
      const critAt = text.indexOf(crit.title)
      const warnAt = text.indexOf(warn.title)
      const infoAt = text.indexOf(info.title)
      expect(critAt).toBeGreaterThanOrEqual(0)
      expect(critAt).toBeLessThan(warnAt)
      expect(warnAt).toBeLessThan(infoAt)
      expect(text).toContain("disk nearly full")
    }).pipe(Effect.provide(commsLayers())),
  )

  it.effect("dismiss records the audit trail in the service; banner leaves the queue", () =>
    Effect.gen(function* () {
      const comms = yield* CommsBanner
      const banner = yield* comms.publish({
        severity: "info",
        source: "system",
        title: "bye",
        body: "dismiss me",
      })

      let model = yield* refreshBanners(initialBannersModel)
      expect(renderBanners(model)).toContain("dismiss me")

      model = (yield* drain(
        bannersUpdate,
        model,
        BannersMessage.BannerDismissRequested({ id: banner.id }),
      )) as BannersModelType
      // Dismiss auto-refreshes; the banner leaves the active queue.
      expect(renderBanners(model)).not.toContain("dismiss me")

      // The audit trail retains it — dismissal never deletes.
      const log = yield* comms.bannerLog()
      expect(log.some((r) => r.kind === "dismissed" && r.banner.id === banner.id)).toBe(true)

      // Opt into dismissed: the toggle re-refreshes with dismissed included.
      model = (yield* drain(
        bannersUpdate,
        model,
        BannersMessage.ShowDismissedToggled(),
      )) as BannersModelType
      expect(renderBanners(model)).toContain("dismiss me")
    }).pipe(Effect.provide(commsLayers())),
  )

  it.effect("snooze, mute-by-severity, and quiet hours hide banners (pure UI controls)", () =>
    Effect.gen(function* () {
      const comms = yield* CommsBanner
      yield* comms.publish({ severity: "info", source: "system", title: "info-note", body: "snooze me" })
      yield* comms.publish({ severity: "critical", source: "system", title: "crit-note", body: "stays" })

      let model = yield* refreshBanners(initialBannersModel)
      expect(renderBanners(model)).toContain("snooze me")

      // Snooze the info banner for an hour → hidden; unsnooze → back.
      const infoId = model.banners.find((b) => b.title === "info-note")?.id as string
      model = pureUpdate(model, BannersMessage.BannerSnoozed({ id: infoId, untilMs: Date.now() + 3_600_000 }))
      expect(renderBanners(model)).not.toContain("snooze me")
      expect(renderBanners(model)).toContain("stays")
      model = pureUpdate(model, BannersMessage.BannerUnsnoozed({ id: infoId }))
      expect(renderBanners(model)).toContain("snooze me")

      // Mute-by-severity → hidden; unmute → back.
      model = pureUpdate(model, BannersMessage.BannerSeverityMuted({ severity: "info" }))
      expect(renderBanners(model)).not.toContain("snooze me")
      model = pureUpdate(model, BannersMessage.BannerSeverityUnmuted({ severity: "info" }))
      expect(renderBanners(model)).toContain("snooze me")

      // Quiet hours covering "now" suppress everything below critical.
      const hour = new Date().getHours()
      model = pureUpdate(
        model,
        BannersMessage.QuietHoursChanged({
          quietHours: { enabled: true, startHour: hour, endHour: (hour + 2) % 24 },
        }),
      )
      const quietText = renderBanners(model)
      expect(quietText).not.toContain("snooze me")
      expect(quietText).toContain("stays")
      expect(quietText).toContain("quiet hours active")
    }).pipe(Effect.provide(commsLayers())),
  )
})

/** Pure update with no Commands expected (UI controls only). */
const pureUpdate = (model: BannersModelType, message: BannersMessageType): BannersModelType => {
  const result = bannersUpdate(model, message)
  if (result.commands !== undefined && result.commands.length > 0) {
    throw new Error(`expected no commands for ${message._tag}`)
  }
  return result.model
}
