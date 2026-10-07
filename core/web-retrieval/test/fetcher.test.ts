/**
 * fetcher.test.ts — extraction purity, egress fail-closed, typed fetch failures.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { checkFetchEgress, HttpClient, makeMockHttpClient } from "../src/http.js"
import { extractText, extractTitle, fetchSource } from "../src/fetcher.js"
import { makeFixtureHandler, ok, SOURCE_HTML_FIXTURE, SOURCE_TEXT_EXPECTED_FRAGMENTS } from "./fixtures.js"

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff as Effect.Effect<A, E>)
const RESULT_HOSTS = new Set(["example.com"])

describe("extractText", () => {
  it("strips scripts/styles, decodes entities, keeps visible text", () => {
    const text = extractText(SOURCE_HTML_FIXTURE)
    for (const frag of SOURCE_TEXT_EXPECTED_FRAGMENTS) {
      expect(text).toContain(frag)
    }
    expect(text).not.toContain("invisible")
    expect(text).not.toContain("color: red")
    expect(text).not.toContain("<p>")
  })

  it("is honest about boilerplate: nav/footer are included, documented limit", () => {
    const text = extractText(SOURCE_HTML_FIXTURE)
    expect(text).toContain("Home | About | Contact")
    expect(text).toContain("Copyright 2026")
  })
})

describe("extractTitle", () => {
  it("decodes the title tag", () => {
    expect(extractTitle(SOURCE_HTML_FIXTURE)).toBe("Example Article & Findings")
  })
  it("returns empty string when no title", () => {
    expect(extractTitle("<html><body>no title</body></html>")).toBe("")
  })
})

describe("checkFetchEgress (fail-closed)", () => {
  it("allows https URLs on search-result hosts", async () => {
    await run(checkFetchEgress("https://example.com/article", RESULT_HOSTS))
  })

  it("denies plain http even on a result host", async () => {
    const err = await run(Effect.flip(checkFetchEgress("http://example.com/article", RESULT_HOSTS)))
    expect(err._tag).toBe("EgressDenied")
    expect(err.reason).toContain("https-only")
  })

  it("denies hosts not returned by the search provider", async () => {
    const err = await run(Effect.flip(checkFetchEgress("https://evil.example/page", RESULT_HOSTS)))
    expect(err._tag).toBe("EgressDenied")
  })

  it("denies unparseable URLs", async () => {
    const err = await run(Effect.flip(checkFetchEgress("not a url", RESULT_HOSTS)))
    expect(err._tag).toBe("EgressDenied")
  })

  it("is case-insensitive on hostnames", async () => {
    await run(checkFetchEgress("https://EXAMPLE.com/article", RESULT_HOSTS))
  })
})

describe("fetchSource", () => {
  const routes = new Map([["https://example.com/article", ok(SOURCE_HTML_FIXTURE)]])

  it("fetches and extracts through the mock layer", async () => {
    const layer = makeMockHttpClient(makeFixtureHandler(routes))
    const program = Effect.flatMap(HttpClient, (http) =>
      fetchSource({ http }, "https://example.com/article", RESULT_HOSTS),
    )
    const source = await run(Effect.provide(program, layer))
    expect(source.url).toBe("https://example.com/article")
    expect(source.title).toBe("Example Article & Findings")
    expect(source.text).toContain("The quick brown fox")
  })

  it("checks egress BEFORE any request (denial opens no socket)", async () => {
    let requested = false
    const layer = makeMockHttpClient((req) => {
      requested = true
      return Effect.succeed(ok("x"))
    })
    const program = Effect.flatMap(HttpClient, (http) =>
      fetchSource({ http }, "https://not-a-result.example/page", RESULT_HOSTS),
    )
    const err = await run(Effect.flip(Effect.provide(program, layer)))
    expect(err._tag).toBe("EgressDenied")
    expect(requested).toBe(false)
  })

  it("maps 404 to typed FetchError", async () => {
    const layer = makeMockHttpClient(makeFixtureHandler(new Map()))
    const program = Effect.flatMap(HttpClient, (http) =>
      fetchSource({ http }, "https://example.com/missing", RESULT_HOSTS),
    )
    const err = await run(Effect.flip(Effect.provide(program, layer)))
    expect(err._tag).toBe("FetchError")
    if (err._tag === "FetchError") expect(err.reason).toContain("404")
  })

  it("rejects non-text content types", async () => {
    const layer = makeMockHttpClient(
      makeFixtureHandler(new Map([["https://example.com/file", ok("%PDF-1.4", "application/pdf")]])),
    )
    const program = Effect.flatMap(HttpClient, (http) =>
      fetchSource({ http }, "https://example.com/file", RESULT_HOSTS),
    )
    const err = await run(Effect.flip(Effect.provide(program, layer)))
    expect(err._tag).toBe("FetchError")
  })
})

describe("html-text scanner (CodeQL hardening, 2026-10-07)", () => {
  it("decodes each entity exactly once: &amp;lt; stays &lt; (no double-unescape)", () => {
    expect(extractText("<p>&amp;lt;script&amp;gt;</p>")).toBe("&lt;script&gt;")
  })

  it("still decodes single-level entities correctly", () => {
    expect(extractText("<p>&lt;div&gt; &amp; &quot;q&quot; &#65; &#x42;</p>")).toBe('<div> & "q" A B')
  })

  it("excludes script/style/noscript/template content", () => {
    const t = extractText("<script>evil()</script><style>.x{color:red}</style><noscript>ns</noscript><p>hi</p>")
    expect(t).toBe("hi")
    expect(t).not.toContain("evil()")
  })

  it("skips comments", () => {
    expect(extractText("<p>a</p><!-- secret --><p>b</p>")).toBe("a b")
  })

  it("handles malformed/nested tags without leaking markup", () => {
    const t = extractText("<scr<script>ipt>alert(1)</scr</script>ipt><p>ok</p>")
    expect(t).toContain("ok")
    expect(t).not.toContain("<script")
    expect(t).not.toContain("<scr")
  })

  it("handles > inside quoted attributes", () => {
    expect(extractText('<a title="a>b" href="x">link</a>')).toBe("link")
  })

  it("leaves unknown entities literal instead of destroying them", () => {
    expect(extractText("<p>&bogus; &;</p>")).toContain("&bogus;")
  })

  it("rejects out-of-range numeric entities without throwing", () => {
    expect(() => extractText("<p>&#x110000; &#xD800;</p>")).not.toThrow()
    expect(extractText("<p>&#x110000;</p>")).toContain("&#x110000;")
  })

  it("title uses RCDATA semantics: tags literal, entities decoded", () => {
    expect(extractTitle("<title>A &amp; <b>B</b></title>")).toBe("A & <b>B</b>")
    expect(extractTitle("<TITLE>Upper</TITLE>")).toBe("Upper")
  })
})
