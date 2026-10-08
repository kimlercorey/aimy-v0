# Deep Research — loop spec (v0.1 draft, 2026-10-07)

*Status: spec for review. Not approved for build.*

## 1. Goal

Give AImy a research capability that earns the name `research.query` — currently
reserved after the web-research → web-retrieval rename. Where `retrieval.query`
answers "what do three sources say," `research.query` answers "what is true,
who agrees, who disagrees, and what couldn't be verified."

**Focus domains:** competitive landscape for products and ideas, scientific
exploration, and general science. The planner (§3.1) is tuned for these:
comparison structure for competitive questions, primary-source grounding for
science.

**Output:** when the user asks for a *paper*, the run goes deep (depth
`deep`, §5) and the synthesis produces a structured, readable document —
not a chat answer. Papers lead with visuals: comparison tables, diagrams,
and charts that carry the findings, with prose in support. (Kimler is a
visual-first reader: diagrams over walls of text.)

**Non-goals:** replacing the retrieval module (it stays: fast, honest, simple);
paid search APIs; cloud model calls; JS rendering; PDF parsing. Every stage
runs on the local model and free sources. If a stage can't run locally, it
doesn't ship.

## 2. Architecture

New module `core/deep-research/`, SKILL.md manifest `name: deep-research`,
contributing one tool: `research.query`. It orchestrates — it does not
reimplement:

| Dependency | Used for |
|---|---|
| `web-retrieval` provider + `fetchSource` | search dispatch, fetch, readability extraction, honest fetch failures |
| `InferencePool.generate` | planner, judge, corroborator, gap analysis, synthesis (all local model) |
| `HonestyService` | claim recording, evidence attachment, badge derivation (unchanged) |

The loop is an Effect program, stages as pure functions where possible.
The agent loop does not change; deep research is a module-internal loop,
invoked as one tool call. CLI gains `/research <query>` (deep) alongside
the existing `/retrieve` (quick).

## 3. The loop

```
query + depth
  │ Stage 1: PLAN (model)
  ▼
ResearchPlan { subQuestions[] }
  │ Stage 2: FAN-OUT (retrieval provider, polite)
  ▼
SearchResults (deduped URLs)
  │ Stage 3: READ (fetchSource — readability + honest failures)
  ▼
FetchedSources
  │ Stage 4: JUDGE (model, per source)
  ▼
JudgedSources { relevance 0|1|2, atomic claims[] }
  │ Stage 5: CORROBORATE (pre-filter pure + model)
  ▼
ClaimClusters { representative, supporting[], contradicting[] }
  │ Stage 6: GAP ANALYSIS (model)
  ▼
  gaps? ──yes──▶ new SubQuestions ──▶ Stage 2 (next round, budget permitting)
  │
  no (or budget exhausted)
  ▼
Stage 7: SYNTHESIS (model) → answer + claims → HonestyService
```

### Stage 1 — Plan

Prompt the local model: decompose the query into sub-questions, each tagged
with intent and an optional site scope. The prompt *requires* coverage of four
intents; the model may return fewer sub-questions than intents if some don't
apply, but it must not return zero.

```ts
interface SubQuestion {
  readonly question: string
  readonly intent: "background" | "evidence" | "counterpoint" | "primary-source"
  readonly siteScope?: string // e.g. "site:sec.gov", "site:arxiv.org"
}
interface ResearchPlan { readonly subQuestions: ReadonlyArray<SubQuestion> }
```

- `background`: what is X (Wikipedia, docs, explainers).
- `evidence`: who reports the specific claim (news, analysts).
- `counterpoint`: who disagrees or offers an alternative (deliberate; the
  default web search over-ranks consensus).
- `primary-source`: filings, papers, official docs (`site:sec.gov`,
  `site:arxiv.org`, company domains).

For competitive-landscape questions the planner is instructed to add a
`comparison` framing: it must identify the player set explicitly (who
competes with whom) so the synthesis can build the comparison matrix (§3.7).
For science questions it weights `primary-source` and `counterpoint`
(replication status, disputed claims) over press coverage.

Planner output is JSON; parse failure → fall back to a single unscoped
sub-question (today's retrieval behavior). The fallback is logged, not hidden.

### Stage 2 — Fan-out

Each sub-question becomes one DDG query (`${siteScope} ${question}`).
Dedupe URLs across sub-questions (normalized: strip tracking params, trailing
slash). **Politeness budget:** ≥1200ms between searches; hard cap per depth
(see §5). A search that fails (rate-limit, malformed) drops that sub-question
with a recorded reason — the loop continues with the rest.

### Stage 3 — Read

`fetchSource` per candidate URL, exactly as web-retrieval does: readability
extraction, `mainContent` flag, honest JS-shell/paywall failures. Failed
fetches are recorded in the coverage statement, not silently dropped.

### Stage 4 — Judge

Per fetched source, one structured model call:

```ts
interface JudgedSource {
  readonly url: string
  readonly title: string
  /** 0 = irrelevant, 1 = background-useful, 2 = directly supports claims */
  readonly relevance: 0 | 1 | 2
  /** Atomic factual claims the source text actually supports. Empty if none. */
  readonly claims: ReadonlyArray<string>
}
```

Relevance 0 sources are excluded from corroboration but counted in coverage.
The judge prompt forbids inventing claims: every claim must be quotable from
the source text. (Enforcement is prompt-level; the honesty layer's evidence
attachment is what makes it structural — a claim without a source URL never
reaches the report.)

### Stage 5 — Corroborate

Group atomic claims into clusters with supporting/contradicting source sets.

```ts
interface ClaimCluster {
  readonly representative: string   // canonical phrasing
  readonly supporting: ReadonlyArray<string>   // urls
  readonly contradicting: ReadonlyArray<string> // urls
}
```

Two-phase for cost control (this is the most model-intensive stage):

1. **Pure pre-filter:** normalized token-overlap (lowercase, stopword-stripped,
   Jaccard ≥ 0.4) proposes candidate pairs. No model calls.
2. **Model adjudication:** per candidate pair, one small judgment —
   `support | contradict | unrelated`. Pairs are batched into as few calls
   as the model's context allows.

Corroboration bar: ≥2 supporting urls from **different hosts** → corroborated.
A contradicting source does not veto the claim; it attaches as
counter-evidence and the synthesis must mention the dispute. Silence is not
consensus.

### Stage 6 — Gap analysis

Model reviews the clusters against the original plan: which sub-questions
have no supporting cluster? Which clusters are single-source on a contested
point? Output: `ResearchGap { description, followUp: SubQuestion[] }`.
Follow-ups re-enter at Stage 2. Termination: no gaps, or round budget
exhausted, or all sub-questions answered. The report always states which of
these stopped the loop.

### Stage 7 — Synthesis

Two output modes. `answer` (default): the chat-style synthesis described
below. `paper`: a structured document for when the user asks for a paper —
always runs at depth `deep`, and leads with visuals.

**Paper structure:**

1. **Visual summary first** — the findings as visuals (§3.8), then prose.
2. Sections: Summary → Findings (per cluster) → Comparison (competitive
   questions: player matrix) → Disputes (contradicting sources, both sides)
   → Gaps (explicitly unverified) → Sources.
3. Every factual claim recorded in HonestyService (below); the paper's
   prose carries badge markers, the visuals carry source keys.

**Claim recording** (both modes) — every factual claim goes to
HonestyService:

- claim text = cluster representative,
- evidence = one attachment per supporting url (`kind: "source"`),
- contradicting urls attached as counter-evidence (`kind: "counter-source"`).

Badge derivation is unchanged (`verified` = ≥1 evidence, no failures):
corroboration surfaces as evidence *count* — the report renders
"verified · 3 sources" from `evidenceFor`. Synthesis framing and the
coverage statement are recorded with no evidence → `unverified`, labeled.
Gaps are listed explicitly: "could not verify: …".

### Stage 8 — Visuals (paper mode)

The synthesis emits visual specs alongside prose; the renderer (not the
model) draws them. The model never hand-draws charts — it emits data, the
code renders it. This keeps visuals honest: every visual element binds to
claim clusters with evidence.

```ts
type Visual =
  | { kind: "comparison-matrix"
      rows: string[]            // players / options
      cols: string[]            // dimensions (price, features, …)
      cells: string[][]         // cell text, each bound to a claim id
      claimIds: string[][] }
  | { kind: "bar-chart"
      title: string
      items: Array<{ label: string; value: number; claimId: string }> }
  | { kind: "timeline"
      title: string
      events: Array<{ date: string; label: string; claimId: string }> }
  | { kind: "diagram"           // mermaid source, concept maps / flows
      title: string
      mermaid: string
      claimIds: ReadonlyArray<string> }
```

- **Comparison matrix** is the default visual for competitive-landscape
  papers: players × dimensions, every cell traceable to a claim.
- **Bar chart** for quantitative comparisons (market share, pricing,
  benchmarks) — only from clusters with numeric claims; no invented numbers.
- **Timeline** for science/history questions (discoveries, product launches).
- **Diagram** (mermaid) for mechanisms, architectures, concept relationships.
- Every visual carries a caption stating its source basis
  ("3 sources", "single source", "disputed — see Disputes").
- Rendering targets: desktop renders SVG (mermaid + charts); CLI renders
  the matrix/timeline as aligned text and notes that charts are available
  in the desktop/paper export. A paper exports as a self-contained document
  (markdown + rendered SVGs) the user can keep.

## 4. Data shapes (summary)

```ts
interface ResearchQueryArgs {
  readonly query: string
  readonly depth?: "quick" | "standard" | "deep"  // default "standard"
  readonly maxSources?: number | undefined
  /** "paper" ⇒ depth defaults to "deep", output is a structured document with visuals */
  readonly output?: "answer" | "paper"            // default "answer"
}
interface ResearchGap {
  readonly description: string
  readonly followUp: ReadonlyArray<SubQuestion>
}
interface DeepResearchReport {
  readonly query: string
  readonly answer: string
  readonly clusters: ReadonlyArray<ClaimCluster>
  readonly gaps: ReadonlyArray<string>
  readonly termination: "answered" | "no-gaps" | "budget-exhausted"
  readonly sourcesSearched: number
  readonly sourcesRead: number
  /** paper mode only: visual specs bound to claim ids (§3.8) */
  readonly visuals: ReadonlyArray<Visual>
}
```

## 5. Budgets (hard caps)

| Depth | Rounds | Search queries | Fetches | Approx. model calls |
|---|---|---|---|---|
| quick | 1 | 3 | 4 | ~8 |
| standard | 2 | 8 | 10 | ~25 |
| deep | 3 | 15 | 16 | ~45 |

- ≥1200ms between search requests (DDG politeness).
- Per-stage timeout 90s; total run cap 6 min (deep). Timeout → partial
  report with coverage statement, never a silent truncation.
- Progress reporting: the tool streams stage transitions (planning →
  searching 3/8 → reading → judging → corroborating → synthesizing) so a
  multi-minute run isn't a black box. CLI renders these; desktop maps them
  to the comms-banner/progress surface.

## 6. Failure modes (each honest, each tested)

| Failure | Behavior |
|---|---|
| Planner JSON unparseable | single-query fallback (retrieval-grade), logged |
| All searches empty | report: "no sources found", zero claims |
| All fetches fail | report with per-URL reasons (JS-shell, paywall, timeout) |
| Judge finds nothing relevant | coverage statement, no factual claims |
| Corroboration finds no multi-source clusters | single-source claims reported as such |
| Model timeout mid-loop | partial report, `termination` explains where it stopped |
| Budget exhausted with gaps open | gaps listed explicitly as unverified |

## 7. Testing strategy

- **Pure:** plan parsing, dedupe normalization, token-overlap pre-filter,
  budget enforcement, termination conditions — unit tests, no model.
- **Model stages:** stubbed InferencePool returning canned JSON (deterministic
  fixtures for plan/judge/corrob-orate/synthesis) — full loop golden test:
  fixed DDG fixture → assert clusters, evidence counts, badges, gaps.
- **Honesty:** assert every factual claim in the report has ≥1 evidence
  attachment; assert synthesis framing badges `unverified`; assert a
  contradicting source appears as counter-evidence, never silently dropped.
- **No network in tests.** Live validation is manual (the loop is exercised
  against real DDG during development, never in CI).

## 8. Build phases

1. **Types + planner + budgets.** Single-round, multi-query retrieval with
   a plan. No judge/corroboration yet — proves the planning prompt and the
   polite fan-out.
2. **Judge + claim extraction.** Relevance scoring and atomic claims per
   source; irrelevant sources excluded from the report.
3. **Corroboration + gap loop.** Pre-filter + adjudication, follow-up rounds,
   termination conditions.
4. **Synthesis + honesty wiring + `research.query` tool + SKILL.md.**
   Full module, manifest, capability declaration.
5. **CLI/desktop wiring.** `/research` command, progress rendering,
   sovereignty review (new network behavior: more queries per run — the
   dashboard lists it; still DDG-only, still no new hosts).

## 9. Open questions (need Kimler before build)

1. **Corroboration bar:** is 2 independent hosts enough for "corroborated,"
   or should contested claims require 3?
2. **Contradictions:** attach as counter-evidence (spec default) or hold the
   claim back entirely until resolved?
3. ~~Depth default~~ — **resolved 2026-10-07:** `standard` default;
   paper requests run `deep`.
4. **Planner prompt evolution:** should the planning/judge prompts be
   versioned artifacts the learning loop can refine later? (Recommended:
   yes, but out of scope for v1.)
5. **Academic full text:** abstracts + metadata only (spec default, honest).
   Full-text PDF parsing is a separate future module, not this one.
6. **Visual rendering:** mermaid + generated SVG for charts (spec default) —
   or should paper export also produce a standalone HTML file with embedded
   SVGs for sharing?
7. **Paper trigger:** the word "paper" in the request triggers paper mode
   (spec default), plus an explicit `/research paper: <query>` form — enough,
   or should the agent ask when ambiguous?
