/**
 * jobs/cron.ts — pure cron schedule computation.
 *
 * `CronSpec` covers minute/hour/day-of-month/month/day-of-week. Matching is
 * in UTC; day-of-month vs day-of-week follows Vixie cron semantics (both
 * restricted → OR, otherwise the restricted field decides).
 *
 * `nextRunAfter` is PURE (no clock, no I/O) — the property the scheduler
 * and the tests both rely on.
 */
import type { CronField, CronSpec } from "./types.js"

/** Matches every value in the field's range. */
export const cronAny: CronField = { _tag: "Any" }

/** Matches exactly the listed values (validated against the range at schedule time). */
export const cronAt = (...values: number[]): CronField => ({
  _tag: "Values",
  values: new Set(values)
})

/** Matches `min, min+step, …` up to `max` (inclusive). */
export const cronEvery = (step: number, min: number, max: number): CronField => {
  const values = new Set<number>()
  for (let v = min; v <= max; v += step) values.add(v)
  return { _tag: "Values", values }
}

const RANGES: Record<keyof CronSpec, readonly [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6]
}

/** Validate a spec; returns human-readable problems (empty = valid). */
export const validateCronSpec = (spec: CronSpec): ReadonlyArray<string> => {
  const problems: Array<string> = []
  for (const name of Object.keys(RANGES) as Array<keyof CronSpec>) {
    const field = spec[name]
    const [lo, hi] = RANGES[name]
    if (field._tag === "Values") {
      if (field.values.size === 0) problems.push(`${name}: empty value set never matches`)
      for (const v of field.values) {
        if (!Number.isInteger(v) || v < lo || v > hi) {
          problems.push(`${name}: ${v} out of range ${lo}-${hi}`)
        }
      }
    }
  }
  return problems
}

const fieldMatches = (field: CronField, value: number): boolean =>
  field._tag === "Any" || field.values.has(value)

/** Pure: does `spec` match the minute containing `atMs` (UTC)? */
export const matchesCron = (spec: CronSpec, atMs: number): boolean => {
  const d = new Date(atMs)
  if (!fieldMatches(spec.minute, d.getUTCMinutes())) return false
  if (!fieldMatches(spec.hour, d.getUTCHours())) return false
  if (!fieldMatches(spec.month, d.getUTCMonth() + 1)) return false
  const domRestricted = spec.dayOfMonth._tag !== "Any"
  const dowRestricted = spec.dayOfWeek._tag !== "Any"
  const dom = fieldMatches(spec.dayOfMonth, d.getUTCDate())
  const dow = fieldMatches(spec.dayOfWeek, d.getUTCDay())
  // Vixie semantics: both restricted → OR; otherwise the restricted field decides.
  if (domRestricted && dowRestricted) return dom || dow
  if (domRestricted) return dom
  if (dowRestricted) return dow
  return true
}

/** How far forward `nextRunAfter` searches before giving up (undefined). */
export const NEXT_RUN_SEARCH_DAYS = 366

/**
 * Pure: the next minute-boundary STRICTLY after `fromMs` matching `spec`
 * (UTC), or `undefined` when nothing matches within the search window
 * (e.g. February 30th).
 */
export const nextRunAfter = (spec: CronSpec, fromMs: number): number | undefined => {
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  const limit = start + NEXT_RUN_SEARCH_DAYS * 24 * 60 * 60_000
  for (let t = start; t <= limit; t += 60_000) {
    if (matchesCron(spec, t)) return t
  }
  return undefined
}

/** `0 3 1 * *` style rendering for descriptors and logs. */
export const describeCron = (spec: CronSpec): string => {
  const field = (f: CronField): string =>
    f._tag === "Any" ? "*" : [...f.values].sort((a, b) => a - b).join(",")
  return [spec.minute, spec.hour, spec.dayOfMonth, spec.month, spec.dayOfWeek]
    .map(field)
    .join(" ")
}
