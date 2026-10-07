/**
 * web-research/fetcher.ts — fetch a result URL and extract readable text.
 *
 * Two responsibilities, kept separate:
 *
 * 1. `fetchSource` — the ONLY function in this module that performs network
 *    I/O. Before opening any socket it runs `checkFetchEgress` (fail-closed:
 *    https-only, host must be among the search-result hosts for this query).
 *    Timeouts and failures are typed; only text/* responses are accepted.
 *
 * 2. `extractText` — a simple, HONEST text extractor: strips scripts, styles,
 *    comments and tags, decodes common entities, collapses whitespace. It is
 *    deliberately NOT a readability port: it does not identify the "article"
 *    element, does not remove nav/boilerplate, and does not handle JS-rendered
 *    pages. What it returns is the page's visible text, boilerplate included —
 *    documented as such so consumers never mistake it for clean article text.
 */
import { Effect } from "effect"
import { FetchError, type ResearchError } from "./errors.js"
import { checkFetchEgress, HttpClient } from "./http.js"
import { extractRawElementText, htmlToText } from "./html-text.js"
import type { FetchedSource } from "./types.js"

export const FETCH_TIMEOUT_MS = 20_000
export const FETCH_MAX_BYTES = 512 * 1024
export const MAX_TEXT_CHARS = 20_000

/**
 * Extract readable text from HTML. Pure and unit-testable. Single-pass
 * scanner (see html-text.ts) — no regex tag filtering, each entity decoded
 * exactly once. LIMITS (by design, documented here): no main-content
 * detection — nav, footers and boilerplate are included; no JS execution —
 * SPA shells yield almost nothing; no language detection; output truncated
 * to MAX_TEXT_CHARS.
 */
export const extractText = (html: string): string => {
  const text = htmlToText(html)
  return text.replace(/[ \t\f\v\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS)
};

export const extractTitle = (html: string): string => {
  // RCDATA semantics: title content is text (tags not parsed), entities decoded.
  const raw = extractRawElementText(html, "title")
  if (raw === "") return ""
  return raw.replace(/\s+/g, " ").trim().slice(0, 300)
};

export interface FetchDeps {
  readonly http: import("./http.js").HttpClientShape
}

/**
 * Fetch one search-result URL. Enforces the egress policy FIRST (fail-closed),
 * then fetches with timeout + size cap, accepting only text/* responses.
 */
export const fetchSource = (
  deps: FetchDeps,
  url: string,
  resultHosts: ReadonlySet<string>,
): Effect.Effect<FetchedSource, ResearchError> =>
  Effect.gen(function* () {
    yield* checkFetchEgress(url, resultHosts)
    const res = yield* deps.http.request({
      url,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AImy-web-research/1.0" },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
    })
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(new FetchError({ url, reason: `HTTP ${res.status}` }))
    }
    const ct = (res.contentType ?? "").toLowerCase()
    if (ct !== "" && !ct.startsWith("text/")) {
      return yield* Effect.fail(new FetchError({ url, reason: `unsupported content-type '${res.contentType}'` }))
    }
    const text = extractText(res.body)
    if (text === "") {
      return yield* Effect.fail(new FetchError({ url, reason: "no readable text extracted" }))
    }
    return { url, title: extractTitle(res.body), text } satisfies FetchedSource
  })
