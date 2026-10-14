/**
 * web-retrieval/brave-media.ts — the Brave Search verticals (2026-10-13).
 *
 * Brave's API is a family of endpoints, not one: web search (in
 * provider.ts), news, images, and videos each have their own.
 * Kimler's key entitles the Search bundle — web + news + images +
 * videos (probed live 2026-10-13). The remaining Brave options
 * (LLM Context, Local, Answers, Suggest, Spellcheck) are NOT in
 * his plan and answered OPTION_NOT_IN_PLAN; this client maps that
 * response to a plain-language error if it ever appears, so a
 * plan gap is reported as a plan gap, never as a mystery failure.
 *
 * These endpoints exist only on the keyed API — there is no
 * DuckDuckGo equivalent — so the tools built on this client are
 * registered ONLY when a Brave key is configured (see
 * chat/src/retrieval.ts). Honest absence over a dead tool.
 *
 * Same network discipline as the web provider: the only host
 * contacted is api.search.brave.com (manifest-declared), the key
 * travels in the X-Subscription-Token header, and a 429 earns one
 * retry after ~1.1s (the legacy plan's ~1 request/second pace).
 */
import { Effect } from "effect"
import { MalformedSearchResponse, SearchError, type RetrievalError } from "./errors.js"
import { BRAVE_FRESHNESS_CODES, BRAVE_HOST } from "./provider.js"
import type { ImageResult, NewsResult, SearchFreshness, VideoResult } from "./types.js"

const SEARCH_TIMEOUT_MS = 15_000
const SEARCH_MAX_BYTES = 1024 * 1024
const RATE_LIMIT_RETRY_DELAY_MS = 1100

export interface BraveMediaClientDeps {
  readonly http: import("./http.js").HttpClientShape
  readonly apiKey: string
  /** Pause before the single rate-limit retry. Default 1100ms; tests shrink it. */
  readonly retryDelayMs?: number
}

export interface BraveMediaQuery {
  readonly query: string
  readonly freshness?: SearchFreshness | undefined
  readonly count?: number | undefined
}

export interface BraveMediaClient {
  readonly news: (q: BraveMediaQuery) => Effect.Effect<ReadonlyArray<NewsResult>, RetrievalError>
  readonly images: (q: BraveMediaQuery) => Effect.Effect<ReadonlyArray<ImageResult>, RetrievalError>
  readonly videos: (q: BraveMediaQuery) => Effect.Effect<ReadonlyArray<VideoResult>, RetrievalError>
}

const isHttpUrl = (url: string): boolean => {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")

/**
 * One Brave API GET with the shared failure grammar: transport
 * errors map to SearchError, a 429 earns one retry, and non-2xx
 * responses carry plan/key hints (including OPTION_NOT_IN_PLAN,
 * which Brave reports as HTTP 400 with a machine-readable code).
 */
const braveGet = (
  deps: BraveMediaClientDeps,
  label: string,
  path: string,
): Effect.Effect<string, RetrievalError> =>
  Effect.gen(function* () {
    const attempt = () =>
      deps.http
        .request({
          url: `https://${BRAVE_HOST}${path}`,
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
        console.warn(`[aimy] search: Brave rate-limited (429) on ${label} — retrying once after a pause`),
      )
      yield* Effect.sleep(deps.retryDelayMs ?? RATE_LIMIT_RETRY_DELAY_MS)
      res = yield* attempt()
    }
    if (res.status < 200 || res.status >= 300) {
      const notInPlan = res.body.includes("OPTION_NOT_IN_PLAN")
      const hint = notInPlan
        ? " — this Brave endpoint is not included in the current plan (see the plan options at api.search.brave.com)"
        : res.status === 401 || res.status === 403
          ? " — the Brave API key was rejected (check the key in ~/.aimy/search.json)"
          : res.status === 429
            ? " — Brave rate limit / plan quota reached"
            : ""
      return yield* Effect.fail(
        new SearchError({ provider: "brave", reason: `${label}: HTTP ${res.status}${hint}` }),
      )
    }
    return res.body
  })

const parseJsonBody = (body: string, label: string): Effect.Effect<unknown, MalformedSearchResponse> => {
  try {
    return Effect.succeed(JSON.parse(body) as unknown)
  } catch {
    return Effect.fail(
      new MalformedSearchResponse({ provider: "brave", reason: `${label}: response was not JSON` }),
    )
  }
}

const resultsArray = (parsed: unknown, label: string): Effect.Effect<ReadonlyArray<unknown>, MalformedSearchResponse> => {
  const results = (parsed as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) {
    return Effect.fail(
      new MalformedSearchResponse({ provider: "brave", reason: `${label}: response had no results array` }),
    )
  }
  return Effect.succeed(results)
}

/** Parse a Brave News response body. Pure; exported for tests. */
export const parseBraveNewsJson = (
  body: string,
): Effect.Effect<ReadonlyArray<NewsResult>, MalformedSearchResponse> =>
  Effect.flatMap(parseJsonBody(body, "news search"), (parsed) =>
    Effect.map(resultsArray(parsed, "news search"), (results) => {
      const out: Array<NewsResult> = []
      for (const r of results) {
        const item = r as {
          title?: unknown
          url?: unknown
          description?: unknown
          age?: unknown
          profile?: { name?: unknown } | null
          meta_url?: { hostname?: unknown } | null
        }
        if (typeof item.title !== "string" || typeof item.url !== "string") continue
        if (!isHttpUrl(item.url) || item.title === "") continue
        const source = str(item.profile?.name) || str(item.meta_url?.hostname)
        out.push({ title: item.title, url: item.url, snippet: str(item.description), age: str(item.age), source })
      }
      return out
    }),
  )

/** Parse a Brave Images response body. Pure; exported for tests. */
export const parseBraveImagesJson = (
  body: string,
): Effect.Effect<ReadonlyArray<ImageResult>, MalformedSearchResponse> =>
  Effect.flatMap(parseJsonBody(body, "image search"), (parsed) =>
    Effect.map(resultsArray(parsed, "image search"), (results) => {
      const out: Array<ImageResult> = []
      for (const r of results) {
        const item = r as {
          title?: unknown
          url?: unknown
          source?: unknown
          properties?: { url?: unknown } | null
          thumbnail?: { src?: unknown } | null
        }
        const imageUrl = str(item.properties?.url)
        const pageUrl = str(item.url)
        if (imageUrl === "" || !isHttpUrl(imageUrl)) continue
        out.push({
          title: str(item.title),
          pageUrl,
          imageUrl,
          thumbnailUrl: str(item.thumbnail?.src),
          source: str(item.source),
        })
      }
      return out
    }),
  )

/** Parse a Brave Videos response body. Pure; exported for tests. */
export const parseBraveVideosJson = (
  body: string,
): Effect.Effect<ReadonlyArray<VideoResult>, MalformedSearchResponse> =>
  Effect.flatMap(parseJsonBody(body, "video search"), (parsed) =>
    Effect.map(resultsArray(parsed, "video search"), (results) => {
      const out: Array<VideoResult> = []
      for (const r of results) {
        const item = r as {
          title?: unknown
          url?: unknown
          description?: unknown
          age?: unknown
          video?: { duration?: unknown; views?: unknown; creator?: unknown } | null
        }
        if (typeof item.title !== "string" || typeof item.url !== "string") continue
        if (!isHttpUrl(item.url) || item.title === "") continue
        out.push({
          title: item.title,
          url: item.url,
          snippet: str(item.description),
          age: str(item.age),
          duration: str(item.video?.duration),
          views: typeof item.video?.views === "number" ? item.video.views : undefined,
          creator: str(item.video?.creator),
        })
      }
      return out
    }),
  )

/** Build the Brave media client over the shared HTTP seam. */
export const makeBraveMediaClient = (deps: BraveMediaClientDeps): BraveMediaClient => {
  const run = <A>(
    label: string,
    path: string,
    parse: (body: string) => Effect.Effect<ReadonlyArray<A>, MalformedSearchResponse>,
  ): Effect.Effect<ReadonlyArray<A>, RetrievalError> =>
    Effect.flatMap(braveGet(deps, label, path), parse)
  const paramsFor = (q: BraveMediaQuery, withFreshness: boolean): URLSearchParams => {
    const params = new URLSearchParams({ q: q.query, count: String(q.count ?? 10) })
    if (withFreshness && q.freshness !== undefined) {
      params.set("freshness", BRAVE_FRESHNESS_CODES[q.freshness] ?? "pw")
    }
    return params
  }
  return {
    news: (q) => run("news search", `/res/v1/news/search?${paramsFor(q, true).toString()}`, parseBraveNewsJson),
    images: (q) => run("image search", `/res/v1/images/search?${paramsFor(q, false).toString()}`, parseBraveImagesJson),
    videos: (q) => run("video search", `/res/v1/videos/search?${paramsFor(q, true).toString()}`, parseBraveVideosJson),
  }
}

/* ------------------------------------------------------------------ */
/* Model-facing reports: compact, attributed, honest when empty.     */
/* ------------------------------------------------------------------ */

const freshnessNote = (freshness: SearchFreshness | undefined): string =>
  freshness === undefined ? "" : ` (past ${freshness})`

export const formatNewsReport = (
  query: string,
  freshness: SearchFreshness | undefined,
  results: ReadonlyArray<NewsResult>,
): string => {
  if (results.length === 0) return `Brave news search for "${query}"${freshnessNote(freshness)} returned no results (via brave).`
  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.title}${r.source !== "" ? ` — ${r.source}` : ""}${r.age !== "" ? ` (${r.age})` : ""}`
    return r.snippet !== "" ? `${head}\n   ${r.url}\n   ${r.snippet}` : `${head}\n   ${r.url}`
  })
  return [`Brave news search: "${query}"${freshnessNote(freshness)} — ${results.length} result(s) (via brave)`, "", ...lines].join("\n")
}

export const formatImagesReport = (
  query: string,
  results: ReadonlyArray<ImageResult>,
): string => {
  if (results.length === 0) return `Brave image search for "${query}" returned no results (via brave).`
  const lines = results.map((r, i) => {
    const parts = [`${i + 1}. ${r.title !== "" ? r.title : "(untitled image)"}`, `   image: ${r.imageUrl}`]
    if (r.pageUrl !== "") parts.push(`   page: ${r.pageUrl}${r.source !== "" ? ` (${r.source})` : ""}`)
    if (r.thumbnailUrl !== "") parts.push(`   thumbnail: ${r.thumbnailUrl}`)
    return parts.join("\n")
  })
  return [`Brave image search: "${query}" — ${results.length} result(s) (via brave)`, "", ...lines].join("\n")
}

export const formatVideosReport = (
  query: string,
  freshness: SearchFreshness | undefined,
  results: ReadonlyArray<VideoResult>,
): string => {
  if (results.length === 0) return `Brave video search for "${query}"${freshnessNote(freshness)} returned no results (via brave).`
  const lines = results.map((r, i) => {
    const meta = [
      r.duration !== "" ? r.duration : "",
      r.views !== undefined ? `${r.views.toLocaleString("en-US")} views` : "",
      r.creator !== "" ? `by ${r.creator}` : "",
      r.age !== "" ? r.age : "",
    ].filter((s) => s !== "").join(" · ")
    const head = `${i + 1}. ${r.title}${meta !== "" ? ` (${meta})` : ""}`
    return r.snippet !== "" ? `${head}\n   ${r.url}\n   ${r.snippet}` : `${head}\n   ${r.url}`
  })
  return [`Brave video search: "${query}"${freshnessNote(freshness)} — ${results.length} result(s) (via brave)`, "", ...lines].join("\n")
}
