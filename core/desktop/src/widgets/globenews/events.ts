/**
 * widgets/globenews/events.ts — the GlobeNews events store.
 *
 * Events live WITH the widget (Kimler's folder rule):
 * ~/.aimy/homedash/available/globenews/events.json, beside its
 * widget.json. One JSON document, rewritten atomically
 * (tmp + rename) by the scan job and by read-marking; bounded by
 * the merge (120 events, 5-day horizon) so it never grows teeth.
 * All reads fail soft to empty — a missing or corrupt store is
 * "no events yet", never a crash.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { NewsEvent } from "./types.js"

export const globenewsDir = (): string =>
  path.join(os.homedir(), ".aimy", "homedash", "available", "globenews")

export const newsEventsFile = (): string => path.join(globenewsDir(), "events.json")

export interface NewsStore {
  readonly events: ReadonlyArray<NewsEvent>
  readonly updatedAtMs: number
  /** Per-source last-scan ms (registry id → ms), for cadence. */
  readonly runs: Readonly<Record<string, number>>
  /** Voice alerts the user has silenced (event id → dismissed-at ms).
   *  Persisted so a dismissed alert never resumes after a restart;
   *  pruned after 7 days (events themselves live 5). */
  readonly voiceDismissed: Readonly<Record<string, number>>
}

export const readNewsStore = (): NewsStore => {
  try {
    const parsed = JSON.parse(fs.readFileSync(newsEventsFile(), "utf-8")) as {
      events?: unknown
      updatedAtMs?: unknown
      runs?: unknown
      voiceDismissed?: unknown
    }
    const events = Array.isArray(parsed.events)
      ? (parsed.events as Array<NewsEvent>)
          .filter(
            (e) => e !== null && typeof e === "object" && typeof e.id === "string" && typeof e.atMs === "number"
          )
          // Category union widened 2026-10-13: legacy "catastrophe"
          // events (pre-widening scans) read as "disaster".
          .map((e) =>
            (e.category as string) === "catastrophe" ? { ...e, category: "disaster" as const } : e
          )
      : []
    const runs =
      parsed.runs !== null && typeof parsed.runs === "object"
        ? (parsed.runs as Record<string, number>)
        : {}
    const voiceDismissed =
      parsed.voiceDismissed !== null && typeof parsed.voiceDismissed === "object"
        ? (parsed.voiceDismissed as Record<string, number>)
        : {}
    return {
      events,
      updatedAtMs: typeof parsed.updatedAtMs === "number" ? parsed.updatedAtMs : 0,
      runs,
      voiceDismissed,
    }
  } catch {
    return { events: [], updatedAtMs: 0, runs: {}, voiceDismissed: {} }
  }
}

const VOICE_DISMISSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000

export const writeNewsStore = (
  events: ReadonlyArray<NewsEvent>,
  updatedAtMs: number,
  runs: Readonly<Record<string, number>> = {},
  voiceDismissed: Readonly<Record<string, number>> = {}
): void => {
  const file = newsEventsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const keptDismissed = Object.fromEntries(
    Object.entries(voiceDismissed).filter(([, at]) => updatedAtMs - at <= VOICE_DISMISSED_KEEP_MS)
  )
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, updatedAtMs, runs, voiceDismissed: keptDismissed, events }, null, 2),
    "utf-8"
  )
  fs.renameSync(tmp, file)
}

/** Flip one event's read flag. Returns false when the id is unknown. */
export const markNewsRead = (id: string): boolean => {
  const store = readNewsStore()
  if (!store.events.some((e) => e.id === id)) return false
  writeNewsStore(
    store.events.map((e) => (e.id === id ? { ...e, read: true } : e)),
    store.updatedAtMs,
    store.runs,
    store.voiceDismissed
  )
  console.log(`[aimy] globenews: marked read ${id}`)
  return true
}

/**
 * Silence one voice alert for good: the dismissal is persisted
 * in the store, so the announcer's boot replay (and any future
 * pattern source) treats the id as done. Recorded even when the
 * event has already rotated out of the store — the intent is
 * what matters. Returns whether the event is in the store.
 */
export const dismissVoiceAlert = (id: string): boolean => {
  const store = readNewsStore()
  writeNewsStore(store.events, store.updatedAtMs, store.runs, {
    ...store.voiceDismissed,
    [id]: Date.now(),
  })
  console.log(`[aimy] globenews: voice alert dismissed ${id}`)
  return store.events.some((e) => e.id === id)
}
