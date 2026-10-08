/**
 * deep-research/test/fanout.test.ts — fan-out purity and politeness.
 *
 * normalizeUrl, queryFor, and dedupeResults are pure. fanOut runs against a
 * stub provider: per-search failures become entries (never thrown), and the
 * politeness delay is asserted via timing bounds (one gap for two questions).
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { dedupeResults, fanOut, normalizeUrl, queryFor } from "../src/fanout.js"
import type { SearchProvider, SearchResult } from "../../web-retrieval/src/provider.js"
import { SEARCH_POLITENESS_DELAY_MS } from "../src/types.js"

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

const r = (url: string, title = "t"): SearchResult => ({ title, url, snippet: "s" })

const stubProvider = (byQuery: Record<string, ReadonlyArray<SearchResult> | Error>): SearchProvider => ({
  name: "stub",
  searchHost: "stub.example",
  search: (q) => {
    const v = byQuery[q]
    if (v === undefined) return Effect.succeed([])
    return v instanceof Error ? Effect.fail(v as never) : Effect.succeed(v)
  },
})

describe("normalizeUrl", () => {
  it("strips tracking params, fragments, and trailing slashes", () => {
    expect(normalizeUrl("https://example.com/a/?utm_source=x&fbclid=1#frag")).toBe("https://example.com/a")
  })

  it("lowercases the host and keeps meaningful params", () => {
    expect(normalizeUrl("HTTPS://EXAMPLE.COM/a?page=2")).toBe("https://example.com/a?page=2")
  })

  it("passes through unparseable input", () => {
    expect(normalizeUrl("not a url")).toBe("not a url")
  })
})

describe("queryFor", () => {
  it("prefixes site scope when present", () => {
    expect(queryFor({ question: "q", intent: "evidence", siteScope: "site:sec.gov" })).toBe("site:sec.gov q")
  })

  it("returns the bare question otherwise", () => {
    expect(queryFor({ question: "q", intent: "evidence" })).toBe("q")
    expect(queryFor({ question: "q", intent: "evidence", siteScope: "  " })).toBe("q")
  })
})

describe("dedupeResults", () => {
  it("dedupes the same URL across sub-questions", () => {
    const entries = [
      { subQuestion: { question: "a", intent: "evidence" as const }, results: [r("https://x.com/1"), r("https://x.com/2")] },
      { subQuestion: { question: "b", intent: "background" as const }, results: [r("https://x.com/2/?utm_x=1"), r("https://x.com/3")] },
    ]
    const out = dedupeResults(entries)
    expect(out.map((x) => x.url)).toEqual(["https://x.com/1", "https://x.com/2", "https://x.com/3"])
  })
})

describe("fanOut", () => {
  it("collects per-search failures as entries, never throws", async () => {
    const provider = stubProvider({
      "site:sec.gov filings": new Error("rate limited"),
      "background q": [r("https://x.com/a")],
    })
    const entries = await run(
      fanOut(provider, [
        { question: "filings", intent: "primary-source", siteScope: "site:sec.gov" },
        { question: "background q", intent: "background" },
      ])
    )
    expect(entries).toHaveLength(2)
    expect(entries[0]?.error?.reason).toContain("rate limited")
    expect(entries[0]?.results).toEqual([])
    expect(entries[1]?.error).toBeUndefined()
    expect(entries[1]?.results).toHaveLength(1)
  })

  it("waits the politeness delay between searches", async () => {
    const provider = stubProvider({})
    const start = Date.now()
    await run(
      fanOut(provider, [
        { question: "a", intent: "evidence" },
        { question: "b", intent: "evidence" },
      ])
    )
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(SEARCH_POLITENESS_DELAY_MS - 100)
  })
})
