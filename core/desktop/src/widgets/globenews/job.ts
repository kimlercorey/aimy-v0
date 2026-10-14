/**
 * widgets/globenews/job.ts — the planned world-news scan job.
 *
 * A JobSpec in the cadences pattern (jobs/cadences.ts): the
 * runner owns the when, this factory owns the what. Default
 * cadence is Kimler's: every 60 minutes (cron minute 0, UTC —
 * the runner's clock). The desktop schedules it at boot and
 * triggers an immediate run when the store is stale, so a fresh
 * install is not empty until the hour turns.
 *
 * Failure honesty: a scan where EVERY source failed fails the
 * run (the runner's retry/banner machinery sees it); a partial
 * scan succeeds and logs which source was lost.
 */
import { Effect } from "effect"

import { cronAny, cronAt } from "../../../../jobs/src/cron.js"
import type { JobSpec } from "../../../../jobs/src/types.js"
import { readNewsStore, writeNewsStore } from "./events.js"
import { censusFromEvents, mergeLedger, nearestWatchedPlace, readLedger, writeLedger } from "./ledger.js"
import { alertFor, fetchTextLive, mergeEvents, scanAll } from "./scan.js"
import type { NewsEvent } from "./types.js"

/**
 * Alert sink (Threat Channel design §4/§8): warning-tier arrivals
 * are pushed out of the widget — a platform banner, and (when the
 * event is inside the risk circle) the "alerts" voice. The job
 * stays service-free; the desktop wires the sink at boot.
 * Arrivals are ALWAYS logged, sink or no sink.
 */
export interface NewsAlert {
  readonly id: string
  readonly severity: "warning" | "critical"
  readonly title: string
  readonly body: string
  /** Inside the risk circle (Kimler, 2026-10-13): voice alerts
   *  fire for items within it, or for pattern-driven alerts —
   *  banners keep the wider alertFor radii. */
  readonly voice: boolean
  /** The exact sentence the alerts voice speaks. */
  readonly spoken: string
}

let alertSink: ((alert: NewsAlert) => void) | undefined

export const setNewsAlertSink = (fn: (alert: NewsAlert) => void): void => {
  alertSink = fn
}

/** The risk circle: voice range around a watched place (the
 *  Local scope radius). */
export const VOICE_ALERT_RADIUS_KM = 150

/**
 * Compose the full alert for one event (banner + voice fields),
 * or undefined when the event is not alert-tier. Shared by the
 * scan dispatch and the desktop's boot replay, so a threat is
 * worded the same however it surfaces.
 */
export const buildNewsAlert = (e: NewsEvent): NewsAlert | undefined => {
  const info = alertFor(e)
  if (info === undefined) return undefined
  const near = nearestWatchedPlace(e)
  const voice = near !== undefined && near.km <= VOICE_ALERT_RADIUS_KM
  return {
    id: e.id,
    severity: info.severity,
    title: `Threat alert — ${e.title}`,
    body: `${info.reason} · ${e.source}${e.place !== undefined ? ` · ${e.place}` : ""}${e.summary !== undefined ? ` — ${e.summary.slice(0, 240)}` : ""}`,
    voice,
    spoken: `${info.severity === "critical" ? "Critical alert" : "Alert"}. ${e.title}.${near !== undefined ? ` ${Math.round(near.km)} kilometers from ${near.name}.` : ""}`,
  }
}

const MAX_ALERTS_PER_SCAN = 2

const dispatchAlerts = (previous: ReadonlyArray<NewsEvent>, merged: ReadonlyArray<NewsEvent>): void => {
  const prevIds = new Set(previous.map((e) => e.id))
  const fresh = merged.filter((e) => !prevIds.has(e.id))
  let sent = 0
  for (const e of fresh) {
    const alert = buildNewsAlert(e)
    if (alert === undefined) continue
    console.warn(`[aimy] globenews alert: ${alert.severity} — ${alert.title}${alert.voice ? " (voice)" : ""}`)
    if (sent >= MAX_ALERTS_PER_SCAN) continue
    sent++
    alertSink?.(alert)
  }
}

export const WORLD_NEWS_SCAN_ID = "globenews-scan"
export const NEWS_SCAN_INTERVAL_MS = 60 * 60 * 1000

export const runNewsScan = async (
  force = false
): Promise<{ added: number; total: number }> => {
  const store = readNewsStore()
  const { incoming, sources, runs } = await scanAll(fetchTextLive, Date.now(), store.runs, force)
  const ran = sources.filter((s) => s.skipped !== true)
  if (ran.length > 0 && ran.every((s) => !s.ok)) {
    throw new Error("globenews scan: all sources unreachable")
  }
  const merged = mergeEvents(store.events, incoming, Date.now())
  writeNewsStore(merged.events, Date.now(), runs, store.voiceDismissed)
  // Warning-tier arrivals leave the widget: banner via the sink
  // (design §4). Detection is diff-based — only events this scan
  // actually brought in can alert, never a refresh of a known one.
  try {
    dispatchAlerts(store.events, merged.events)
  } catch (e) {
    console.error(`[aimy] globenews alert: dispatch failed (${e instanceof Error ? e.message : String(e)})`)
  }
  // The ledger (pattern memory): census the merged store into
  // the daily rollups. Best-effort — a ledger failure never
  // fails the scan.
  try {
    writeLedger(mergeLedger(readLedger(), censusFromEvents(merged.events)))
  } catch (e) {
    console.error(
      `[aimy] globenews ledger: update failed (${e instanceof Error ? e.message : String(e)})`
    )
  }
  console.log(
    `[aimy] globenews scan: ${sources.map((s) => `${s.source}=${s.skipped === true ? "not-due" : s.ok ? s.count : "FAILED"}`).join(" ")} → ${merged.added} new, ${merged.deduped} dupes collapsed, ${merged.events.length} kept`
  )
  return { added: merged.added, total: merged.events.length }
}

export const worldNewsScanJob = (): JobSpec<void, Error> => ({
  id: WORLD_NEWS_SCAN_ID,
  name: "World news scan",
  description:
    "Registry scan (Threat Channel sensors) for the events shown on the GlobeNews widget; per-source cadence, ledger rollup after each run.",
  tier: "T1",
  schedule: {
    _tag: "Cron",
    cron: { minute: cronAt(0), hour: cronAny, dayOfMonth: cronAny, month: cronAny, dayOfWeek: cronAny },
  },
  restart: { _tag: "OnFailure", maxAttempts: 2, backoffMs: 300_000 },
  notify: "on-failure",
  run: Effect.tryPromise({
    try: async () => {
      await runNewsScan()
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }),
})
