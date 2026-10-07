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
 * 2. Text extraction — `extractMainText` runs the readability pass
 *    (readability.ts): nav, headers, footers, sidebars, cookie banners and
 *    other boilerplate are scored out and the article subtree is extracted.
 *    When nothing scores as an article it falls back to `extractText`
 *    (full visible text, boilerplate included) and reports
 *    `mainContent: false` — the fallback is labeled, never silent.
 *    Neither pass executes JavaScript: a script-heavy page with almost no
 *    visible text fails honestly as "requires JavaScript".
 */
import { Effect } from "effect"
import { FetchError, type ResearchError } from "./errors.js"
import { checkFetchEgress, HttpClient } from "./http.js"
import { extractRawElementText, htmlToText } from "./html-text.js"
import { extractMainContent, isJsShell, MIN_MAIN_CHARS } from "./readability.js"
import type { FetchedSource } from "./types.js"

export const FETCH_TIMEOUT_MS = 20_000
export const FETCH_MAX_BYTES = 512 * 1024
export const MAX_TEXT_CHARS = 20_000

/**
 * Extract readable text from HTML. Pure and unit-testable. Single-pass
 * scanner (see html-text.ts) — no regex tag filtering, each entity decoded
 * exactly once. This is the FULL-page fallback: nav, footers and
 * boilerplate are included; no JS execution — SPA shells yield almost
 * nothing. Prefer `extractMainText`, which tries the article first.
 */
export const extractText = (html: string): string => {
  const text = htmlToText(html)
  return text.replace(/[ \t\f\v\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS)
};

/**
 * Extract the page's main content, falling back to full-page text.
 * Pure and unit-testable. `mainContent: true` means boilerplate was
 * removed; `false` means the text is the full page (or empty) and the
 * caller must not present it as a clean article.
 */
export const extractMainText = (html: string): { text: string; mainContent: boolean } => {
  const main = extractMainContent(html)
  if (main.mainContent) {
    return { text: main.text.slice(0, MAX_TEXT_CHARS), mainContent: true }
  }
  return { text: extractText(html), mainContent: false }
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
    const { text, mainContent } = extractMainText(res.body)
    // A JS shell whose visible text never reaches the main-content bar is
    // not a source: returning it would badge a 3-character title as a
    // verified claim. Fail it as what it is.
    const jsShell = isJsShell(res.body)
    if (text === "" || (jsShell && text.length < MIN_MAIN_CHARS)) {
      const reason = jsShell
        ? "page appears to require JavaScript to render"
        : "no readable text extracted"
      return yield* Effect.fail(new FetchError({ url, reason }))
    }
    return { url, title: extractTitle(res.body), text, mainContent } satisfies FetchedSource
  })
