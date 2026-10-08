/**
 * deep-research/research.ts — Phase 1: the single-round research flow.
 *
 * `research(query)`:
 *   1. validate args (fail-fast on empty query / bad depth),
 *   2. plan via the model (or the honest single-query fallback),
 *   3. fan out: one polite search per sub-question (budget-capped),
 *   4. read: fetch deduped results (budget-capped; failures recorded, not hidden),
 *   5. report: one "according to <source>" claim per fetched source, each with
 *      evidence attached (→ verified); one coverage claim with NO evidence
 *      (→ unverified, labeled).
 *
 * Phase 1 deliberately reuses web-retrieval's claim model — judge,
 * corroboration, gap loop, and synthesis arrive in Phases 2–4. What Phase 1
 * proves: the planning prompt works, the polite fan-out works, and a planned
 * multi-query run degrades honestly at every stage.
 */
import { Effect } from "effect"
import type { HonestyServiceShape } from "../../honesty/src/service.js"
import type { HonestyError } from "../../honesty/src/errors.js"
import type { NewClaim } from "../../honesty/src/types.js"
import type { HttpClientShape } from "../../web-retrieval/src/http.js"
import { fetchSource } from "../../web-retrieval/src/fetcher.js"
import type { SearchProvider } from "../../web-retrieval/src/provider.js"
import type { FetchedSource, SearchResult } from "../../web-retrieval/src/types.js"
import type { RetrievalError } from "../../web-retrieval/src/errors.js"
import { InvalidResearchArgs, type DeepResearchError } from "./errors.js"
import {
  DEPTH_BUDGETS,
  type DeepResearchReport,
  type ResearchDepth,
  type ResearchOutput,
} from "./types.js"
import { planWithFallback, type PlanModel } from "./planner.js"
import { dedupeResults, fanOut, type FanOutEntry } from "./fanout.js"

export interface ResearchDeps {
  readonly provider: SearchProvider
  readonly http: HttpClientShape
  readonly honesty: HonestyServiceShape
  readonly model: PlanModel
}

export interface ResearchInput {
  readonly query: string
  readonly sessionId: string
  readonly turnId: string
  readonly depth?: ResearchDepth | undefined
  readonly output?: ResearchOutput | undefined
  readonly maxSources?: number | undefined
}

const EXCERPT_CHARS = 400

const excerptOf = (source: FetchedSource): string => {
  const t = source.text.replace(/\s+/g, " ").trim()
  return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS)}…` : t
}

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

const reasonOf = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === "object" && e !== null && "reason" in e) return String((e as { reason: unknown }).reason)
  return String(e)
}

const validateArgs = (
  input: ResearchInput
): Effect.Effect<{ depth: ResearchDepth; output: ResearchOutput }, InvalidResearchArgs> => {
  if (input.query.trim() === "") {
    return Effect.fail(new InvalidResearchArgs({ reason: "research.query: query must not be empty" }))
  }
  const output: ResearchOutput = input.output ?? "answer"
  if (output !== "answer" && output !== "paper") {
    return Effect.fail(new InvalidResearchArgs({ reason: `research.query: unknown output "${input.output}"` }))
  }
  // Paper mode always runs deep (spec §1); explicit depth still wins for "answer".
  const depth: ResearchDepth = output === "paper" ? "deep" : (input.depth ?? "standard")
  if (depth !== "quick" && depth !== "standard" && depth !== "deep") {
    return Effect.fail(new InvalidResearchArgs({ reason: `research.query: unknown depth "${input.depth}"` }))
  }
  return Effect.succeed({ depth, output })
}

const recordClaim = (
  honesty: HonestyServiceShape,
  sessionId: string,
  turnId: string,
  text: string,
  sources: ReadonlyArray<{ url: string; excerpt: string }>
): Effect.Effect<void, HonestyError> =>
  Effect.gen(function* () {
    const newClaim: NewClaim = { sessionId, turnId, text, kind: "factual" }
    const record = yield* honesty.recordClaim(newClaim)
    for (const s of sources) {
      yield* honesty.attachEvidence(record.claimId, { kind: "source", ref: s.url, summary: s.excerpt })
    }
  })

const renderAnswer = (
  query: string,
  fromModel: boolean,
  subCount: number,
  claims: ReadonlyArray<{ text: string; status: string }>
): string => {
  const planLine = fromModel
    ? `Plan: model-decomposed into ${subCount} sub-questions.`
    : `Plan: fallback single-query (planner unavailable — see coverage claim).`
  return [`Research: "${query}"`, planLine, "", ...claims.map((c) => `[${c.status}] ${c.text}`)].join("\n")
}

/**
 * Run one planned research round. Search failures drop sub-questions (recorded
 * in coverage); fetch failures drop sources (recorded in coverage). Neither
 * fails the run — an empty result set is an honest "no sources found" report.
 */
export const research = (
  deps: ResearchDeps
): ((
  input: ResearchInput
) => Effect.Effect<DeepResearchReport, DeepResearchError | RetrievalError | HonestyError>) =>
  Effect.fn("deep-research/research")(function* (input: ResearchInput) {
    const { depth, output } = yield* validateArgs(input)
    const budget = DEPTH_BUDGETS[depth]

    // Stage 1: plan (model or honest fallback — never fails).
    const plan = yield* planWithFallback(deps.model, input.query.trim())
    const subQuestions = plan.subQuestions.slice(0, budget.queries)
    const truncatedQueries = plan.subQuestions.length > budget.queries

    // Stage 2: polite fan-out.
    const entries: ReadonlyArray<FanOutEntry> = yield* fanOut(deps.provider, subQuestions)
    const failedSearches = entries.filter((e) => e.error !== undefined)
    const deduped: ReadonlyArray<SearchResult> = dedupeResults(entries)

    // Stage 3: read (budget-capped; egress policy = result hosts only).
    const fetchCap = Math.min(budget.fetches, input.maxSources ?? budget.fetches)
    const toFetch = deduped.slice(0, Math.max(0, fetchCap))
    const truncatedFetches = deduped.length > toFetch.length
    const resultHosts = new Set<string>()
    for (const r of toFetch) {
      const h = hostOf(r.url)
      if (h !== undefined) resultHosts.add(h)
    }
    const fetchFailures: Array<{ url: string; reason: string }> = []
    const fetchedSources: Array<FetchedSource> = []
    for (const r of toFetch) {
      const outcome = yield* fetchSource({ http: deps.http }, r.url, resultHosts).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((e) => Effect.succeed({ ok: false as const, reason: reasonOf(e) }))
      )
      if (outcome.ok) {
        const source = outcome.value
        const title = source.title === "" ? source.url : source.title
        const excerpt = excerptOf(source)
        yield* recordClaim(deps.honesty, input.sessionId, input.turnId,
          `According to "${title}" (${source.url}): ${excerpt}`,
          [{ url: source.url, excerpt }])
        fetchedSources.push(source)
      } else {
        fetchFailures.push({ url: r.url, reason: outcome.reason })
      }
    }

    const coverageText =
      `Coverage: ${fetchedSources.length} of ${deduped.length} unique results fetched ` +
      `across ${subQuestions.length} sub-question(s) for "${input.query.trim()}".` +
      (failedSearches.length > 0
        ? ` ${failedSearches.length} search(es) failed: ${failedSearches.map((e) => e.error?.reason ?? "unknown").join("; ")}.`
        : "") +
      (fetchFailures.length > 0
        ? ` ${fetchFailures.length} fetch(es) failed: ${fetchFailures.map((f) => `${f.url} (${f.reason})`).join("; ")}.`
        : "") +
      (!plan.fromModel ? " Planner unavailable; ran fallback single-query plan." : "") +
      (truncatedQueries || truncatedFetches ? " Budgets truncated this run." : "")
    yield* recordClaim(deps.honesty, input.sessionId, input.turnId, coverageText, [])

    // Read back every claim with its derived badge — the ledger is the source of truth.
    const claims = yield* deps.honesty.claimsForTurn(input.sessionId, input.turnId)
    const answer = renderAnswer(
      input.query.trim(),
      plan.fromModel,
      subQuestions.length,
      claims.map((c) => ({ text: c.claim.text, status: c.badge.status }))
    )

    return {
      query: input.query.trim(),
      depth,
      output,
      plan,
      answer,
      claims,
      sourcesSearched: deduped.length,
      sourcesRead: fetchedSources.length,
      termination: truncatedQueries || truncatedFetches ? "budget-exhausted" : "answered",
    } satisfies DeepResearchReport
  })
