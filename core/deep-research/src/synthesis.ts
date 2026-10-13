/**
 * deep-research/synthesis.ts — Stage: Synthesis (charter §3.7; E8/E9).
 *
 * Synthesis consumes CLUSTER SUMMARIES, never the source corpus (E14).
 * The model writes the answer narrative (synthesis/v1) from numbered
 * cluster lines with their corroboration status; on any model failure
 * the deterministic rendering takes over — same content, plainer voice,
 * never an empty answer.
 *
 * Status vocabulary in every rendering:
 * - [corroborated] >= 2 independent hosts assert it.
 * - [single-source] exactly one host asserts it — stated, not hidden.
 * - [contested] another cluster contradicts it — both sides presented.
 *
 * Papers (E8) assemble section by section: header with TRUE counts,
 * visual summary (comparison table, E9 v1), summary (model prose over
 * clusters), findings grouped by sub-question (deterministic — fidelity
 * to the ledger outranks voice), comparison when positions diverge,
 * disputes, gaps, sources.
 */
import { Effect } from "effect"
import type { PlanModel } from "./planner.js"
import type { ClaimCluster, GapNote, ResearchVisual, SubQuestion } from "./types.js"

export const SYNTHESIS_PROMPT_VERSION = "synthesis/v1"

const statusOf = (c: ClaimCluster): string =>
  c.contested ? "contested" : c.corroborated ? "corroborated" : "single-source"

const clusterLine = (c: ClaimCluster, i: number): string =>
  `${i + 1}. [${statusOf(c)}] ${c.text} (sources: ${c.hosts.join(", ")})`

/** The comparison table (E9 v1 visual): notable claims x support x status. */
export const comparisonTable = (clusters: ReadonlyArray<ClaimCluster>): ResearchVisual | undefined => {
  const notable = clusters.filter((c) => c.corroborated || c.contested).slice(0, 12)
  if (notable.length === 0) return undefined
  const rows = notable.map((c) => {
    const text = c.text.length > 90 ? `${c.text.slice(0, 90)}…` : c.text
    return `| ${text.replace(/\|/g, "/")} | ${c.hosts.length} (${c.hosts.join(", ")}) | ${statusOf(c)} |`
  })
  return {
    kind: "comparison-table",
    markdown: [`| Claim | Sources | Status |`, `| --- | --- | --- |`, ...rows].join("\n")
  }
}

/** Deterministic answer rendering — the synthesis fallback, and the paper's fidelity layer. */
export const renderDeterministic = (
  query: string,
  clusters: ReadonlyArray<ClaimCluster>,
  gaps: ReadonlyArray<GapNote>
): string => {
  const lines: string[] = [`Research: "${query}"`, ""]
  const corroborated = clusters.filter((c) => c.corroborated && !c.contested)
  const single = clusters.filter((c) => !c.corroborated && !c.contested)
  const contested = clusters.filter((c) => c.contested)
  if (corroborated.length > 0) {
    lines.push("Corroborated findings:", ...corroborated.map((c, i) => clusterLine(c, i)), "")
  }
  if (single.length > 0) {
    lines.push("Single-source findings (not yet corroborated):", ...single.map((c, i) => clusterLine(c, i)), "")
  }
  if (contested.length > 0) {
    lines.push("Disputed (sources disagree — both sides stand):", ...contested.map((c, i) => clusterLine(c, i)), "")
  }
  if (clusters.length === 0) {
    lines.push("No claims could be extracted from the sources read.", "")
  }
  if (gaps.length > 0) {
    lines.push("Gaps:", ...gaps.map((g) => `- ${g.description}`), "")
  }
  return lines.join("\n").trim()
}

const SYNTHESIS_SYSTEM = `You are writing the answer to a research question from corroborated findings. You are given numbered findings with status labels: [corroborated] (multiple independent sources), [single-source] (one source only), [contested] (sources disagree).

Rules:
- Use ONLY the findings given. Do not add facts, numbers, or names that are not in them.
- Present corroborated findings as established. Mark single-source findings as single-source. For contested findings, present BOTH sides and say the sources disagree.
- Cite findings inline like [1], [2] matching the numbering given.
- Close with a short "What remains uncertain" line if gaps are listed.
- Plain markdown, concise. No preamble like "Based on the research".`

/**
 * Model synthesis over cluster summaries. Degrades to the deterministic
 * rendering on any failure — synthesis never fails the run.
 */
export const synthesizeAnswer = (
  model: PlanModel,
  query: string,
  clusters: ReadonlyArray<ClaimCluster>,
  gaps: ReadonlyArray<GapNote>
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const deterministic = renderDeterministic(query, clusters, gaps)
    if (clusters.length === 0) return deterministic
    const listing = clusters.map((c, i) => clusterLine(c, i)).join("\n")
    const gapText = gaps.length > 0 ? `\nGaps:\n${gaps.map((g) => `- ${g.description}`).join("\n")}` : ""
    const raw = yield* model
      .generateText(SYNTHESIS_SYSTEM, `Question: ${query}\n\nFindings:\n${listing}${gapText}`)
      .pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)))
    if (raw === undefined || raw.trim() === "") return deterministic
    // A bare JSON object is never an answer — a confused model answering
    // a different stage's prompt (observed in harness) must degrade to
    // the deterministic rendering, not leak planning JSON as prose.
    if (raw.trim().startsWith("{")) return deterministic
    return raw.trim()
  })

/** Assemble the paper (E8 structure). Section by section; counts are the run's true counts. */
export const buildPaper = (
  model: PlanModel,
  input: {
    query: string
    asked: ReadonlyArray<SubQuestion>
    clusters: ReadonlyArray<ClaimCluster>
    gaps: ReadonlyArray<GapNote>
    sources: ReadonlyArray<{ title: string; url: string; host: string }>
    sourcesSearched: number
    roundsUsed: number
  }
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const { query, asked, clusters, gaps, sources } = input
    const corroboratedCount = clusters.filter((c) => c.corroborated).length
    const contestedCount = clusters.filter((c) => c.contested).length
    const visual = comparisonTable(clusters)
    const summary = yield* synthesizeAnswer(model, query, clusters, gaps)
    const sections: string[] = []
    sections.push(
      `# Research — ${query}`,
      "",
      `> ${sources.length} source(s) read of ${input.sourcesSearched} found · ${clusters.length} claim cluster(s) · ${corroboratedCount} corroborated · ${contestedCount} contested · ${input.roundsUsed} round(s). Badges derive from the honesty ledger; contested claims are presented both-sides, never resolved by silence.`,
      ""
    )
    sections.push("## Visual summary", "", visual !== undefined ? visual.markdown : "No corroborated or contested claims to tabulate — see Findings.", "")
    sections.push("## Summary", "", summary, "")
    // Findings grouped by sub-question (deterministic — ledger fidelity).
    sections.push("## Findings", "")
    asked.forEach((sub, i) => {
      const mine = clusters.filter((c) => c.subQuestionIndexes.includes(i))
      if (mine.length === 0) return
      sections.push(`### ${sub.question}`, "", ...mine.map((c, j) => clusterLine(c, j)), "")
    })
    const contested = clusters.filter((c) => c.contested)
    if (contested.length > 0) {
      sections.push(
        "## Disputes & uncertainty",
        "",
        "Sources disagree on the following. Both sides are presented; the run does not resolve disputes by omitting one side.",
        "",
        ...contested.map((c, i) => clusterLine(c, i)),
        ""
      )
    }
    if (gaps.length > 0) {
      sections.push("## Gaps & follow-ups", "", ...gaps.map((g) => `- ${g.description}`), "")
    }
    sections.push(
      "## Queries searched",
      "",
      "The full query set for this run (E10 — the investigation is reproducible from this list):",
      "",
      ...asked.map((s) => `- (${s.intent}) ${s.question}`),
      ""
    )
    sections.push(
      "## Sources",
      "",
      ...(sources.length > 0
        ? sources.map((s, i) => `${i + 1}. [${s.title}](${s.url}) — ${s.host}`)
        : ["No sources could be read."]),
      ""
    )
    return sections.join("\n").trim()
  })
