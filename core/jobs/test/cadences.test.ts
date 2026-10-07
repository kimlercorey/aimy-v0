/**
 * cadences.test.ts — the scheduling seams.
 *
 * - `monthlyAscDiagnostic()`: fires 1st of month 03:00 UTC, raises a
 *   job-info alert noting the diagnostic is M8/other work (scheduling
 *   only — no diagnostic is executed).
 * - `learningReviewDrainJob()`: wraps the M6 ReviewScheduler drain thunk in
 *   a recurring job, reusing the learning library's `DrainReport` type.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { nextRunAfter } from "../src/cron.js"
import {
  HOURLY_REVIEW_DRAIN_CRON,
  MONTHLY_ASC_CRON,
  learningReviewDrainJob,
  monthlyAscDiagnostic
} from "../src/cadences.js"
import type { DrainReport } from "../../learning/src/scheduling.js"
import { alertsOf, eventually, hasStatus, withRunner } from "./helpers.js"

describe("monthlyAscDiagnostic", () => {
  it("fires on the 1st of the month at 03:00 UTC", () => {
    // 2026-10-07 (Wednesday) → next 1st is 2026-11-01 03:00 UTC.
    expect(nextRunAfter(MONTHLY_ASC_CRON, Date.UTC(2026, 9, 7, 12, 0, 0))).toBe(
      Date.UTC(2026, 10, 1, 3, 0, 0)
    )
  })

  it.effect("raises a job-info alert noting the diagnostic is M8 work", () =>
    withRunner(({ runner, history, alerts }) =>
      Effect.gen(function* () {
        const spec = monthlyAscDiagnostic()
        expect(spec.tier).toBe("T1")
        expect(spec.schedule._tag).toBe("Cron")
        yield* runner.schedule(spec)
        yield* runner.runNow(spec.id)
        yield* eventually(hasStatus(history, spec.id, "succeeded"), "cadence fired")
        const info = yield* alertsOf(alerts, "job-info")
        expect(info).toHaveLength(1)
        expect(info[0]!.detail).toContain("M8")
      })
    )
  )
})

describe("learningReviewDrainJob", () => {
  it("defaults to hourly at minute 15", () => {
    const at = nextRunAfter(HOURLY_REVIEW_DRAIN_CRON, Date.UTC(2026, 9, 7, 12, 7, 0))!
    expect(new Date(at).getUTCMinutes()).toBe(15)
    expect(at).toBe(Date.UTC(2026, 9, 7, 12, 15, 0))
  })

  it.effect("runs the coordinator-wired drain thunk and reports its DrainReport", () =>
    withRunner(({ runner, history }) =>
      Effect.gen(function* () {
        const report: DrainReport = { processed: 2, droppedStale: 1, remaining: 0 }
        let drained = false
        const spec = learningReviewDrainJob(
          () =>
            Effect.gen(function* () {
              drained = true
              return report
            }),
          { id: "drain-test" }
        )
        expect(spec.id).toBe("drain-test")
        expect(spec.tier).toBe("T1")
        yield* runner.schedule(spec)
        yield* runner.runNow(spec.id)
        yield* eventually(hasStatus(history, spec.id, "succeeded"), "drain ran")
        expect(drained).toBe(true)
        const descriptor = (yield* runner.list()).find((d) => d.id === spec.id)!
        expect(descriptor.schedule).toContain("cron")
      })
    )
  )
})
