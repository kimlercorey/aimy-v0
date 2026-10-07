/**
 * cron.test.ts — the pure cron computation.
 *
 * `nextRunAfter` is pure (no clock, no I/O): every expectation below is a
 * fixed timestamp. All matching is UTC. 2026-10-07 is a Wednesday.
 */
import { describe, expect, it } from "@effect/vitest"

import {
  cronAny,
  cronAt,
  cronEvery,
  describeCron,
  matchesCron,
  nextRunAfter,
  validateCronSpec
} from "../src/cron.js"
import type { CronSpec } from "../src/types.js"

const MIN = 60_000
/** 2026-10-07T12:34:56Z — a Wednesday. */
const WED = Date.UTC(2026, 9, 7, 12, 34, 56)

const spec = (overrides: Partial<CronSpec>): CronSpec => ({
  minute: cronAny,
  hour: cronAny,
  dayOfMonth: cronAny,
  month: cronAny,
  dayOfWeek: cronAny,
  ...overrides
})

describe("nextRunAfter", () => {
  it("is strictly after fromMs: every-minute spec from a minute boundary", () => {
    const atBoundary = Date.UTC(2026, 9, 7, 12, 34, 0)
    expect(nextRunAfter(spec({}), atBoundary)).toBe(atBoundary + MIN)
  })

  it("mid-minute start still lands on the next boundary", () => {
    expect(nextRunAfter(spec({}), WED)).toBe(Date.UTC(2026, 9, 7, 12, 35, 0))
  })

  it("finds a specific time of day", () => {
    const s = spec({ minute: cronAt(30), hour: cronAt(14) })
    // Next 14:30 UTC after Wed 12:34 is today at 14:30.
    expect(nextRunAfter(s, WED)).toBe(Date.UTC(2026, 9, 7, 14, 30, 0))
    // After 14:30 it rolls to tomorrow.
    expect(nextRunAfter(s, Date.UTC(2026, 9, 7, 14, 30, 0))).toBe(
      Date.UTC(2026, 9, 8, 14, 30, 0)
    )
  })

  it("finds the next matching weekday", () => {
    // Monday = 1. Next Monday after Wed 2026-10-07 is 2026-10-12.
    const s = spec({ minute: cronAt(0), hour: cronAt(0), dayOfWeek: cronAt(1) })
    expect(nextRunAfter(s, WED)).toBe(Date.UTC(2026, 9, 12, 0, 0, 0))
  })

  it("finds the next matching month", () => {
    const s = spec({ minute: cronAt(0), hour: cronAt(0), dayOfMonth: cronAt(1), month: cronAt(1) })
    // Next Jan 1 after 2026-10-07 is 2027-01-01.
    expect(nextRunAfter(s, WED)).toBe(Date.UTC(2027, 0, 1, 0, 0, 0))
  })

  it("day-of-month OR day-of-week when both are restricted (Vixie)", () => {
    // 1st of month OR Monday, at 09:00.
    const s = spec({ minute: cronAt(0), hour: cronAt(9), dayOfMonth: cronAt(1), dayOfWeek: cronAt(1) })
    // Wed 2026-10-07 12:34 → next Monday 2026-10-12 09:00 comes before Nov 1.
    expect(nextRunAfter(s, WED)).toBe(Date.UTC(2026, 9, 12, 9, 0, 0))
  })

  it("day-of-month alone when day-of-week is unrestricted", () => {
    const s = spec({ minute: cronAt(0), hour: cronAt(0), dayOfMonth: cronAt(15) })
    expect(nextRunAfter(s, WED)).toBe(Date.UTC(2026, 9, 15, 0, 0, 0))
  })

  it("returns undefined for an impossible schedule (February 30th)", () => {
    const s = spec({ dayOfMonth: cronAt(30), month: cronAt(2) })
    expect(nextRunAfter(s, WED)).toBeUndefined()
  })

  it("cronEvery steps through a range", () => {
    // Every 15 minutes.
    const s = spec({ minute: cronEvery(15, 0, 59) })
    expect(nextRunAfter(s, Date.UTC(2026, 9, 7, 12, 7, 0))).toBe(
      Date.UTC(2026, 9, 7, 12, 15, 0)
    )
  })
})

describe("matchesCron", () => {
  it("matches an exact minute", () => {
    const s = spec({ minute: cronAt(34), hour: cronAt(12) })
    expect(matchesCron(s, WED)).toBe(true)
    expect(matchesCron(s, WED + MIN)).toBe(false)
  })

  it("matches any field", () => {
    expect(matchesCron(spec({}), WED)).toBe(true)
  })
})

describe("validateCronSpec", () => {
  it("accepts a valid spec", () => {
    expect(validateCronSpec(spec({ minute: cronAt(0, 30), month: cronAt(12) }))).toEqual([])
  })

  it("rejects out-of-range values", () => {
    const problems = validateCronSpec(spec({ minute: cronAt(60), dayOfWeek: cronAt(-1) }))
    expect(problems).toHaveLength(2)
    expect(problems.join(" ")).toContain("minute")
    expect(problems.join(" ")).toContain("dayOfWeek")
  })

  it("rejects empty value sets", () => {
    const problems = validateCronSpec(spec({ hour: cronAt() }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("hour")
  })
})

describe("describeCron", () => {
  it("renders crontab-style", () => {
    expect(
      describeCron(spec({ minute: cronAt(0), hour: cronAt(3), dayOfMonth: cronAt(1) }))
    ).toBe("0 3 1 * *")
  })
})
