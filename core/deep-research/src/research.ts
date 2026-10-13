/**
 * deep-research/research.ts — the full research loop (charter §3;
 * Extensions v0.2 E5 / v0.3 E14/E15).
 *
 * Stages per run: Plan → [ Fan-out → Read → Judge ] per round →
 * Corroborate → Gap analysis → (follow-up rounds while budget lasts) →
 * Synthesis. State that matters lives in structured values passed stage
 * to stage — never a growing prompt: the judge sees one source chunk at
 * a time, corroboration sees claim pairs, synthesis sees cluster
 * summaries. The corpus is never in anyone's context (E14).
 *
 * Honesty rules inherited from Phase 1 and kept: search failures drop
 * sub-questions (recorded), fetch failures drop sources (recorded),
 * judge degradation falls back to the mechanical per-source claim
 * (recorded), the coverage claim carries no evidence (unverified by
 * construction), and an empty result is an honest "no-sources" report —
 * never a fabricated answer.
 *
 * Termination: "no-sources" (nothing could be read), "budget-exhausted"
 * (gaps remained when the budget ran out), "no-gaps" (gap analysis
 * confirmed coverage), "answered" (rounds completed; retained for
 * single-round completions where gap analysis is not the gate), and
 * "timeout" (the run's time cap hit mid-loop — a partial report that
 * names the stage it stopped in). Model calls are capped at 90 s each;
 * a timed-out call degrades its stage, never hangs the run.
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
import { InvalidResearchArgs, PlanError, type DeepResearchError } from "./errors.js"
import {
  DEPTH_BUDGETS,
  type ClaimCluster,
  type DeepResearchReport,
  type GapNote,
  type JudgedClaim,
  type ResearchDepth,
  type ResearchOutput,
  type ResearchTermination,
  type SubQuestion
} from "./types.js"
import { PLANNER_PROMPT_VERSION, planWithFallback, type PlanModel } from "./planner.js"
import { dedupeResults, fanOut, normalizeUrl, type FanOutEntry } from "./fanout.js"
import { JUDGE_PROMPT_VERSION, judgeSource } from "./judge.js"
import { CORROBORATE_PROMPT_VERSION, adjudicatePairs, buildClusters, candidatePairs } from "./corroborate.js"
import { GAP_PROMPT_VERSION, analyzeGaps, coverageFor, proposeFollowUps } from "./gaps.js"
import { SYNTHESIS_PROMPT_VERSION, buildPaper, comparisonTable, synthesizeAnswer } from "./synthesis.js"

export interface ResearchStageEvent {
  readonly stage: "plan" | "read" | "judge" | "corroborate" | "gap" | "synthesis"
  readonly searches: number
  readonly fetches: number
  readonly claims: number
  readonly clusters: number
  readonly rounds: number
}

export interface ResearchDeps {
  readonly provider: SearchProvider
  readonly http: HttpClientShape
  readonly honesty: HonestyServiceShape
  readonly model: PlanModel
  /** Host-side progress sink (E16 run records). Optional; the module runs identically without it. */
  readonly onStage?: ((event: ResearchStageEvent) => void) | undefined
}

export interface ResearchInput {
  readonly query: string
  readonly sessionId: string
  readonly turnId: string
  readonly depth?: ResearchDepth | undefined
  readonly output?: ResearchOutput | undefined
  readonly maxSources?: number | undefined
}

/** Per-model-call cap (charter C6): a hung call degrades its stage. */
export const MODEL_CALL_TIMEOUT_MS = 90_000

/** Whole-run time caps per depth (deep = the spec's 6-minute ceiling). */
export const RUN_TIME_BUDGET_MS: Record<ResearchDepth, number> = {
  quick: 90_000,
  standard: 240_000,
  deep: 360_000
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

export const research = (
  deps: ResearchDeps
): ((
  input: ResearchInput
) => Effect.Effect<DeepResearchReport, DeepResearchError | RetrievalError | HonestyError>) =>
  Effect.fn("deep-research/research")(function* (input: ResearchInput) {
    const { depth, output } = yield* validateArgs(input)
    const budget = DEPTH_BUDGETS[depth]
    const query = input.query.trim()
    // Timeouts (charter C6/E5): every model call is capped at 90 s — a
    // hung call degrades its stage (the stages already fail-soft on
    // model errors) instead of hanging the run. The whole run is capped
    // per depth (deep: 6 min); passing the cap stops the loop and the
    // run reports partial results, naming the stage it timed out in.
    const model: PlanModel = {
      generateText: (system, user) =>
        deps.model.generateText(system, user).pipe(
          Effect.timeoutOrElse({
            duration: MODEL_CALL_TIMEOUT_MS,
            orElse: () => Effect.fail(new PlanError({ reason: "model call timed out (90s stage cap)" }))
          })
        )
    }
    const totalBudgetMs = RUN_TIME_BUDGET_MS[depth]
    const startMs = Date.now()
    const totalFetchCap = Math.min(budget.fetches, input.maxSources ?? budget.fetches)

    // Stage 1: plan (model or honest fallback — never fails).
    const plan = yield* planWithFallback(model, query)
    const planNote = plan.fromModel
      ? `Plan: model-decomposed into ${plan.subQuestions.length} sub-questions.`
      : `Plan: fallback single-query (planner unavailable — see coverage claim).`

    // Run state (structured values, not prompts — E14).
    const asked: SubQuestion[] = []
    const seenResults = new Set<string>()
    const readUrls = new Set<string>()
    const fetchedSources: Array<FetchedSource & { host: string }> = []
    const readPerSubQuestion: number[] = []
    const allJudged: JudgedClaim[] = []
    const failedSearches: string[] = []
    const fetchFailures: Array<{ url: string; reason: string }> = []
    let clusters: ClaimCluster[] = []
    let gaps: GapNote[] = []
    let queriesUsed = 0
    let judgeDegraded = 0
    let droppedNonVerbatim = 0
    let truncated = plan.subQuestions.length > budget.queries
    let roundsUsed = 0
    let gapConfirmedClean = false
    // Starvation (2026-10-12): a round that leaves the run with ZERO
    // fetched sources means the web yielded nothing readable — more
    // rounds can only re-run the same empty searches while burning
    // budget. The run stops and reports "no-sources" honestly.
    let starvedNoEvidence = false
    let stageNow: ResearchStageEvent["stage"] = "plan"
    let timedOutStage: string | undefined
    const emit = (stage: ResearchStageEvent["stage"], rounds: number): void => {
      stageNow = stage
      deps.onStage?.({
        stage,
        searches: seenResults.size,
        fetches: fetchedSources.length,
        claims: allJudged.length,
        clusters: clusters.length,
        rounds
      })
    }
    emit("plan", 0)

    let roundQuestions: SubQuestion[] = plan.subQuestions.slice(0, budget.queries)
    for (let round = 1; round <= budget.rounds; round++) {
      if (Date.now() - startMs > totalBudgetMs) {
        timedOutStage = stageNow
        break
      }
      if (roundQuestions.length === 0) break
      const remainingQueries = budget.queries - queriesUsed
      if (remainingQueries <= 0) break
      roundQuestions = roundQuestions.slice(0, remainingQueries)
      queriesUsed += roundQuestions.length
      roundsUsed = round
      const startIdx = asked.length
      asked.push(...roundQuestions)

      // Stage 2: polite fan-out for this round's questions.
      const entries: ReadonlyArray<FanOutEntry> = yield* fanOut(deps.provider, roundQuestions)
      for (const e of entries) {
        if (e.error !== undefined) failedSearches.push(e.error.reason)
      }
      // Map each unique result to the sub-question that surfaced it (first wins).
      const subIndexByUrl = new Map<string, number>()
      entries.forEach((entry, k) => {
        for (const r of entry.results) {
          const key = normalizeUrl(r.url)
          if (!subIndexByUrl.has(key)) subIndexByUrl.set(key, startIdx + k)
          seenResults.add(key)
        }
      })
      const deduped: ReadonlyArray<SearchResult> = dedupeResults(entries).filter(
        (r) => !readUrls.has(normalizeUrl(r.url))
      )

      // Stage 3: read (budget-capped across the whole run).
      const remainingFetches = totalFetchCap - fetchedSources.length
      const toFetch = deduped.slice(0, Math.max(0, remainingFetches))
      if (deduped.length > toFetch.length) truncated = true
      const resultHosts = new Set<string>()
      for (const r of toFetch) {
        const h = hostOf(r.url)
        if (h !== undefined) resultHosts.add(h)
      }
      const roundFetched: Array<{ source: FetchedSource & { host: string }; subIndex: number }> = []
      for (const r of toFetch) {
        const outcome = yield* fetchSource({ http: deps.http }, r.url, resultHosts).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((e) => Effect.succeed({ ok: false as const, reason: reasonOf(e) }))
        )
        if (outcome.ok) {
          readUrls.add(normalizeUrl(r.url))
          const host = hostOf(outcome.value.url) ?? hostOf(r.url) ?? ""
          const withHost = { ...outcome.value, host }
          fetchedSources.push(withHost)
          const subIndex = subIndexByUrl.get(normalizeUrl(r.url)) ?? startIdx
          readPerSubQuestion[subIndex] = (readPerSubQuestion[subIndex] ?? 0) + 1
          roundFetched.push({ source: withHost, subIndex })
        } else {
          fetchFailures.push({ url: r.url, reason: outcome.reason })
        }
      }
      emit("read", round)

      // Stage 4: judge each fetched source; record claims in the ledger.
      for (const { source, subIndex } of roundFetched) {
        const sub = asked[subIndex]!
        const judged = yield* judgeSource(model, sub, subIndex, {
          url: source.url,
          title: source.title === "" ? source.url : source.title,
          host: source.host,
          text: source.text
        })
        droppedNonVerbatim += judged.droppedNonVerbatim
        if (judged.degraded) {
          // Mechanical fallback (Phase-1 shape): one claim, real excerpt.
          judgeDegraded += 1
          const excerpt = excerptOf(source)
          const title = source.title === "" ? source.url : source.title
          yield* recordClaim(deps.honesty, input.sessionId, input.turnId,
            `According to "${title}" (${source.url}): ${excerpt}`,
            [{ url: source.url, excerpt }])
          allJudged.push({
            text: excerpt,
            excerpt,
            sourceUrl: source.url,
            sourceHost: source.host,
            subQuestionIndex: subIndex,
            intent: sub.intent
          })
        } else {
          for (const claim of judged.claims) {
            yield* recordClaim(deps.honesty, input.sessionId, input.turnId, claim.text, [
              { url: claim.sourceUrl, excerpt: claim.excerpt }
            ])
            allJudged.push(claim)
          }
        }
      }
      emit("judge", round)

      // Stage 5: corroborate everything judged so far.
      const pairs = candidatePairs(allJudged)
      const { relations } = yield* adjudicatePairs(model, query, allJudged, pairs)
      clusters = buildClusters(allJudged, relations)
      emit("corroborate", round)

      // Stage 6: gap analysis; follow-ups feed the next round.
      const coverage = coverageFor(asked, clusters, readPerSubQuestion)
      gaps = analyzeGaps(asked, coverage, clusters)
      emit("gap", round)
      if (fetchedSources.length === 0) {
        // Starvation exit: nothing readable exists for this subject.
        // Stop now — the remaining rounds/budget cannot change that,
        // and spending them would only disguise a fast, legible
        // failure as an exhausted one.
        starvedNoEvidence = true
        break
      }
      if (gaps.length === 0) {
        gapConfirmedClean = true
        break
      }
      if (round >= budget.rounds) break
      const followUps = yield* proposeFollowUps(model, query, asked, gaps, budget.queries - queriesUsed)
      if (followUps.length === 0) break
      roundQuestions = followUps
    }

    // Coverage claim: the run's honest bookkeeping, no evidence by design.
    const coverageText =
      `Coverage: ${fetchedSources.length} of ${seenResults.size} unique results fetched ` +
      `across ${asked.length} sub-question(s) over ${roundsUsed} round(s) for "${query}".` +
      (failedSearches.length > 0 ? ` ${failedSearches.length} search(es) failed: ${failedSearches.join("; ")}.` : "") +
      (fetchFailures.length > 0
        ? ` ${fetchFailures.length} fetch(es) failed: ${fetchFailures.map((f) => `${f.url} (${f.reason})`).join("; ")}.`
        : "") +
      (!plan.fromModel ? " Planner unavailable; ran fallback single-query plan." : "") +
      (judgeDegraded > 0 ? ` Judge degraded on ${judgeDegraded} source(s) — mechanical claims used.` : "") +
      (timedOutStage !== undefined ? ` Timed out during stage "${timedOutStage}" — this is a partial report.` : "") +
      (starvedNoEvidence ? " No readable sources exist for this subject — the run stopped after the first round rather than spending the remaining budget. The subject may have no public web footprint." : "") +
      (droppedNonVerbatim > 0 ? ` ${droppedNonVerbatim} claim(s) dropped: excerpts were not verbatim in their sources.` : "") +
      (truncated ? " Budgets truncated this run." : "")
    yield* recordClaim(deps.honesty, input.sessionId, input.turnId, coverageText, [])

    // Read back every claim with its derived badge — the ledger is the source of truth.
    const claims = yield* deps.honesty.claimsForTurn(input.sessionId, input.turnId)

    // Stage 7: synthesis (answer always; paper additionally for paper mode).
    const answer = yield* synthesizeAnswer(model, query, clusters, gaps)
    const queriesAppendix = `\n\nQueries searched:\n${asked.map((s) => `- (${s.intent}) ${s.question}`).join("\n")}`
    const answerWithPlan = `${planNote}\n\n${answer.replace(/^Research: ".*"\n\n?/, "")}${queriesAppendix}`
    let paper: string | undefined
    if (output === "paper") {
      paper = yield* buildPaper(model, {
        query,
        asked,
        clusters,
        gaps,
        sources: fetchedSources.map((s) => ({
          title: s.title === "" ? s.url : s.title,
          url: s.url,
          host: s.host
        })),
        sourcesSearched: seenResults.size,
        roundsUsed
      })
    }
    emit("synthesis", roundsUsed)

    const termination: ResearchTermination =
      fetchedSources.length === 0
        ? "no-sources"
        : timedOutStage !== undefined
          ? "timeout"
          : gaps.length > 0
            ? "budget-exhausted"
            : gapConfirmedClean
              ? "no-gaps"
              : "answered"
    const visual = comparisonTable(clusters)
    return {
      query,
      depth,
      output,
      plan,
      queries: asked.map((s) => s.question),
      answer: answerWithPlan,
      paper,
      claims,
      clusters,
      gaps,
      visuals: visual !== undefined ? [visual] : [],
      sourcesSearched: seenResults.size,
      sourcesRead: fetchedSources.length,
      roundsUsed,
      judgeDegraded,
      stagePrompts: {
        planner: PLANNER_PROMPT_VERSION,
        judge: JUDGE_PROMPT_VERSION,
        corroborate: CORROBORATE_PROMPT_VERSION,
        gap: GAP_PROMPT_VERSION,
        synthesis: SYNTHESIS_PROMPT_VERSION
      },
      termination
    } satisfies DeepResearchReport
  })
