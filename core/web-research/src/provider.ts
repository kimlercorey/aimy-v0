/**
 * web-research/provider.ts — the SearchProvider seam.
 *
 * THE SEAM: `SearchProvider` is the interface the research flow programs
 * against. `DuckDuckGoHtmlProvider` is the default implementation — no API
 * key, no account, no telemetry — but it is deliberately replaceable: any
 * provider (Brave Search API, a local SearXNG, an MCP search server) can be
 * dropped in without touching the research flow, the fetcher, or the
 * honesty wiring. The provider declares its `searchHost`, which is exactly
 * the host the capability manifest allowlists.
 *
 * DuckDuckGo HTML parsing is brittle by nature: DDG may change markup or
 * rate-limit scraping at any time. That brittleness is handled honestly —
 * an unrecognizable response is a typed `MalformedSearchResponse` (not a
 * silent empty result), and the provider documents its limits rather than
 * pretending to be a stable API.
 */
import { Effect } from "effect"
import { MalformedSearchResponse, SearchError, type ResearchError } from "./errors.js"
import { HttpClient } from "./http.js"
import { htmlToText } from "./html-text.js"
import type { SearchResult } from "./types.js"

export interface SearchProvider {
  /** Human name, used in error tags. */
  readonly name: string
  /** The single host this provider talks to — mirrors the manifest's vendorHosts. */
  readonly searchHost: string
  readonly search: (query: string) => Effect.Effect<ReadonlyArray<SearchResult>, ResearchError>
}

export const DUCKDUCKGO_HOST = "html.duckduckgo.com"
const SEARCH_TIMEOUT_MS = 15_000
const SEARCH_MAX_BYTES = 512 * 1024

/**
 * Strip markup to plain text via the single-pass scanner (html-text.ts).
 * No regex tag filtering — see that module for why.
 */
const stripTags = (s: string): string => htmlToText(s).replace(/\s+/g, " ").trim()

/**
 * DuckDuckGo wraps outbound links as //duckduckgo.com/l/?uddg=<urlencoded>.
 * Unwrap to the real destination; leave direct links alone.
 */
export const unwrapDuckLink = (href: string): string => {
  const m = /^(?:https?:)?\/\/duckduckgo\.com\/l\/\?([^#]*)/i.exec(href)
  if (m === null || m[1] === undefined) return href
  const uddg = new URLSearchParams(m[1]).get("uddg")
  if (uddg === null) return href
  try {
    return decodeURIComponent(uddg)
  } catch {
    return href
  }
}

const RESULT_ANCHOR_RE =
  /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
const SNIPPET_RE =
  /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i
const NO_RESULTS_RE = /class="[^"]*\bno-results\b/i

const isHttpUrl = (url: string): boolean => {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Parse the DuckDuckGo HTML results page. Pure function over the body so it
 * is unit-testable without any network. Returns the results in page order.
 *
 * Honest outcomes:
 * - result anchors found        -> parsed results (possibly zero usable links)
 * - "no results" marker present -> [] (a legitimate empty search)
 * - neither                     -> MalformedSearchResponse (markup changed)
 */
export const parseDuckHtml = (
  body: string,
): Effect.Effect<ReadonlyArray<SearchResult>, MalformedSearchResponse> => {
  const out: Array<SearchResult> = []
  // Split into per-result blocks so each snippet stays with its own anchor.
  const blocks = body.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i)
  for (const block of blocks.slice(1)) {
    RESULT_ANCHOR_RE.lastIndex = 0
    const anchor = RESULT_ANCHOR_RE.exec(block)
    if (anchor === null || anchor[1] === undefined || anchor[2] === undefined) continue
    const url = unwrapDuckLink(anchor[1])
    if (!isHttpUrl(url)) continue
    const title = stripTags(anchor[2])
    if (title === "") continue
    SNIPPET_RE.lastIndex = 0
    const snippetMatch = SNIPPET_RE.exec(block)
    const snippet = snippetMatch?.[1] !== undefined ? stripTags(snippetMatch[1]) : ""
    out.push({ title, url, snippet })
  }
  if (out.length > 0 || NO_RESULTS_RE.test(body)) {
    return Effect.succeed(out)
  }
  return Effect.fail(
    new MalformedSearchResponse({
      provider: "duckduckgo-html",
      reason: "no result anchors and no no-results marker: provider markup unrecognized",
    }),
  )
};

export interface DuckDuckGoHtmlProviderDeps {
  readonly http: import("./http.js").HttpClientShape
}

/**
 * Default search provider. Issues one GET to the DuckDuckGo HTML endpoint —
 * the ONLY host this provider ever contacts, matching the manifest's
 * declared vendor host exactly.
 */
export const makeDuckDuckGoHtmlProvider = (deps: DuckDuckGoHtmlProviderDeps): SearchProvider => ({
  name: "duckduckgo-html",
  searchHost: DUCKDUCKGO_HOST,
  search: (query) =>
    Effect.gen(function* () {
      if (query.trim() === "") {
        return yield* Effect.fail(
          new SearchError({ provider: "duckduckgo-html", reason: "query is empty" }),
        )
      }
      const url = `https://${DUCKDUCKGO_HOST}/html/?q=${encodeURIComponent(query)}`
      const res = yield* deps.http
        .request({
          url,
          method: "GET",
          headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AImy-web-research/1.0" },
          timeoutMs: SEARCH_TIMEOUT_MS,
          maxBytes: SEARCH_MAX_BYTES,
        })
        .pipe(
          Effect.mapError(
            (e): ResearchError =>
              e._tag === "FetchTimeout"
                ? new SearchError({ provider: "duckduckgo-html", reason: `timed out after ${e.timeoutMs}ms` })
                : new SearchError({ provider: "duckduckgo-html", reason: e.reason }),
          ),
        )
      if (res.status < 200 || res.status >= 300) {
        return yield* Effect.fail(
          new SearchError({ provider: "duckduckgo-html", reason: `HTTP ${res.status}` }),
        )
      }
      return yield* parseDuckHtml(res.body)
    }),
})
