/**
 * jobs/cadences.ts — scheduling seams for system cadences.
 *
 * These are JobSpec FACTORIES (scheduling only). They own the *when*; the
 * *what* lives elsewhere:
 *
 * - `monthlyAscDiagnostic()`: the architecture §12 M7 monthly ASC
 *   diagnostic cadence. The job fires on schedule and raises a banner
 *   alert noting the diagnostic is due — the diagnostic itself is M8/other
 *   work and is NOT executed here.
 * - `learningReviewDrainJob(drain)`: the M6 learning-loop review
 *   scheduling seam. It wraps `ReviewScheduler.drain()` from
 *   `learning/src/scheduling.ts` (reusing its `DrainReport` type) in a
 *   recurring job; the queue's own idle-gating (settle window, max age,
 *   one-slot-per-session coalescing) still applies inside `drain()`.
 */
import { Clock, Effect } from "effect"

import type { Tier } from "../../substrate/errors.js"
import type { DrainReport } from "../../learning/src/scheduling.js"
import { cronAny, cronAt } from "./cron.js"
import { AlertSink } from "./runner.js"
import type { CronSpec, JobSpec } from "./types.js"

/** 1st of every month, 03:00 UTC (`0 3 1 * *`). */
export const MONTHLY_ASC_CRON: CronSpec = {
  minute: cronAt(0),
  hour: cronAt(3),
  dayOfMonth: cronAt(1),
  month: cronAny,
  dayOfWeek: cronAny
}

/**
 * Scheduling seam for the monthly ASC diagnostic cadence (architecture
 * §12 M7, extension point of M5). SCHEDULING ONLY: when the cadence fires,
 * the job raises a `job-info` banner alert recording that the diagnostic is
 * due. The diagnostic implementation itself is M8/other work.
 */
export const monthlyAscDiagnostic = (): JobSpec<void, never> => ({
  id: "asc-monthly-diagnostic",
  name: "Monthly ASC diagnostic",
  description:
    "Scheduling seam for the M7 monthly ASC diagnostic cadence. Fires 1st of month 03:00 UTC " +
    "and raises a banner alert; the diagnostic itself is M8/other work.",
  tier: "T1",
  schedule: { _tag: "Cron", cron: MONTHLY_ASC_CRON },
  restart: { _tag: "Never" },
  notify: "never",
  run: Effect.gen(function* () {
    const sink = yield* AlertSink
    const atMs = yield* Clock.currentTimeMillis
    yield* sink.alert({
      kind: "job-info",
      jobId: "asc-monthly-diagnostic",
      jobName: "Monthly ASC diagnostic",
      atMs,
      detail:
        "Monthly ASC diagnostic cadence fired. The diagnostic itself is M8/other work — " +
        "no diagnostic was executed."
    })
  })
})

/** Default review-drain cadence: hourly at minute 15 UTC. */
export const HOURLY_REVIEW_DRAIN_CRON: CronSpec = {
  minute: cronAt(15),
  hour: cronAny,
  dayOfMonth: cronAny,
  month: cronAny,
  dayOfWeek: cronAny
}

export interface LearningReviewDrainOpts {
  readonly id?: string | undefined
  readonly cron?: CronSpec | undefined
  readonly tier?: Tier | undefined
}

/**
 * Scheduling seam over the M6 `ReviewScheduler` (learning/src/scheduling.ts).
 * `drain` is the coordinator-wired thunk — typically
 * `() => Effect.flatMap(ReviewScheduler, (s) => s.drain())` — so this
 * library takes no dependency on the learning layer's services. The
 * returned `DrainReport` type is reused from the learning library.
 *
 * A failed drain retries with backoff (3 attempts); the queue's own
 * idle-gating still applies inside `drain()`.
 */
export const learningReviewDrainJob = (
  drain: () => Effect.Effect<DrainReport, never>,
  opts?: LearningReviewDrainOpts | undefined
): JobSpec<DrainReport, never> => ({
  id: opts?.id ?? "learning-review-drain",
  name: "Learning review drain",
  description:
    "Scheduling seam over the M6 ReviewScheduler: periodically drains the idle-gated " +
    "background-review queue (learning/src/scheduling.ts). The queue's settle-window / " +
    "max-age / one-slot-per-session coalescing policy still applies inside drain().",
  tier: opts?.tier ?? "T1",
  schedule: { _tag: "Cron", cron: opts?.cron ?? HOURLY_REVIEW_DRAIN_CRON },
  restart: { _tag: "OnFailure", maxAttempts: 3, backoffMs: 60_000 },
  notify: "on-failure",
  run: drain()
})
