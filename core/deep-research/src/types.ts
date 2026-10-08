/**
 * deep-research/types.ts — the module's public data shapes.
 *
 * Phase 1 covers: ResearchQueryArgs, SubQuestion, ResearchPlan, budgets,
 * and the single-round DeepResearchReport. Judge/corrob-orate/gap/visual
 * shapes land in Phases 2–4 per planning/deep-research-spec.md.
 *
 * Honesty contract (inherited from web-retrieval): a DeepResearchReport
 * carries factual claims only as records with HonestyService-derived badges.
 * Phase 1 reuses web-retrieval's claim model (one "according to <source>"
 * claim per fetched source); the plan itself is bookkeeping, not a claim.
 */
import type { ClaimWithBadge } from "../../honesty/src/types.js"

/** Research depth: controls query/fetch budgets and rounds (Phase 1: rounds = 1). */
export type ResearchDepth = "quick" | "standard" | "deep"

/** Paper mode forces depth "deep" and a structured visual-first document (Phase 4). */
export type ResearchOutput = "answer" | "paper"

export interface ResearchQueryArgs {
  readonly query: string
  readonly depth?: ResearchDepth | undefined
  readonly maxSources?: number | undefined
  readonly output?: ResearchOutput | undefined
}

/** One focused search the planner derives from the user's question. */
export interface SubQuestion {
  readonly question: string
  readonly intent: "background" | "evidence" | "counterpoint" | "primary-source"
  /** e.g. "site:sec.gov", "site:arxiv.org", or undefined for general web. */
  readonly siteScope?: string | undefined
}

export interface ResearchPlan {
  readonly subQuestions: ReadonlyArray<SubQuestion>
  /**
   * True when the plan came from the model; false when the planner fell back
   * to the single-query default (unparseable model output, model error).
   * The fallback is logged, not hidden — the report states which path ran.
   */
  readonly fromModel: boolean
}

/** Hard per-depth budgets. Phase 1 runs a single round; rounds > 1 arrive in Phase 3. */
export interface DepthBudget {
  readonly rounds: number
  readonly queries: number
  readonly fetches: number
}

export const DEPTH_BUDGETS: Record<ResearchDepth, DepthBudget> = {
  quick: { rounds: 1, queries: 3, fetches: 4 },
  standard: { rounds: 2, queries: 8, fetches: 10 },
  deep: { rounds: 3, queries: 15, fetches: 16 },
} as const

/** Minimum delay between search requests (DDG politeness). */
export const SEARCH_POLITENESS_DELAY_MS = 1200

/** What `research()` returns in Phase 1: planned, multi-query, single-round. */
export interface DeepResearchReport {
  readonly query: string
  readonly depth: ResearchDepth
  readonly output: ResearchOutput
  /** The plan that ran (model or fallback — see ResearchPlan.fromModel). */
  readonly plan: ResearchPlan
  /** Human-readable rendering; each claim labeled with its badge status. */
  readonly answer: string
  /** Every claim made, each paired with its HonestyService-derived badge. */
  readonly claims: ReadonlyArray<ClaimWithBadge>
  /** Coverage bookkeeping: searched vs. fetched vs. reported. */
  readonly sourcesSearched: number
  readonly sourcesRead: number
  /** "answered" when the single round completed; "budget-exhausted" when caps truncated it. */
  readonly termination: "answered" | "budget-exhausted"
}
