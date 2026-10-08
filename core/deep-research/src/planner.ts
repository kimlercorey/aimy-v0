/**
 * deep-research/planner.ts — Stage 1: decompose the question into sub-questions.
 *
 * The planner prompts the local model for a JSON research plan covering four
 * intents (background, evidence, counterpoint, primary-source). Prompts are
 * versioned (`PLANNER_PROMPT_VERSION`) so the learning loop can refine them
 * later without code changes — the version rides in the report's provenance.
 *
 * Failure contract: the model failing (PlanError) or answering unusable JSON
 * (MalformedPlan) never fails the run — `planWithFallback` returns the
 * single-query fallback plan with `fromModel: false`, and the caller logs it.
 * A plan that silently degraded is worse than an honest fallback.
 */
import { Effect } from "effect"
import { MalformedPlan, PlanError } from "./errors.js"
import type { ResearchPlan, SubQuestion } from "./types.js"

/** Bump when the prompt text changes; the learning loop keys refinements off this. */
export const PLANNER_PROMPT_VERSION = "planner/v1"

const SYSTEM_PROMPT = `You are a research planner. Decompose the user's question into focused sub-questions for web search.

Return ONLY valid JSON in exactly this shape:
{"subQuestions": [{"question": "...", "intent": "...", "siteScope": "..."}]}

Rules:
- "intent" must be one of: background, evidence, counterpoint, primary-source.
- "siteScope" is optional; use "site:sec.gov" for company filings, "site:arxiv.org" for papers, or omit it for general web search.
- Cover these intents: background (what is X), evidence (who reports the specific claim), counterpoint (who disagrees or offers an alternative — seek this deliberately, do not assume consensus), primary-source (filings, papers, official docs).
- For competitive questions, identify the player set explicitly: who competes with whom.
- For science questions, weight primary-source and counterpoint (replication status, disputed claims) over press coverage.
- Keep each question focused for a search engine. Return 3 to 8 sub-questions.
- No prose outside the JSON. No markdown fences.`

const VALID_INTENTS = new Set(["background", "evidence", "counterpoint", "primary-source"])

/**
 * Narrow model interface the planner needs. InferencePool satisfies this via
 * an adapter in research.ts; tests stub it. The planner never sees the full
 * pool surface.
 */
export interface PlanModel {
  readonly generateText: (system: string, user: string) => Effect.Effect<string, PlanError>
}

const isSubQuestion = (v: unknown): v is SubQuestion => {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o["question"] === "string" &&
    (o["question"] as string).trim().length > 0 &&
    typeof o["intent"] === "string" &&
    VALID_INTENTS.has(o["intent"] as string) &&
    (o["siteScope"] === undefined || typeof o["siteScope"] === "string")
  )
}

/**
 * Parse and validate planner output. Pure — no model, no network.
 * Returns the plan or a MalformedPlan describing exactly what was wrong.
 */
export const parsePlan = (raw: string): Effect.Effect<ResearchPlan, MalformedPlan> => {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return Effect.fail(
      new MalformedPlan({ reason: "planner output is not valid JSON", raw: raw.slice(0, 500) })
    )
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { subQuestions?: unknown }).subQuestions)
  ) {
    return Effect.fail(
      new MalformedPlan({ reason: 'planner output lacks a "subQuestions" array', raw: raw.slice(0, 500) })
    )
  }
  const subs = (parsed as { subQuestions: ReadonlyArray<unknown> }).subQuestions
  if (subs.length === 0) {
    return Effect.fail(
      new MalformedPlan({ reason: "planner returned zero sub-questions", raw: raw.slice(0, 500) })
    )
  }
  const invalid = subs.findIndex((s) => !isSubQuestion(s))
  if (invalid !== -1) {
    return Effect.fail(
      new MalformedPlan({
        reason: `sub-question #${invalid} has an invalid shape (needs non-empty question, valid intent, optional siteScope)`,
        raw: raw.slice(0, 500),
      })
    )
  }
  return Effect.succeed({
    subQuestions: subs as ReadonlyArray<SubQuestion>,
    fromModel: true,
  })
}

/** The honest fallback: one unscoped evidence sub-question — today's retrieval behavior. */
export const fallbackPlan = (query: string): ResearchPlan => ({
  subQuestions: [{ question: query, intent: "evidence", siteScope: undefined }],
  fromModel: false,
})

/**
 * Plan the research: ask the model, parse, or fall back.
 * Never fails the run — model failure degrades to the fallback plan.
 */
export const planWithFallback = (
  model: PlanModel,
  query: string
): Effect.Effect<ResearchPlan, never> =>
  model.generateText(SYSTEM_PROMPT, query).pipe(
    Effect.flatMap((raw) =>
      parsePlan(raw).pipe(
        Effect.catchTag("MalformedPlan", (e) =>
          Effect.succeed(fallbackPlan(query)).pipe(
            Effect.tap(() => Effect.logWarning(`planner fallback: ${e.reason}`))
          )
        )
      )
    ),
    Effect.catch((e) =>
      Effect.succeed(fallbackPlan(query)).pipe(
        Effect.tap(() =>
          Effect.logWarning(`planner fallback: model error: ${e instanceof PlanError ? e.reason : String(e)}`)
        )
      )
    )
  )
