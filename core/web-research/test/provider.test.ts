/**
 * provider.test.ts — DuckDuckGo HTML parsing over fixtures. No network.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  DUCKDUCKGO_HOST,
  makeDuckDuckGoHtmlProvider,
  parseDuckHtml,
  unwrapDuckLink,
} from "../src/provider.js"
import { makeMockHttpClient } from "../src/http.js"
import { HttpClient } from "../src/http.js"
import {
  DDG_GARBAGE_FIXTURE,
  DDG_HTML_FIXTURE,
  DDG_NO_RESULTS_FIXTURE,
  failingHandler,
  ok,
} from "./fixtures.js"

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff as Effect.Effect<A, E>)

describe("unwrapDuckLink", () => {
  it("unwraps //duckduckgo.com/l/?uddg= redirect wrappers", () => {
    expect(unwrapDuckLink("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx&rut=1")).toBe(
      "https://example.com/x",
    )
  })
  it("leaves direct links alone", () => {
    expect(unwrapDuckLink("https://example.org/second")).toBe("https://example.org/second")
  })
})

describe("parseDuckHtml", () => {
  it("parses results in page order, unwrapping DDG redirect links", async () => {
    const results = await run(parseDuckHtml(DDG_HTML_FIXTURE))
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({
      title: "First Result Title",
      url: "https://example.com/first",
      snippet: "First snippet text with markup inside.",
    })
    expect(results[1]).toMatchObject({
      title: "Second Result Title",
      url: "https://example.org/second",
      snippet: "Second snippet & more.",
    })
    // Third result has no snippet anchor: snippet defaults to "".
    expect(results[2]).toMatchObject({ url: "http://insecure.example.net/plain", snippet: "" })
  })

  it("returns [] for a genuine no-results page", async () => {
    const results = await run(parseDuckHtml(DDG_NO_RESULTS_FIXTURE))
    expect(results).toEqual([])
  })

  it("fails typed MalformedSearchResponse on unrecognized markup", async () => {
    const err = await run(Effect.flip(parseDuckHtml(DDG_GARBAGE_FIXTURE)))
    expect(err._tag).toBe("MalformedSearchResponse")
  })
})

describe("makeDuckDuckGoHtmlProvider", () => {
  it("declares exactly the manifest's search host", () => {
    const provider = makeDuckDuckGoHtmlProvider({ http: null as never })
    expect(provider.name).toBe("duckduckgo-html")
    expect(provider.searchHost).toBe(DUCKDUCKGO_HOST)
    expect(DUCKDUCKGO_HOST).toBe("html.duckduckgo.com")
  })

  it("searches via the mock HTTP layer (no socket)", async () => {
    const layer = makeMockHttpClient(() => Effect.succeed(ok(DDG_HTML_FIXTURE)))
    const program = Effect.flatMap(HttpClient, (http) =>
      makeDuckDuckGoHtmlProvider({ http }).search("test query"),
    )
    const results = await run(Effect.provide(program, layer))
    expect(results).toHaveLength(3)
    expect(results[0]?.url).toBe("https://example.com/first")
  })

  it("rejects an empty query with typed SearchError", async () => {
    const layer = makeMockHttpClient(() => Effect.succeed(ok(DDG_HTML_FIXTURE)))
    const program = Effect.flatMap(HttpClient, (http) =>
      makeDuckDuckGoHtmlProvider({ http }).search("   "),
    )
    const err = await run(Effect.flip(Effect.provide(program, layer)))
    expect(err._tag).toBe("SearchError")
  })

  it("maps transport failures to typed SearchError", async () => {
    const layer = makeMockHttpClient(failingHandler("boom"))
    const program = Effect.flatMap(HttpClient, (http) =>
      makeDuckDuckGoHtmlProvider({ http }).search("test"),
    )
    const err = await run(Effect.flip(Effect.provide(program, layer)))
    expect(err._tag).toBe("SearchError")
  })

  it("maps non-2xx to typed SearchError", async () => {
    const layer = makeMockHttpClient(() => Effect.succeed({ status: 429, contentType: "text/html", body: "" }))
    const program = Effect.flatMap(HttpClient, (http) =>
      makeDuckDuckGoHtmlProvider({ http }).search("test"),
    )
    const err = await run(Effect.flip(Effect.provide(program, layer)))
    expect(err._tag).toBe("SearchError")
    if (err._tag === "SearchError") expect(err.reason).toContain("429")
  })
})
