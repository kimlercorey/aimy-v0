/**
 * deep-research/types.ts — the module's public data shapes.
 *
 * Phase 1 covered the single-round report; the full loop (charter
 * planning/deep-research-spec.md + Extensions v0.2 E5 / v0.3) adds the
 * judge's atomic claims, corroboration clusters, gap notes, and visuals.
 *
 * Honesty contract (inherited from web-retrieval): a DeepResearchReport
 * carries factual claims as records with HonestyService-derived badges.
 * Judged claims are recorded individually with verbatim-excerpt evidence;
 * the coverage claim stays badge-unverified by construction.
 */
import type { ClaimWithBadge } from "../../honesty/src/types.js"

/** Research depth: controls query/fetch budgets and rounds. */
export type ResearchDepth = "quick" | "standard" | "deep"

/** Paper mode forces depth "deep" and a structured visual-first document. */
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
   * to the single-query default. The fallback is logged, not hidden.
   */
  readonly fromModel: boolean
}

/** Hard per-depth budgets: total queries and fetches across ALL rounds. */
export interface DepthBudget {
  readonly rounds: number
  readonly queries: number
  readonly fetches: number
}

export const DEPTH_BUDGETS: Record<ResearchDepth, DepthBudget> = {
  quick: { rounds: 1, queries: 3, fetches: 4 },
  standard: { rounds: 2, queries: 8, fetches: 10 },
  deep: { rounds: 3, queries: 15, fetches: 16 }
} as const

/** Minimum delay between search requests (DDG politeness). */
export const SEARCH_POLITENESS_DELAY_MS = 1200

/**
 * One atomic claim extracted by the judge from one source. The excerpt is
 * the evidence: a VERBATIM slice of the source text (E7), at most 400
 * chars — the judge's non-verbatim excerpts are dropped, never trusted.
 */
export interface JudgedClaim {
  readonly text: string
  readonly excerpt: string
  readonly sourceUrl: string
  readonly sourceHost: string
  /** Index into the FULL asked-question list (plan + follow-ups, in ask order). */
  readonly subQuestionIndex: number
  readonly intent: SubQuestion["intent"]
}

/**
 * A corroboration cluster: judged claims the adjudicator judged to be the
 * SAME claim, grouped. Corroborated = backed by >= 2 distinct hosts (E6).
 * Contested = another cluster contradicts this one; contradictions attach
 * and both sides are presented — they never veto.
 */
export interface ClaimCluster {
  readonly id: string
  /** Representative claim text (first claim, in read order). */
  readonly text: string
  readonly claimCount: number
  readonly hosts: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<{ readonly url: string; readonly excerpt: string }>
  readonly corroborated: boolean
  readonly contested: boolean
  /** Ids of clusters that contradict this one. */
  readonly contradictedBy: ReadonlyArray<string>
  readonly subQuestionIndexes: ReadonlyArray<number>
}

/** A coverage gap found by gap analysis; follow-ups may target it next round. */
export interface GapNote {
  readonly description: string
  readonly subQuestionIndex?: number
  readonly intent?: SubQuestion["intent"]
}

/** A visual for the deliverable (E9 v1: rendered markdown artifacts). */
export interface ResearchVisual {
  readonly kind: "comparison-table"
  readonly markdown: string
}

export type ResearchTermination = "answered" | "budget-exhausted" | "no-sources" | "no-gaps" | "timeout"

/** What `research()` returns: the full-loop report (E5 contract). */
export interface DeepResearchReport {
  readonly query: string
  readonly depth: ResearchDepth
  readonly output: ResearchOutput
  /** The plan that ran (model or fallback — see ResearchPlan.fromModel). */
  readonly plan: ResearchPlan
  /** Every sub-question actually searched, in ask order, follow-ups included (E10: the full query set is part of the report). */
  readonly queries: ReadonlyArray<string>
  /** Synthesized answer (model synthesis over cluster summaries, or the deterministic rendering when synthesis degraded). */
  readonly answer: string
  /** For paper mode: the assembled paper markdown (E8 structure). */
  readonly paper?: string | undefined
  /** Every claim made, each paired with its HonestyService-derived badge. */
  readonly claims: ReadonlyArray<ClaimWithBadge>
  /** Corroboration clusters over the judged claims. */
  readonly clusters: ReadonlyArray<ClaimCluster>
  /** Gaps remaining when the run terminated. */
  readonly gaps: ReadonlyArray<GapNote>
  /** Visuals for the deliverable (comparison table when claims support one). */
  readonly visuals: ReadonlyArray<ResearchVisual>
  /** Coverage bookkeeping: searched vs. fetched vs. reported. */
  readonly sourcesSearched: number
  readonly sourcesRead: number
  /** Rounds actually executed (1 = the Phase-1 shape). */
  readonly roundsUsed: number
  /** Sources whose judge degraded to the mechanical fallback claim. */
  readonly judgeDegraded: number
  /** Versioned stage prompts that ran (provenance; E5). */
  readonly stagePrompts: Readonly<Record<string, string>>
  readonly termination: ResearchTermination
}
