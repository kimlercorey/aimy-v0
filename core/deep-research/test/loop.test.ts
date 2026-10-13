/**
 * loop.test.ts — the §7 golden test for the full research loop
 * (charter E12 criteria 2, 3, 5, 8): a fixed fixture corpus where two
 * hosts agree, one claim stands alone, and two claims contradict.
 * Asserts clusters, corroboration states, dispute rendering, honesty
 * invariants (evidence attachments), degradation behavior, the full
 * query list in deliverables (E10), and honest emptiness.
 *
 * No sockets: stubbed provider, mocked HTTP, in-memory honesty.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { research } from "../src/research.js"
import { PlanError } from "../src/errors.js"
import type { PlanModel } from "../src/planner.js"
import type { SearchProvider, SearchResult } from "../../web-retrieval/src/provider.js"
import { HonestyService, HonestyServiceInMemory } from "../../honesty/src/service.js"
import { HttpClient, makeMockHttpClient } from "../../web-retrieval/src/http.js"

const articleHtml = (title: string, body: string): string =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body>` +
  `<nav>menu home about contact</nav>` +
  `<article><h1>${title}</h1><p>${body.repeat(8)}</p></article>` +
  `<footer>copyright links privacy</footer></body></html>`

const A = "https://example.com/ssb"
const B = "https://example.org/ssb-news"
const C = "https://example.net/critics"
const D = "https://example.edu/toyota"

const pages = new Map<string, string>([
  [A, articleHtml("SSB Guide", "Solid-state batteries use a ceramic electrolyte. Toyota targets 2027 for production. ")],
  [B, articleHtml("SSB News", "Solid-state batteries use a ceramic electrolyte. Independent analysts say solid-state batteries will not ship before 2030. ")],
  [C, articleHtml("Critics", "Critics argue solid-state batteries are overhyped and years from viability. ")],
  [D, articleHtml("Toyota Confirmed", "Toyota targets 2027 for production of solid-state batteries, the company confirmed. ")]
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

const r = (url: string, title: string): SearchResult => ({ title, url, snippet: "s" })

const provider: SearchProvider = {
  name: "stub",
  searchHost: "stub.example",
  search: (q) =>
    Effect.succeed(
      q.includes("manufacturing")
        ? [r(D, "Toyota Confirmed")]
        : q.includes("criticism")
          ? [r(C, "Critics")]
          : q.includes("timeline")
            ? [r(A, "SSB Guide"), r(B, "SSB News")]
            : [r(A, "SSB Guide")]
    )
}

const JUDGE_CLAIMS: Record<string, Array<{ text: string; excerpt: string }>> = {
  [A]: [
    { text: "Solid-state batteries use a ceramic electrolyte.", excerpt: "Solid-state batteries use a ceramic electrolyte." },
    { text: "Toyota targets 2027 for solid-state production.", excerpt: "Toyota targets 2027 for production." }
  ],
  [B]: [
    { text: "Solid-state batteries use a ceramic electrolyte.", excerpt: "Solid-state batteries use a ceramic electrolyte." },
    { text: "Solid-state batteries will not ship before 2030.", excerpt: "solid-state batteries will not ship before 2030." }
  ],
  [C]: [{ text: "Critics argue solid-state batteries are overhyped.", excerpt: "Critics argue solid-state batteries are overhyped" }],
  [D]: [{ text: "Toyota targets 2027 for solid-state production.", excerpt: "Toyota targets 2027 for production" }]
}

const scriptedModel: PlanModel = {
  generateText: (system, user) => {
    if (system.includes("research planner")) {
      return Effect.succeed(
        JSON.stringify({
          subQuestions: [
            { question: "solid-state batteries explained", intent: "background" },
            { question: "Toyota solid-state timeline evidence", intent: "evidence" },
            { question: "solid-state batteries criticism", intent: "counterpoint" }
          ]
        })
      )
    }
    if (system.includes("research judge")) {
      const url = user.match(/\((https?:[^)]+)\)/)?.[1] ?? ""
      return Effect.succeed(JSON.stringify({ relevance: 2, claims: JUDGE_CLAIMS[url] ?? [] }))
    }
    if (system.includes("compare pairs")) {
      const pairs: Array<{ a: number; b: number; relation: string }> = []
      const re = /Pair a=(\d+) b=(\d+):\n\s+A: (.*)\n\s+B: (.*)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(user)) !== null) {
        const [, a, b, ta, tb] = m as unknown as [string, string, string, string, string]
        let relation = "different"
        if (ta!.includes("ceramic electrolyte") && tb!.includes("ceramic electrolyte")) relation = "same"
        else if (ta!.includes("2027") && tb!.includes("2027")) relation = "same"
        else if ((ta!.includes("2027") && tb!.includes("2030")) || (ta!.includes("2030") && tb!.includes("2027"))) relation = "contradicts"
        pairs.push({ a: Number(a), b: Number(b), relation })
      }
      return Effect.succeed(JSON.stringify({ pairs }))
    }
    if (system.includes("gap analyst")) {
      return Effect.succeed(
        JSON.stringify({ subQuestions: [{ question: "solid-state manufacturing challenges", intent: "evidence" }] })
      )
    }
    if (system.includes("writing the answer")) {
      return Effect.succeed("Ceramic electrolytes are established [1]. The 2027 timeline is disputed.")
    }
    return Effect.succeed("{}")
  }
}

const runResearch = (model: PlanModel, prov: SearchProvider, input: { query: string; depth?: "quick" | "standard" | "deep"; output?: "answer" | "paper" }) =>
  Effect.gen(function* () {
    const honesty = yield* HonestyService
    const http = yield* HttpClient
    const report = yield* research({ provider: prov, http, honesty, model })({
      query: input.query,
      sessionId: "s1",
      turnId: "t1",
      depth: input.depth,
      output: input.output
    })
    const evidenceCounts = yield* Effect.forEach(report.claims, (c) =>
      Effect.map(honesty.evidenceFor(c.claim.claimId), (e) => e.length)
    )
    return { report, evidenceCounts }
  }).pipe(Effect.provide(TestLive))

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

describe("research full loop (golden)", () => {
  it("corroborates, contests, chases gaps, and reports honestly", async () => {
    const { report, evidenceCounts } = await run(
      runResearch(scriptedModel, provider, { query: "solid-state batteries", depth: "standard" })
    )
    expect(report.roundsUsed).toBe(2)
    expect(report.sourcesRead).toBe(4)
    const ceramic = report.clusters.find((c) => c.text.includes("ceramic"))
    expect(ceramic?.corroborated).toBe(true)
    expect(ceramic?.hosts).toHaveLength(2)
    const toyota = report.clusters.find((c) => c.text.includes("2027"))
    expect(toyota?.corroborated).toBe(true) // second host arrives in round 2
    expect(toyota?.contested).toBe(true) // the 2030 claim contradicts it
    expect(toyota?.contradictedBy.length).toBe(1)
    const critics = report.clusters.find((c) => c.text.includes("overhyped"))
    expect(critics?.corroborated).toBe(false) // single-source stays single-source
    expect(report.termination).toBe("budget-exhausted")
    expect(report.gaps.length).toBeGreaterThan(0)
    // E10: the full query set, follow-ups included, is in the report.
    expect(report.queries).toContain("solid-state manufacturing challenges")
    expect(report.answer).toContain("Queries searched:")
    // Honesty invariant (E12.3): every non-coverage claim has evidence.
    report.claims.forEach((c, i) => {
      if (c.claim.text.startsWith("Coverage:")) {
        expect(evidenceCounts[i]).toBe(0)
        expect(c.badge.status).toBe("unverified")
      } else {
        expect(evidenceCounts[i]).toBeGreaterThanOrEqual(1)
      }
    })
  }, 30_000)

  it("degrades corroboration conservatively when adjudication fails", async () => {
    const noAdjudication: PlanModel = {
      generateText: (system, user) =>
        system.includes("compare pairs")
          ? Effect.fail(new PlanError({ reason: "adjudicator down" }))
          : scriptedModel.generateText(system, user)
    }
    const { report } = await run(runResearch(noAdjudication, provider, { query: "solid-state batteries", depth: "quick" }))
    // No merges on a guess: distinct claims stay in distinct clusters.
    // The one exception is deterministic, not a guess — identical claim
    // texts are the same ledger claim (same claimId), so they merge and
    // their hosts combine even with the adjudicator down.
    expect(report.clusters.length).toBe(report.claims.length - 1) // unique claims; minus coverage
    const ceramic = report.clusters.find((c) => c.text.includes("ceramic"))
    expect(ceramic?.corroborated).toBe(true)
    expect(report.clusters.filter((c) => c.id !== ceramic?.id).every((c) => !c.corroborated)).toBe(true)
  }, 30_000)

  it("paper mode assembles the E8 document with a disputes section and the query list", async () => {
    const { report } = await run(
      runResearch(scriptedModel, provider, { query: "solid-state batteries", output: "paper" })
    )
    expect(report.paper).toBeDefined()
    expect(report.paper).toContain("## Visual summary")
    expect(report.paper).toContain("## Disputes & uncertainty")
    expect(report.paper).toContain("example.org") // the contradicting source is rendered
    expect(report.paper).toContain("## Queries searched")
    expect(report.paper).toContain("## Sources")
  }, 30_000)

  it("honest emptiness: no results, no claims, both modes", async () => {
    const empty: SearchProvider = { name: "stub", searchHost: "stub.example", search: () => Effect.succeed([]) }
    const { report } = await run(runResearch(scriptedModel, empty, { query: "unfindable", depth: "quick" }))
    expect(report.termination).toBe("no-sources")
    expect(report.claims.filter((c) => !c.claim.text.startsWith("Coverage:"))).toHaveLength(0)
    const paperRun = await run(runResearch(scriptedModel, empty, { query: "unfindable", output: "paper" }))
    expect(paperRun.report.paper).toContain("No sources could be read.")
  }, 30_000)
})
