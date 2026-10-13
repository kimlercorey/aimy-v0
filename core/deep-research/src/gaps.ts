/**
 * deep-research/gaps.ts — Stage: Gap analysis (charter §3.6; E5).
 *
 * After each round, coverage is checked per asked sub-question: did any
 * source get read for it, did any cluster answer it, is the answer
 * corroborated? Counterpoint coverage is checked separately — a run
 * where nobody disagrees on record is a coverage gap by charter, not a
 * consensus. Contested clusters are gaps too: a dispute with only one
 * source per side needs more evidence.
 *
 * Follow-up sub-questions come from the model (gap/v1) over a COMPACT
 * coverage summary (counts and gap descriptions — never the corpus,
 * E14). Degradation: model failure falls back to re-asking the uncovered
 * sub-questions directly. Dedupe against everything already asked.
 */
import { Effect } from "effect"
import type { PlanModel } from "./planner.js"
import type { ClaimCluster, GapNote, SubQuestion } from "./types.js"

export const GAP_PROMPT_VERSION = "gap/v1"

export interface SubQuestionCoverage {
  readonly sourcesRead: number
  readonly clusters: number
  readonly corroboratedClusters: number
}

/** Per-sub-question coverage from the run's clusters and read counts. */
export const coverageFor = (
  asked: ReadonlyArray<SubQuestion>,
  clusters: ReadonlyArray<ClaimCluster>,
  readPerSubQuestion: ReadonlyArray<number>
): SubQuestionCoverage[] =>
  asked.map((_, i) => ({
    sourcesRead: readPerSubQuestion[i] ?? 0,
    clusters: clusters.filter((c) => c.subQuestionIndexes.includes(i)).length,
    corroboratedClusters: clusters.filter((c) => c.subQuestionIndexes.includes(i) && c.corroborated).length
  }))

/** Detect gaps from coverage. Pure. */
export const analyzeGaps = (
  asked: ReadonlyArray<SubQuestion>,
  coverage: ReadonlyArray<SubQuestionCoverage>,
  clusters: ReadonlyArray<ClaimCluster>
): GapNote[] => {
  const gaps: GapNote[] = []
  asked.forEach((sub, i) => {
    const cov = coverage[i]!
    if (cov.sourcesRead === 0) {
      gaps.push({
        description: `No sources could be read for "${sub.question}" (${sub.intent}).`,
        subQuestionIndex: i,
        intent: sub.intent
      })
    } else if (cov.clusters === 0) {
      gaps.push({
        description: `Sources were read for "${sub.question}" (${sub.intent}) but yielded no claims.`,
        subQuestionIndex: i,
        intent: sub.intent
      })
    } else if (cov.corroboratedClusters === 0 && sub.intent !== "background") {
      gaps.push({
        description: `"${sub.question}" (${sub.intent}) rests on single-source claims only — nothing corroborated yet.`,
        subQuestionIndex: i,
        intent: sub.intent
      })
    }
  })
  // Counterpoint coverage is a charter-level requirement, checked globally.
  const counterpointAsked = asked.some((s) => s.intent === "counterpoint")
  const counterpointCovered = clusters.some((c) =>
    c.subQuestionIndexes.some((i) => asked[i]?.intent === "counterpoint")
  )
  if (counterpointAsked && !counterpointCovered) {
    gaps.push({ description: "No counterpoint position is on record — disagreement was sought but none was captured.", intent: "counterpoint" })
  }
  // A dispute is a gap only while a side is thin: once both sides are
  // corroborated, the dispute itself is a FINDING (presented both-sides
  // in synthesis), not missing coverage.
  const byId = new Map(clusters.map((c) => [c.id, c]))
  for (const c of clusters) {
    if (!c.contested) continue
    const otherSideThin = c.contradictedBy.some((id) => byId.get(id)?.corroborated !== true)
    if (!c.corroborated || otherSideThin) {
      const firstSub = c.subQuestionIndexes[0]
      gaps.push({
        description: `Contested claim needs more evidence: "${c.text}" (contradicted by ${c.contradictedBy.join(", ")}).`,
        ...(firstSub !== undefined ? { subQuestionIndex: firstSub } : {})
      })
    }
  }
  return gaps
}

const SYSTEM_PROMPT = `You are a research gap analyst. Given the research question, the coverage so far, and the gaps found, propose follow-up search sub-questions that would close the most important gaps.

Return ONLY valid JSON: {"subQuestions": [{"question": "...", "intent": "...", "siteScope": "..."}]}
- "intent" must be one of: background, evidence, counterpoint, primary-source.
- "siteScope" is optional (e.g. "site:arxiv.org").
- Each question must target a stated gap — do not repeat questions already asked.
- No prose outside the JSON. No markdown fences.`

const isFollowUp = (v: unknown): v is SubQuestion => {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o["question"] === "string" &&
    (o["question"] as string).trim().length > 0 &&
    typeof o["intent"] === "string" &&
    ["background", "evidence", "counterpoint", "primary-source"].includes(o["intent"] as string) &&
    (o["siteScope"] === undefined || typeof o["siteScope"] === "string")
  )
}

/**
 * Propose follow-up sub-questions for the next round, capped at `cap`.
 * Never fails: the fallback re-asks uncovered sub-questions directly.
 */
export const proposeFollowUps = (
  model: PlanModel,
  query: string,
  asked: ReadonlyArray<SubQuestion>,
  gaps: ReadonlyArray<GapNote>,
  cap: number
): Effect.Effect<SubQuestion[], never> =>
  Effect.gen(function* () {
    if (gaps.length === 0 || cap <= 0) return []
    const askedTexts = new Set(asked.map((s) => s.question.trim().toLowerCase()))
    const raw = yield* model
      .generateText(
        SYSTEM_PROMPT,
        `Research question: ${query}\nAlready asked:\n${asked.map((s) => `- (${s.intent}) ${s.question}`).join("\n")}\nGaps:\n${gaps.map((g) => `- ${g.description}`).join("\n")}\nPropose at most ${cap} follow-up sub-questions.`
      )
      .pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)))
    if (raw !== undefined) {
      try {
        const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
        const parsed = JSON.parse(cleaned) as { subQuestions?: unknown }
        if (Array.isArray(parsed.subQuestions)) {
          const fresh = parsed.subQuestions
            .filter(isFollowUp)
            .filter((s) => !askedTexts.has(s.question.trim().toLowerCase()))
            .slice(0, cap)
          if (fresh.length > 0) return fresh
        }
      } catch {
        // Fall through to the rule-based fallback.
      }
    }
    // Rule-based fallback: re-ask the uncovered sub-questions themselves.
    const seen = new Set<string>()
    const out: SubQuestion[] = []
    for (const g of gaps) {
      if (g.subQuestionIndex === undefined) continue
      const sub = asked[g.subQuestionIndex]
      if (sub === undefined) continue
      const key = sub.question.trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(sub)
      if (out.length >= cap) break
    }
    return out
  })
