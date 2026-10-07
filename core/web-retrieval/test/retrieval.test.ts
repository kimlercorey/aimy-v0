/**
 * retrieval.test.ts — the honesty pillar, end to end (mocked HTTP).
 *
 * Sourced claims must badge "verified"; unsourced claims (coverage,
 * synthesis) must badge "unverified" — asserted through HonestyService
 * itself (getBadge / evidenceFor), not through the module's word.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { HonestyService, HonestyServiceInMemory } from "../../honesty/src/service.js"
import { HttpClient, makeMockHttpClient } from "../src/http.js"
import { makeDuckDuckGoHtmlProvider } from "../src/provider.js"
import { makeRetrievalTool, retrievalHookImpls, RETRIEVAL_QUERY_TOOL, retrievalToolCall } from "../src/tools.js"
import { Allow } from "../../module-seam/src/kernel-seam.js"
import { DDG_HTML_FIXTURE, ok, SOURCE_HTML_FIXTURE } from "./fixtures.js"

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff as Effect.Effect<A, E>)

const SEARCH_URL = "https://html.duckduckgo.com/html/?q=test%20query"

const routes = new Map([
  [SEARCH_URL, ok(DDG_HTML_FIXTURE)],
  ["https://example.com/first", ok(SOURCE_HTML_FIXTURE)],
  [
    "https://example.org/second",
    ok(
      SOURCE_HTML_FIXTURE.replace("Example Article &amp; Findings", "Second Article").replace(
        "The quick brown fox jumps over the lazy dog.",
        "A completely different second source text.",
      ),
    ),
  ],
])

const TestLive = Layer.merge(
  HonestyServiceInMemory,
  makeMockHttpClient((req) => {
    const res = routes.get(req.url)
    return Effect.succeed(res ?? { status: 404, contentType: "text/html", body: "nf" })
  }),
)

const runRetrieval = (sessionId: string, turnId: string, maxSources = 3) =>
  Effect.gen(function* () {
    const honesty = yield* HonestyService
    const http = yield* HttpClient
    const tool = makeRetrievalTool({
      provider: makeDuckDuckGoHtmlProvider({ http }),
      http,
      honesty,
    })
    const report = yield* tool.invoke({ query: "test query", sessionId, turnId, maxSources })
    return { report, honesty }
  }).pipe(Effect.provide(TestLive))

describe("retrieval honesty flow", () => {
  it("badges sourced claims verified and unsourced claims unverified", async () => {
    const { report, honesty } = await run(runRetrieval("s1", "t1"))
    // 3 results; the http:// one is egress-denied; 2 fetched.
    expect(report.resultCount).toBe(3)
    expect(report.fetchedCount).toBe(2)
    expect(report.claims).toHaveLength(4)

    const statuses = report.claims.map((c) => c.badge.status)
    expect(statuses.filter((s) => s === "verified")).toHaveLength(2)
    expect(statuses.filter((s) => s === "unverified")).toHaveLength(2)

    // Assert through the service, not the report: getBadge per claim.
    for (const { claim, badge } of report.claims) {
      const fresh = await run(honesty.getBadge(claim.claimId))
      expect(fresh.status).toBe(badge.status)
    }

    // Sourced claims carry exactly one "source" evidence record pointing at the URL.
    const sourced = report.claims.filter((c) => c.badge.status === "verified")
    for (const { claim } of sourced) {
      const ev = await run(honesty.evidenceFor(claim.claimId))
      expect(ev).toHaveLength(1)
      expect(ev[0]?.kind).toBe("source")
      expect(claim.text).toContain(ev[0]?.ref ?? "∅")
    }

    // The synthesis claim is recorded with NO evidence — structurally unverified.
    const synthesis = report.claims.find((c) => c.claim.text.startsWith("Synthesis across"))
    expect(synthesis?.badge.status).toBe("unverified")
    const synEv = await run(honesty.evidenceFor(synthesis!.claim.claimId))
    expect(synEv).toHaveLength(0)

    // The rendered answer labels every claim with its badge.
    expect(report.answer).toContain("[verified]")
    expect(report.answer).toContain("[unverified]")
  })

  it("tolerates fetch failures: failed sources contribute no claims", async () => {
    // maxSources=1 fetches only example.com/first -> 1 sourced claim + 2 unsourced.
    const { report } = await run(runRetrieval("s2", "t2", 1))
    expect(report.fetchedCount).toBe(1)
    expect(report.claims).toHaveLength(3)
    expect(report.claims.filter((c) => c.badge.status === "verified")).toHaveLength(1)
  })

  it("fails the whole pass with a typed error when search fails", async () => {
    const badLive = Layer.merge(
      HonestyServiceInMemory,
      makeMockHttpClient(() => Effect.succeed({ status: 503, contentType: "text/html", body: "" })),
    )
    const program = Effect.gen(function* () {
      const honesty = yield* HonestyService
      const http = yield* HttpClient
      const tool = makeRetrievalTool({ provider: makeDuckDuckGoHtmlProvider({ http }), http, honesty })
      return yield* tool.invoke({ query: "test query", sessionId: "s3", turnId: "t3" })
    }).pipe(Effect.provide(badLive))
    const err = await run(Effect.flip(program))
    expect(err._tag).toBe("SearchError")
  })
})

describe("retrieval.query tool + hook participation", () => {
  it("retrievalToolCall builds a dispatchable ToolCall", () => {
    const call = retrievalToolCall("call-1", { query: "q", sessionId: "s", turnId: "t" })
    expect(call.tool).toBe(RETRIEVAL_QUERY_TOOL)
    expect(call.tier).toBe("T1")
    expect(call.truncated).toBe(false)
  })

  it("beforeToolCall allows well-formed retrieval.query calls", async () => {
    const hooks = retrievalHookImpls()
    const verdict = await run(
      hooks.beforeToolCall!(retrievalToolCall("c1", { query: "q", sessionId: "s", turnId: "t" })),
    )
    expect(verdict).toEqual(Allow)
  })

  it("beforeToolCall denies empty queries (block, not terminate)", async () => {
    const hooks = retrievalHookImpls()
    const verdict = await run(
      hooks.beforeToolCall!(retrievalToolCall("c2", { query: "  ", sessionId: "s", turnId: "t" })),
    )
    expect(verdict._tag).toBe("Deny")
    if (verdict._tag === "Deny") {
      expect(verdict.terminate).toBe(false)
      expect(verdict.reason).toContain("non-empty")
    }
  })

  it("beforeToolCall ignores other tools", async () => {
    const hooks = retrievalHookImpls()
    const verdict = await run(
      hooks.beforeToolCall!({ id: "x", tool: "other.tool", args: {}, tier: "T0", truncated: false }),
    )
    expect(verdict).toEqual(Allow)
  })

  it("afterToolCall passes outcomes through unchanged", async () => {
    const hooks = retrievalHookImpls()
    const outcome = { _tag: "Ok", value: 42 } as const
    const out = await run(hooks.afterToolCall!(retrievalToolCall("c3", { query: "q", sessionId: "s", turnId: "t" }), outcome))
    expect(out).toEqual(outcome)
  })
})
