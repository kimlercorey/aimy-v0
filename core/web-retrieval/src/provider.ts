/**
 * web-retrieval/provider.ts — the SearchProvider seam.
 *
 * THE SEAM: `SearchProvider` is the interface the retrieval flow programs
 * against. `DuckDuckGoHtmlProvider` is the default implementation — no API
 * key, no account, no telemetry — but it is deliberately replaceable: any
 * provider (Brave Search API, a local SearXNG, an MCP search server) can be
 * dropped in without touching the retrieval flow, the fetcher, or the
 * honesty wiring. The provider declares its `searchHost`, which is exactly
 * the host the capability manifest allowlists.
 *
 * DuckDuckGo HTML parsing is brittle by nature: DDG may change markup or
 * rate-limit scraping at any time. That brittleness is handled honestly —
 * an unrecognizable response is a typed `MalformedSearchResponse` (not a
 * silent empty result), and the provider documents its limits rather than
 * pretending to be a stable API.
 *
 * Rate limiting has its own honest shape (2026-10-13): DDG answers
 * flagged query bursts with an HTTP-200 bot-challenge interstitial
 * (the "anomaly" page). That page is classified BEFORE parsing as a
 * typed `SearchChallenged` — after one bounded retry, since a single
 * challenge is often transient — so a block is never misreported as
 * changed markup or as an empty result.
 */
import { Effect } from "effect"
import { MalformedSearchResponse, SearchChallenged, SearchError, type RetrievalError } from "./errors.js"
import { HttpClient } from "./http.js"
import { htmlToText } from "./html-text.js"
import type { SearchOptions, SearchResult } from "./types.js"

export interface SearchProvider {
  /** Human name, used in error tags. */
  readonly name: string
  /** The single host this provider talks to — mirrors the manifest's vendorHosts. */
  readonly searchHost: string
  readonly search: (query: string, opts?: SearchOptions) => Effect.Effect<ReadonlyArray<SearchResult>, RetrievalError>
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
/**
 * DuckDuckGo's bot-challenge interstitial (captured live 2026-10-13):
 * an HTTP-200 page whose body carries an `anomaly-modal` block, a
 * `challenge-form` posting to anomaly.js, and the text "Unfortunately,
 * bots use DuckDuckGo too." None of these markers occur in a genuine
 * results or no-results page (verified against captured SERPs), so any
 * one of them classifies the page. This is a block, not a parse target.
 */
const CHALLENGE_RE = /anomaly-modal|challenge-form|anomaly\.js|bots use DuckDuckGo/i

export const isChallengePage = (body: string): boolean => CHALLENGE_RE.test(body)

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
  /** Pause before the single challenge retry. Default 2500ms; tests shrink it. */
  readonly retryDelayMs?: number
}

/**
 * The client identifies as a current macOS browser (the app runs on
 * macOS). The previous string claimed Linux/X11 and carried a
 * self-declared bot token — a combination DDG's bot scoring weighs
 * heavily, and factually wrong about the platform besides.
 */
const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

const CHALLENGE_RETRY_DELAY_MS = 2500

/**
 * Default search provider. Issues one GET to the DuckDuckGo HTML endpoint —
 * the ONLY host this provider ever contacts, matching the manifest's
 * declared vendor host exactly. A bot-challenge page earns exactly ONE
 * retry after a short pause (challenges are often transient — the same
 * query succeeds seconds later); a second challenge is a typed
 * SearchChallenged, never a silent empty result.
 */
export const makeDuckDuckGoHtmlProvider = (deps: DuckDuckGoHtmlProviderDeps): SearchProvider => ({
  name: "duckduckgo-html",
  searchHost: DUCKDUCKGO_HOST,
  // SearchOptions (freshness / result filter) are not honored by
  // the DDG HTML endpoint contract this provider implements — the
  // options are accepted and ignored, never faked.
  search: (query, _opts) =>
    Effect.gen(function* () {
      if (query.trim() === "") {
        return yield* Effect.fail(
          new SearchError({ provider: "duckduckgo-html", reason: "query is empty" }),
        )
      }
      const url = `https://${DUCKDUCKGO_HOST}/html/?q=${encodeURIComponent(query)}`
      const attempt = () =>
        deps.http
          .request({
            url,
            method: "GET",
            headers: { "User-Agent": SEARCH_USER_AGENT },
            timeoutMs: SEARCH_TIMEOUT_MS,
            maxBytes: SEARCH_MAX_BYTES,
          })
          .pipe(
            Effect.mapError(
              (e): RetrievalError =>
                e._tag === "FetchTimeout"
                  ? new SearchError({ provider: "duckduckgo-html", reason: `timed out after ${e.timeoutMs}ms` })
                  : new SearchError({ provider: "duckduckgo-html", reason: e.reason }),
            ),
          )
      let res = yield* attempt()
      if (res.status >= 200 && res.status < 300 && isChallengePage(res.body)) {
        yield* Effect.sync(() =>
          console.warn(`[aimy] search: DuckDuckGo served a bot-challenge page for "${query}" — retrying once`),
        )
        yield* Effect.sleep(deps.retryDelayMs ?? CHALLENGE_RETRY_DELAY_MS)
        res = yield* attempt()
        if (res.status >= 200 && res.status < 300 && isChallengePage(res.body)) {
          yield* Effect.sync(() =>
            console.warn(`[aimy] search: bot-challenge persisted for "${query}" — reporting blocked`),
          )
          return yield* Effect.fail(
            new SearchChallenged({
              provider: "duckduckgo-html",
              reason:
                "DuckDuckGo is refusing automated queries from this network right now (bot-challenge / rate-limit page instead of results). Search is temporarily BLOCKED — this is not an empty result and not a parse failure. Waiting, or trying again later, is the remedy.",
            }),
          )
        }
      }
      if (res.status < 200 || res.status >= 300) {
        return yield* Effect.fail(
          new SearchError({ provider: "duckduckgo-html", reason: `HTTP ${res.status}` }),
        )
      }
      return yield* parseDuckHtml(res.body)
    }),
})

export const BRAVE_HOST = "api.search.brave.com"

export interface BraveSearchProviderDeps {
  readonly http: import("./http.js").HttpClientShape
  readonly apiKey: string
  /** Pause before the single rate-limit retry. Default 1100ms; tests shrink it. */
  readonly retryDelayMs?: number
}

/**
 * Legacy Brave plans allow ~1 request/second (verified live
 * 2026-10-13: a second immediate call answered HTTP 429). One
 * retry after ~1.1s turns most burst 429s into answers; a second
 * 429 is a real limit and surfaces as SearchError (the chain then
 * falls back to DuckDuckGo).
 */
const BRAVE_RATE_LIMIT_RETRY_DELAY_MS = 1100

/**
 * Parse a Brave Search API response body. Pure; exported for tests.
 * Honest outcomes mirror the DDG parser: a results array (possibly
 * empty — an empty answer is an ANSWER, not a failure) parses;
 * anything else is MalformedSearchResponse.
 */
export const parseBraveJson = (
  body: string,
): Effect.Effect<ReadonlyArray<SearchResult>, MalformedSearchResponse> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return Effect.fail(
      new MalformedSearchResponse({ provider: "brave", reason: "response was not JSON" }),
    )
  }
  const results = (parsed as { web?: { results?: unknown } } | null)?.web?.results
  if (!Array.isArray(results)) {
    return Effect.fail(
      new MalformedSearchResponse({ provider: "brave", reason: "response had no web.results array" }),
    )
  }
  const out: Array<SearchResult> = []
  for (const r of results) {
    const item = r as { title?: unknown; url?: unknown; description?: unknown }
    if (typeof item.title !== "string" || typeof item.url !== "string") continue
    if (!isHttpUrl(item.url) || item.title === "") continue
    out.push({
      title: item.title,
      url: item.url,
      snippet: typeof item.description === "string" ? item.description : "",
    })
  }
  return Effect.succeed(out)
}

/**
 * Brave Search API provider (2026-10-13): a real keyed API — the
 * durable answer to DDG's bot wall. The key travels in the
 * X-Subscription-Token header; the ONLY host contacted is
 * api.search.brave.com, declared in the module manifest.
 */
/** Brave freshness codes for the SearchFreshness windows. */
export const BRAVE_FRESHNESS_CODES: Readonly<Record<string, string>> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
}

export const makeBraveSearchProvider = (deps: BraveSearchProviderDeps): SearchProvider => ({
  name: "brave",
  searchHost: BRAVE_HOST,
  search: (query, opts) =>
    Effect.gen(function* () {
      if (query.trim() === "") {
        return yield* Effect.fail(
          new SearchError({ provider: "brave", reason: "query is empty" }),
        )
      }
      const params = new URLSearchParams({ q: query, count: "10" })
      if (opts?.freshness !== undefined) params.set("freshness", BRAVE_FRESHNESS_CODES[opts.freshness] ?? "pw")
      if (opts?.resultFilter !== undefined && opts.resultFilter.trim() !== "") params.set("result_filter", opts.resultFilter)
      const url = `https://${BRAVE_HOST}/res/v1/web/search?${params.toString()}`
      const attempt = () =>
        deps.http
          .request({
            url,
            method: "GET",
            headers: {
              Accept: "application/json",
              "X-Subscription-Token": deps.apiKey,
            },
            timeoutMs: SEARCH_TIMEOUT_MS,
            maxBytes: SEARCH_MAX_BYTES,
          })
          .pipe(
            Effect.mapError(
              (e): RetrievalError =>
                e._tag === "FetchTimeout"
                  ? new SearchError({ provider: "brave", reason: `timed out after ${e.timeoutMs}ms` })
                  : new SearchError({ provider: "brave", reason: e.reason }),
            ),
          )
      let res = yield* attempt()
      if (res.status === 429) {
        yield* Effect.sync(() =>
          console.warn(`[aimy] search: Brave rate-limited (429) for "${query}" — retrying once after a pause`),
        )
        yield* Effect.sleep(deps.retryDelayMs ?? BRAVE_RATE_LIMIT_RETRY_DELAY_MS)
        res = yield* attempt()
      }
      if (res.status < 200 || res.status >= 300) {
        const hint =
          res.status === 401 || res.status === 403
            ? " — the Brave API key was rejected (check the key in ~/.aimy/search.json)"
            : res.status === 429
              ? " — Brave rate limit / plan quota reached"
              : ""
        return yield* Effect.fail(
          new SearchError({ provider: "brave", reason: `HTTP ${res.status}${hint}` }),
        )
      }
      return yield* parseBraveJson(res.body)
    }),
})

/**
 * Provider chain (2026-10-13): try providers in order; fall through
 * ONLY on failure — an empty result from a healthy provider is an
 * answer and never triggers fallback. If every provider fails, the
 * FIRST provider's error surfaces (the primary's state is the
 * headline fact; the others' failures are logged). `name` reports
 * the provider that actually served the last search, so the
 * retrieval report can attribute its answer honestly.
 */
export const makeChainedSearchProvider = (
  providers: ReadonlyArray<SearchProvider>,
): SearchProvider => {
  let lastServed: string | undefined
  const tryFrom = (
    index: number,
    firstError: RetrievalError | undefined,
    query: string,
    opts: SearchOptions | undefined,
  ): Effect.Effect<ReadonlyArray<SearchResult>, RetrievalError> => {
    const provider = providers[index]
    if (provider === undefined) {
      return Effect.fail(
        firstError ??
          new SearchError({ provider: "search-chain", reason: "no search providers configured" }),
      )
    }
    return provider.search(query, opts).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          lastServed = provider.name
        }),
      ),
      Effect.catch((e) =>
        Effect.sync(() =>
          console.warn(
            `[aimy] search: provider ${provider.name} failed (${e._tag}: ${(e as { reason?: string }).reason ?? "no reason given"})${providers[index + 1] !== undefined ? ` — falling back to ${providers[index + 1]!.name}` : " — no fallback left"}`,
          ),
        ).pipe(Effect.flatMap(() => tryFrom(index + 1, firstError ?? e, query, opts))), 
      ),
    )
  }
  return {
    get name() {
      return lastServed ?? "search-chain"
    },
    searchHost: providers[0]?.searchHost ?? DUCKDUCKGO_HOST,
    search: (query, opts) => tryFrom(0, undefined, query, opts),
  }
}
