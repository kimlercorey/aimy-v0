/**
 * widgets/globenews/ledger.ts — the pattern layer's memory
 * (Threat Channel design §3, frozen 2026-10-13).
 *
 * The events store is a 5-day display window; patterns need
 * baselines. After each scan the job folds a CENSUS of the
 * merged store into this ledger: per UTC day, event counts by
 * category × region, storm positions (track input), and fire
 * sizes (growth input). Days inside the store window are
 * recomputed from the store (idempotent); older days freeze
 * as recorded. Kept a year, then pruned.
 *
 * Region rules mirror ui/src/field-graph.ts (Local = within
 * 150 km of Tucson / Tall Timbers; US = the isUsEvent boxes) —
 * the two codebases cannot import each other; keep them in sync.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { NewsEvent } from "./types.js"

// Same widget dir as events.ts (kept local so this module
// stands alone): ~/.aimy/homedash/available/globenews/.
const globenewsDir = (): string =>
  path.join(os.homedir(), ".aimy", "homedash", "available", "globenews")

export interface LedgerDay {
  readonly day: string
  /** `${category}|${region}` → live events that day. Region: local | us | world. */
  readonly counts: Readonly<Record<string, number>>
  readonly storms: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly lat: number
    readonly lon: number
  }>
  /** WFIGS event id → acres (from the event summary). */
  readonly fires: Readonly<Record<string, number>>
}

export interface NewsLedger {
  readonly days: ReadonlyArray<LedgerDay>
}

const WATCHED: ReadonlyArray<{ name: string; lat: number; lon: number }> = [
  { name: "Tucson", lat: 32.2, lon: -110.9 },
  { name: "Tall Timbers", lat: 38.3, lon: -76.7 },
]

const distanceKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** The nearest watched place and its distance; undefined for feed-only events. */
export const nearestWatchedPlace = (e: {
  lat?: number | undefined
  lon?: number | undefined
}): { name: string; km: number } | undefined => {
  if (e.lat === undefined || e.lon === undefined) return undefined
  let best: { name: string; km: number } | undefined
  for (const p of WATCHED) {
    const km = distanceKm(e.lat, e.lon, p.lat, p.lon)
    if (best === undefined || km < best.km) best = { name: p.name, km }
  }
  return best
}

/** Distance in km to the nearest watched place; undefined for feed-only events. */
export const nearestWatchedKm = (e: {
  lat?: number | undefined
  lon?: number | undefined
}): number | undefined => nearestWatchedPlace(e)?.km

export const regionOf = (e: { lat?: number | undefined; lon?: number | undefined }): string => {
  if (e.lat === undefined || e.lon === undefined) return "world"
  for (const p of WATCHED) if (distanceKm(e.lat, e.lon, p.lat, p.lon) <= 150) return "local"
  const { lat, lon } = e
  if (
    (lat >= 24.5 && lat <= 49.5 && lon >= -125 && lon <= -66.5) ||
    (lat >= 51 && lat <= 71.5 && lon >= -170 && lon <= -129.5) ||
    (lat >= 18.5 && lat <= 22.5 && lon >= -161 && lon <= -154.5)
  )
    return "us"
  return "world"
}

export const dayKeyOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10)

/** Census the store's events into per-day rollups. */
export const censusFromEvents = (events: ReadonlyArray<NewsEvent>): Array<LedgerDay> => {
  const byDay = new Map<
    string,
    {
      counts: Record<string, number>
      storms: Map<string, { id: string; name: string; lat: number; lon: number }>
      fires: Record<string, number>
    }
  >()
  for (const e of events) {
    const day = dayKeyOf(e.atMs)
    let slot = byDay.get(day)
    if (slot === undefined) {
      slot = { counts: {}, storms: new Map(), fires: {} }
      byDay.set(day, slot)
    }
    const key = `${e.category}|${regionOf(e)}`
    slot.counts[key] = (slot.counts[key] ?? 0) + 1
    if (e.source === "NHC" && e.lat !== undefined && e.lon !== undefined) {
      slot.storms.set(e.id, { id: e.id, name: e.title, lat: e.lat, lon: e.lon })
    }
    if (e.source === "WFIGS" && e.summary !== undefined) {
      const acres = /([\d,]+) acres/.exec(e.summary)?.[1]
      if (acres !== undefined) slot.fires[e.id] = Number(acres.replace(/,/g, ""))
    }
  }
  return [...byDay.entries()]
    .map(([day, slot]) => ({
      day,
      counts: slot.counts,
      storms: [...slot.storms.values()],
      fires: slot.fires,
    }))
    .sort((a, b) => (a.day < b.day ? 1 : -1))
}

const LEDGER_KEEP_DAYS = 370

/** Replace the census days, keep frozen older days, prune to a year. */
export const mergeLedger = (
  existing: NewsLedger,
  census: ReadonlyArray<LedgerDay>
): NewsLedger => {
  const censusDays = new Set(census.map((d) => d.day))
  const kept = existing.days.filter((d) => !censusDays.has(d.day))
  const days = [...census, ...kept]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, LEDGER_KEEP_DAYS)
  return { days }
}

// ── File IO (mirrors events.ts: fail-soft reads, atomic writes)

export const ledgerFile = (): string => path.join(globenewsDir(), "ledger.json")

export const readLedger = (): NewsLedger => {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(), "utf-8")) as { days?: unknown }
    return { days: Array.isArray(parsed.days) ? (parsed.days as Array<LedgerDay>) : [] }
  } catch {
    return { days: [] }
  }
}

export const writeLedger = (ledger: NewsLedger): void => {
  const file = ledgerFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf-8")
  fs.renameSync(tmp, file)
}
