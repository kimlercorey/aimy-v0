/**
 * deep-research/test/research.test.ts — Phase 1 golden test: the whole loop
 * with a stubbed planner model, stubbed search provider, and mocked HTTP.
 *
 * No test here opens a socket. Asserts: the model plan runs (fromModel),
 * sub-questions fan out, fetches become per-source verified claims, the
 * coverage claim badges unverified, and failures degrade honestly.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { research } from "../src/research.js"
import type { PlanModel } from "../src/planner.js"
import { PlanError } from "../src/errors.js"
import type { SearchProvider, SearchResult } from "../../web-retrieval/src/provider.js"
import { HonestyService, HonestyServiceInMemory } from "../../honesty/src/service.js"
import { HttpClient, makeMockHttpClient } from "../../web-retrieval/src/http.js"

const articleHtml = (title: string, body: string): string =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body>` +
  `<nav>menu home about contact</nav>` +
  `<article><h1>${title}</h1><p>${body.repeat(8)}</p></article>` +
  `<footer>copyright links privacy</footer></body></html>`

const PLAN_JSON = JSON.stringify({
  subQuestions: [
    { question: "solid-state batteries explained", intent: "background" },
    { question: "Toyota solid-state battery timeline", intent: "evidence" },
  ],
})

const stubModel: PlanModel = {
  generateText: () => Effect.succeed(PLAN_JSON),
}

const failingModel: PlanModel = {
  generateText: () => Effect.fail(new PlanError({ reason: "model down" })),
}

const stubProvider = (results: ReadonlyArray<SearchResult>): SearchProvider => ({
  name: "stub",
  searchHost: "stub.example",
  search: () => Effect.succeed(results),
})

const r = (url: string, title: string): SearchResult => ({ title, url, snippet: "s" })

const pages = new Map<string, string>([
  [
    "https://example.com/ssb",
    articleHtml("SSB Guide", "Solid-state batteries replace liquid electrolyte with ceramic. "),
  ],
  [
    "https://example.org/toyota",
    articleHtml("Toyota Timeline", "Toyota targets 2027 for solid-state production. "),
  ],
])

const TestLive = Layer.merge(
  HonestyServiceInMemory,
  makeMockHttpClient((req) => {
    const body = pages.get(req.url)
    return Effect.succeed(
      body === undefined
        ? { status: 404, contentType: "text/html", body: "nf" }
        : { status: 200, contentType: "text/html", body }
    )
  })
)

const runResearch = (
  model: PlanModel,
  results: ReadonlyArray<SearchResult>,
  input: { query: string; depth?: "quick" | "standard" | "deep"; maxSources?: number }
) =>
  Effect.gen(function* () {
    const honesty = yield* HonestyService
    const http = yield* HttpClient
    const report = yield* research({ provider: stubProvider(results), http, honesty, model })({
      query: input.query,
      sessionId: "s1",
      turnId: "t1",
      depth: input.depth,
      maxSources: input.maxSources,
    })
    // Evidence check inside the same layer: the store is shared here.
    const evidenceCounts = yield* Effect.forEach(report.claims, (c) =>
      Effect.map(honesty.evidenceFor(c.claim.claimId), (e) => e.length)
    )
    return { report, evidenceCounts }
  }).pipe(Effect.provide(TestLive))

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

describe("research Phase 1 flow", () => {
  const results = [r("https://example.com/ssb", "SSB Guide"), r("https://example.org/toyota", "Toyota Timeline")]

  it("runs the model plan and records per-source verified claims", async () => {
    const { report, evidenceCounts } = await run(runResearch(stubModel, results, { query: "solid-state batteries" }))
    expect(report.plan.fromModel).toBe(true)
    expect(report.plan.subQuestions).toHaveLength(2)
    expect(report.sourcesSearched).toBe(2)
    expect(report.sourcesRead).toBe(2)
    expect(report.termination).toBe("answered")

    const sourceClaims = report.claims.filter((c) => c.claim.text.startsWith("According to"))
    expect(sourceClaims).toHaveLength(2)
    for (const c of sourceClaims) {
      expect(c.badge.status).toBe("verified")
    }
    // Every source claim has ≥1 evidence attachment; the coverage claim has 0.
    const withEvidence = report.claims.map((c, i) => ({ text: c.claim.text, n: evidenceCounts[i] ?? -1 }))
    for (const e of withEvidence.filter((x) => x.text.startsWith("According to"))) {
      expect(e.n).toBeGreaterThanOrEqual(1)
    }
    const coverageRow = withEvidence.find((x) => x.text.startsWith("Coverage:"))
    expect(coverageRow?.n).toBe(0)
    // Coverage claim: recorded with NO evidence → unverified, labeled.
    const coverage = report.claims.find((c) => c.claim.text.startsWith("Coverage:"))
    expect(coverage).toBeDefined()
    expect(coverage?.badge.status).toBe("unverified")
  })

  it("falls back honestly when the planner model fails", async () => {
    const { report } = await run(runResearch(failingModel, results, { query: "q" }))
    expect(report.plan.fromModel).toBe(false)
    expect(report.plan.subQuestions).toHaveLength(1)
    expect(report.answer).toContain("fallback single-query")
  })

  it("reports honestly when every fetch fails", async () => {
    const { report } = await run(
      runResearch(stubModel, [r("https://example.com/missing", "Missing")], { query: "q" })
    )
    expect(report.sourcesRead).toBe(0)
    expect(report.claims.filter((c) => c.claim.text.startsWith("According to"))).toHaveLength(0)
    const coverage = report.claims.find((c) => c.claim.text.startsWith("Coverage:"))
    expect(coverage?.claim.text).toContain("0 of 1")
    expect(coverage?.claim.text).toContain("fetch(es) failed")
  })

  it("truncates to budget and says so", async () => {
    const many = Array.from({ length: 10 }, (_, i) => r(`https://example.com/p${i}`, `P${i}`))
    const { report } = await run(runResearch(stubModel, many, { query: "q", depth: "quick" }))
    // quick budget: 4 fetches; only 2 pages exist in the mock, rest 404.
    expect(report.sourcesRead).toBeLessThanOrEqual(4)
    expect(report.termination).toBe("budget-exhausted")
    const coverage = report.claims.find((c) => c.claim.text.startsWith("Coverage:"))
    expect(coverage?.claim.text).toContain("Budgets truncated")
  })

  it("rejects empty queries fail-fast", async () => {
    const e = await run(Effect.flip(runResearch(stubModel, results, { query: "   " })))
    expect(e._tag).toBe("InvalidResearchArgs")
  })

  it("paper output forces deep depth", async () => {
    const report = await run(
      Effect.gen(function* () {
        const honesty = yield* HonestyService
        const http = yield* HttpClient
        return yield* research({ provider: stubProvider(results), http, honesty, model: stubModel })({
          query: "q",
          sessionId: "s1",
          turnId: "t1",
          output: "paper",
        })
      }).pipe(Effect.provide(TestLive))
    )
    expect(report.output).toBe("paper")
    expect(report.depth).toBe("deep")
  })
})
