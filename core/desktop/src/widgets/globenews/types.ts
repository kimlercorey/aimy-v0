/**
 * widgets/globenews/types.ts — the GlobeNews widget's shared types.
 *
 * ALL GlobeNews-specific code lives in this folder (Kimler,
 * 2026-10-13): the manifest, the scanner, the events store, the
 * scan job, and (under renderer/widgets/globenews/) the globe
 * engine and the feed link overlay. The platform only knows the
 * manifest and the IPC contract.
 */

/**
 * Event classes the widget renders (widened 2026-10-13 for the
 * US sources + category-coloured dots and feed icons). Legacy
 * stored events with category "catastrophe" are normalised to
 * "disaster" on read (events.ts).
 */
export type NewsCategory =
  | "conflict"
  | "unrest"
  | "earthquake"
  | "fire"
  | "weather"
  | "disaster"

/**
 * One world event. `lat`/`lon` are absent when the source gave no
 * location and the headline matched no known place — such events
 * live in the feed only (no dot, no line); locations are never
 * invented.
 */
export interface NewsEvent {
  readonly id: string
  readonly title: string
  readonly category: NewsCategory
  /** Source label, e.g. "GDACS", "BBC", "Al Jazeera". */
  readonly source: string
  readonly url: string
  /** When the event was reported (source timestamp), epoch ms. */
  readonly atMs: number
  readonly lat?: number | undefined
  readonly lon?: number | undefined
  /** Human place name when known (GDACS country / gazetteer hit). */
  readonly place?: string | undefined
  /** The source's own summary text (RSS description), when given. */
  readonly summary?: string | undefined
  /**
   * Full text for API-native sources (the NWS alert's description
   * + instruction). When present, the article opens with this
   * instead of fetching the source URL — an API JSON payload is
   * not an article (2026-10-13).
   */
  readonly detail?: string | undefined
  readonly read: boolean
}

/** Events older than this leave both the globe and the feed. */
export const NEWS_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000

/**
 * The age bands Kimler specified: green under 24 hours, orange
 * from 24 hours to 5 days, gone past 5 days.
 */
export type NewsAgeBand = "fresh" | "recent" | "old"
export const newsAgeBand = (atMs: number, nowMs: number): NewsAgeBand => {
  const age = nowMs - atMs
  if (age < 24 * 60 * 60 * 1000) return "fresh"
  if (age < NEWS_MAX_AGE_MS) return "recent"
  return "old"
}

/**
 * Dot/chip colour per category (Kimler, 2026-10-13: dots and
 * feed icons share the category palette). Freshness is carried
 * by opacity instead — full under 24h, dimmer out to 5 days —
 * and read stays the cyan ring. The renderer engine mirrors
 * these values (it cannot import main-side modules).
 */
export const NEWS_CATEGORY_RGB: Record<NewsCategory, string> = {
  conflict: "248, 113, 113",
  unrest: "167, 139, 250",
  earthquake: "251, 191, 36",
  fire: "249, 115, 22",
  weather: "56, 189, 248",
  disaster: "74, 222, 128",
}

export const NEWS_CATEGORY_LABEL: Record<NewsCategory, string> = {
  conflict: "Conflict",
  unrest: "Unrest",
  earthquake: "Earthquake",
  fire: "Fire",
  weather: "Weather",
  disaster: "Disaster",
}
