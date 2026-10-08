/**
 * deep-research/fanout.ts — Stage 2: run each sub-question as a search, politely.
 *
 * One DDG query per sub-question (`${siteScope} ${question}`), ≥1200ms apart
 * (SEARCH_POLITENESS_DELAY_MS). Results are deduped by normalized URL across
 * sub-questions — the same source answering two sub-questions is fetched once.
 *
 * Failure contract: a single search failing drops that sub-question with its
 * reason recorded (FanOutSearchError, collected — not thrown); the fan-out
 * continues with the rest. An empty fan-out (every search failed or empty)
 * is a valid result: the report says "no sources found".
 */
import { Effect } from "effect"
import type { SearchProvider } from "../../web-retrieval/src/provider.js"
import type { SearchResult } from "../../web-retrieval/src/types.js"
import { FanOutSearchError } from "./errors.js"
import { SEARCH_POLITENESS_DELAY_MS } from "./types.js"
import type { SubQuestion } from "./types.js"

/** One sub-question's search outcome: results, or the reason it produced none. */
export interface FanOutEntry {
  readonly subQuestion: SubQuestion
  readonly results: ReadonlyArray<SearchResult>
  readonly error?: FanOutSearchError | undefined
}

/**
 * Normalize a URL for dedupe: lowercase host, strip tracking params,
 * fragment, and trailing slash. Pure.
 */
export const normalizeUrl = (url: string): string => {
  try {
    const u = new URL(url)
    u.hash = ""
    const params = new URLSearchParams(u.search)
    for (const key of [...params.keys()]) {
      if (/^(utm_|fbclid$|gclid$|msclkid$|ref$)/i.test(key)) params.delete(key)
    }
    u.search = params.toString()
    const search = u.search.startsWith("?") ? u.search : u.search === "" ? "" : `?${u.search}`
    let s = `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}${search}`
    if (s.endsWith("/") && s.length > 1) s = s.slice(0, -1)
    return s
  } catch {
    return url
  }
}

/** Dedupe search results across sub-questions by normalized URL. Pure. */
export const dedupeResults = (
  entries: ReadonlyArray<FanOutEntry>
): ReadonlyArray<SearchResult> => {
  const seen = new Set<string>()
  const out: Array<SearchResult> = []
  for (const entry of entries) {
    for (const r of entry.results) {
      const key = normalizeUrl(r.url)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(r)
      }
    }
  }
  return out
}

/** Build the provider query string for a sub-question. Pure. */
export const queryFor = (sub: SubQuestion): string =>
  sub.siteScope !== undefined && sub.siteScope.trim() !== ""
    ? `${sub.siteScope.trim()} ${sub.question}`
    : sub.question

const searchOne = (
  provider: SearchProvider,
  sub: SubQuestion
): Effect.Effect<FanOutEntry, never> =>
  provider.search(queryFor(sub)).pipe(
    Effect.map(
      (results): FanOutEntry => ({ subQuestion: sub, results, error: undefined })
    ),
    Effect.catch((e) =>
      Effect.succeed({
        subQuestion: sub,
        results: [],
        error: new FanOutSearchError({
          subQuestion: sub.question,
          reason: e instanceof Error ? e.message : String(e),
        }),
      } satisfies FanOutEntry)
    )
  )

/**
 * Run the fan-out: one polite search per sub-question, in order.
 * Per-search failures are collected as entries, never thrown.
 */
export const fanOut = (
  provider: SearchProvider,
  subQuestions: ReadonlyArray<SubQuestion>
): Effect.Effect<ReadonlyArray<FanOutEntry>, never> =>
  Effect.forEach(subQuestions, (sub, index) => {
    const delayed =
      index === 0
        ? searchOne(provider, sub)
        : Effect.sleep(SEARCH_POLITENESS_DELAY_MS).pipe(Effect.andThen(searchOne(provider, sub)))
    return delayed
  })
