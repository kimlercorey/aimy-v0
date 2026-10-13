# Deep Research — loop spec (v0.1 draft, 2026-10-07)

*Status: APPROVED for build (2026-10-12), as amended by Extension v0.2 appended below. Phase 1 ratified as-built. Where the extension and the v0.1 text conflict, the extension governs.*

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
- **Download (MoSCoW Phase 2 Must):** Markdown is the native download format;
  PDF via Electron `printToPDF` in the desktop (no new dependencies, no
  services). Papers optionally carry the evidence-bundle hash so "verified"
  is checkable when shared — composing with the verified-export machinery
  (MoSCoW Must #16).

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

## 9. Open questions — all resolved 2026-10-12 (see Extension v0.2)

1. **Corroboration bar:** is 2 independent hosts enough for "corroborated,"
   or should contested claims require 3?
   **Resolved:** 2 hosts for ordinary claims; 3 to present a contested claim
   as settled (Extension E6).
2. **Contradictions:** attach as counter-evidence (spec default) or hold the
   claim back entirely until resolved?
   **Resolved:** attach and present both sides; never hold back (E6).
3. ~~Depth default~~ — **resolved 2026-10-07:** `standard` default;
   paper requests run `deep`.
4. **Planner prompt evolution:** should the planning/judge prompts be
   versioned artifacts the learning loop can refine later? (Recommended:
   yes, but out of scope for v1.)
   **Resolved:** yes to versioned prompt constants for every stage;
   learning-loop refinement is out of scope for v1 (E5).
5. **Academic full text:** abstracts + metadata only (spec default, honest).
   Full-text PDF parsing is a separate future module, not this one.
   **Resolved:** retained — abstracts + metadata only, cited as such (E7).
6. **Visual rendering:** mermaid + generated SVG for charts (spec default) —
   or should paper export also produce a standalone HTML file with embedded
   SVGs for sharing?
   **Resolved:** v1 renders visuals through the drawer's markdown pipeline
   (tables + mermaid); standalone HTML export deferred; paper downloads are
   Markdown + PDF (E9).
7. **Paper trigger:** the word "paper" in the request triggers paper mode
   (spec default), plus an explicit `/research paper: <query>` form — enough,
   or should the agent ask when ambiguous?
   **Resolved:** fixed triggers, never ask (E3).

---

## Extension v0.2 (2026-10-12) — approved

Appended 2026-10-12. Kimler accepted the recommended defaults for all nine open decisions (recorded at the end of this extension). The gap analysis and code evidence behind this extension are in the review draft that produced it (Zen's workspace drafts, 2026-10-12). Where this extension and the v0.1 text conflict, this extension governs.

### E1. Status and ratification

This spec is approved for build as amended by this extension. Phase 1 (planner, fan-out, single-round report) is built and tested and is ratified as-built. Where this extension and the v0.1 text conflict, this extension governs. The MoSCoW Phase-2 entry and the Phase I workplan are the product-level authority for *why* this feature exists; this spec governs *how it behaves*.

### E2. Scope

**In scope (the research feature):**

- `research.query` as a model-callable tool in the desktop app and CLI, backed by `core/deep-research/` packaged as a module (SKILL.md manifest, tier T1 like web-retrieval — network egress to declared hosts only).
- The full seven-stage loop of §3, at all three depths, in both output modes.
- Presentation: answer mode in chat; paper mode as a drawer document the user can read, co-edit, save, and download.
- Distillation of durable findings into the shared knowledge store, under E11.

**Out of scope (unchanged non-goals, restated):** paid search APIs; cloud model calls; JS rendering; PDF parsing of sources; replacing `retrieval.query`; general browsing skills beyond this loop; storing raw fetched page content anywhere (excerpts attached as evidence summaries are the ceiling).

### E3. Invocation and user-facing behavior

- **Division of labor.** `retrieval.query` is the quick path: one question, a few sources, an answer now. `research.query` is the investigated path: the question needs decomposition, corroboration, contradiction-seeking, or a document. AImy uses `research.query` when the user asks to research / investigate / compare / evaluate, when a single retrieval pass visibly disagrees with itself, or when the deliverable is a brief or paper. She does not use it for single-fact lookups retrieval can answer.
- **Paper trigger.** Paper mode runs when the user asks for a paper, brief, report, or document — or passes `output: "paper"` / uses `/research paper: <query>`. "Research X, draft a brief" is paper mode (Phase I workplan language). AImy does not ask a clarifying question about mode; absent document language, she runs an answer-mode run at the requested or default depth.
- **Depth selection.** Default `standard`. `quick` when the user signals speed or the question is narrow. `deep` for paper mode (forced, per §1) and when the user asks for depth/thoroughness. Depth is stated in the report header, never hidden.
- **Honest start.** When a run starts, AImy says what is running, at what depth, and roughly what it costs ("standard research: up to 8 searches, ~10 sources"). She never describes findings before the run produces them.

### E4. Execution model and progress

- **Inline:** `quick` and `standard` answer-mode runs execute inline as one tool call.
- **Background:** `deep` runs and all paper-mode runs execute as a background job (`job.spawn` with tool `research.query`), returning a job ID immediately. The chat stays live; the completed report is delivered as the job result and, for paper mode, opened in the drawer (E8). This is the same pattern the KNOWLEDGE PROTOCOL already prescribes for deep research.
- **Progress substrate:** every stage transition emits a structured log line — `[research] stage=<plan|search|read|judge|corroborate|gap|synthesize> round=<n> <counters>` (e.g. `stage=search round=1 queries=3/8`) — plus start/finish lines carrying depth, termination reason, and counts. Job status surfaces these stages to the user. No stage may run unlogged: if it isn't in the log, it didn't happen, and a failure the user can't see is treated as a defect, per the platform's standing logging rule.
- **Contention:** one research run at a time per session. A second invocation while one is active returns the active run's identity instead of starting a parallel run against the single local inference endpoint.

### E5. Data contract (reconciled report shape)

`DeepResearchReport` is the union of the spec §4 shape and the built Phase-1 fields; the Phase-1 fields are retained so existing tests and the honesty read-back stay valid:

```ts
interface DeepResearchReport {
  readonly query: string
  readonly depth: ResearchDepth
  readonly output: ResearchOutput
  readonly plan: ResearchPlan            // as built; fromModel states fallback honestly
  readonly answer: string                // rendered, badge-labeled
  readonly claims: ReadonlyArray<ClaimWithBadge>   // read back from HonestyService
  readonly clusters: ReadonlyArray<ClaimCluster>   // empty in Phase 1
  readonly gaps: ReadonlyArray<string>             // "could not verify: …" entries
  readonly visuals: ReadonlyArray<Visual>          // paper mode; empty otherwise
  readonly sourcesSearched: number
  readonly sourcesRead: number
  readonly termination: "answered" | "no-gaps" | "budget-exhausted"
}
interface ClaimCluster {
  readonly representative: string
  readonly claimId: string               // the HonestyService claim recorded for this cluster
  readonly supporting: ReadonlyArray<string>       // urls, ≥2 distinct hosts = corroborated
  readonly contradicting: ReadonlyArray<string>    // urls; never silently dropped
}
```

Model stages program against one interface, generalizing the built `PlanModel`:

```ts
interface ResearchModel {
  readonly generateText: (system: string, user: string) => Effect.Effect<string, PlanError>
}
```

Each stage's prompt is a versioned constant (`planner/v1` exists; `judge/v1`, `corroborate/v1`, `gap/v1`, `synthesis/v1` land with their stages), and each stage's malformed-output behavior follows the planner's precedent: typed error, logged, honest degradation — never a silent guess. Judge parse failure for a source → that source is excluded and counted in coverage. Corroboration adjudication failure for a pair → the pair is `unrelated` and the failure is counted in coverage. Gap-analysis failure → the loop terminates as if no gaps, with the failure stated in coverage. Synthesis failure → the report falls back to the cluster list rendered mechanically (representative + badge + source counts), labeled as un-synthesized.

### E6. Corroboration and counter-evidence (honesty wiring, amended)

- **Corroboration bar:** ≥2 supporting URLs from different hosts = corroborated (spec default retained). A claim whose sub-question intent is `counterpoint`, or which the gap stage flags as contested, requires ≥3 distinct hosts to be presented as settled; below that it is presented as disputed/single-source with the counts shown. (Resolves §9.1 — see decision list E-list item 1.)
- **Contradictions are attached, never held back and never dropped** (spec default retained, §9.2): the synthesis must present both sides in the Disputes section (paper) or inline (answer).
- **Counter-evidence mechanism:** contradicting URLs are attached to the cluster's claim as evidence with kind `"source"` and a summary beginning `CONTRADICTS: `. Because badge derivation counts any evidence toward `verified`, the *report layer* — not the badge — carries dispute state: a claim with ≥1 contradicting attachment renders as `verified · N sources · disputed by M` (answer mode: `[verified · disputed] …`). The badge stays the honesty layer's; the dispute marker is derived from the cluster + evidence summaries, both of which are ledger data, not model prose. If a future honesty revision adds a native `counter-source` evidence kind or a `disputed` status, this mechanism migrates to it; the charter does not silently amend the honesty contract, which `core/honesty/src/types.ts` declares fixed.
- **Single-source claims** are always labeled with their count ("single source"). **Zero-source content** (framing, coverage, synthesis connective text) is recorded with no evidence and badges `unverified`, as in web-retrieval today.

### E7. Source standards

- **Preference order:** primary sources (filings, papers, official docs, vendor documentation) > reputable secondary reporting > community content. The planner's intent mix (§3.1) is the enforcement point; the judge's relevance score must not promote a secondary source above an available primary one on the same claim.
- **Independence means different hosts *and* different origin.** Two URLs on one host never corroborate. Syndicated copies of one wire story on different hosts count once — the corroborator's adjudication prompt instructs it to treat near-identical text as one origin (the token-overlap pre-filter already surfaces these pairs).
- **Dates:** when a fetched page plainly carries a publication date in its extracted text, the judge records it with the source; when it doesn't, the source is undated and the report shows no date — dates are never inferred or invented. Recency reasoning in synthesis may only use recorded dates.
- **Excerpts:** every claim's evidence summary is a verbatim excerpt of the fetched text (≤400 chars, as built). The judge may not paraphrase into an evidence summary.
- **Academic sources:** abstracts + metadata only (§9.5 spec default retained). A paper whose full text wasn't read is cited as abstract-only in the Sources section.

### E8. Deliverables and the drawer contract

- **Answer mode** returns the tool result to chat: the synthesized answer with badge/dispute markers inline, followed by the coverage statement and the explicit gap list. Nothing is auto-saved.
- **Paper mode** produces one markdown document, opened via `drawer.preview` in a space titled with the research question, bound to path `planning/research-<slug>.md` (slug from the question). The user can co-edit it in the drawer, save it with the existing save flow, and download it (Markdown natively; PDF via the desktop's existing print path is the MoSCoW Phase-2 Must and lands with the download work, not as a research-loop dependency).
- **Paper structure** (§3.7 retained, header added):
  1. Header block: question, date, depth, model-plan or fallback, termination reason, coverage counts (searched / read / corroborated / disputed / unverified).
  2. Visual summary (E9).
  3. Summary → Findings (per cluster, badge + source counts inline) → Comparison (competitive questions) → Disputes (both sides, always present if any contradicting source exists) → Gaps ("could not verify: …") → Sources (URL, title, date if recorded, abstract-only flag where applicable).
- **Iteration:** follow-up requests ("expand section 3") edit the open document via the existing drawer edit path; a *new* research run on a changed question starts a new document. Research never silently overwrites a document the user has edited — a re-run on the same question creates the new version through the drawer's normal version history.
- **Chat narration** around a paper is a pointer ("the brief is in the drawer"), not a second copy of the findings — the platform's no-repetition rule applies.

### E9. Visuals (v1 rendering constraint)

The §3.8 `Visual` spec stands, with one v1 constraint: visuals are rendered **through the drawer's markdown pipeline**, because that is the surface that exists.

- comparison-matrix → markdown table (default for competitive papers); each cell's claim binding is expressed as a source key in the cell or its row caption.
- diagram → mermaid block (§3.8 unchanged; mermaid in papers is subject to the platform's mermaid validation, and a paper whose diagram fails validation is not finished).
- timeline → markdown table (date | event | source key).
- bar-chart → deferred as a rendered chart in v1; the spec's data is presented as a table with the same claim bindings. The `Visual` type keeps `bar-chart` so the renderer can grow into it without a contract change. (Supersedes §9.6's SVG assumption for v1; standalone-HTML export is deferred with it — decision item 4.)
- Every visual keeps its source-basis caption ("3 sources", "single source", "disputed — see Disputes").

### E10. Privacy and sovereignty

- Research egress is exactly web-retrieval's: the DuckDuckGo HTML host for search, and https fetches only to hosts returned by the current run's searches. The deep-research SKILL.md declares the same vendor host and fetch policy; no new hosts, no paid APIs, no cloud models (§1 non-goals).
- Search queries are derived from the user's research question and the planner's decomposition of it. **Local content is never searched:** no text from the user's documents, files, journal, or knowledge cards may be placed in a search query unless the user explicitly asks for that text to be researched. (Adopted from knowledge-and-validation-design.md §4.3.)
- The run's full query set (user question + every generated sub-question actually searched) is listed in the report's coverage/header data — the user can always see exactly what was asked of the outside world on their behalf.
- Fetched page text is processed locally and not retained beyond the run, except: evidence excerpts (≤400 chars) in the honesty ledger, and what the user saves in the deliverable document.

### E11. Relationship to the knowledge store

- A research **report/paper is a document**, saved (if at all) under `planning/` — it is not a knowledge card.
- When a run produces durable, reusable reference knowledge (a format's rules, a product's stable facts, a method), AImy may distill it into a knowledge card with `knowledge.write`, with the run's source URLs as the card's provenance. Raw report text is never pasted into a card (knowledge design §4.3 distillation rule).
- Research runs do not write track-record events; the track record remains the validator/competence ledger it was designed as. A paper that later proves wrong is corrected in the document and, if a card was distilled from it, in the card — the correction path is the document history, not a new ledger.

### E12. Failure behavior and acceptance criteria

Failure behavior is §6's table, plus: background-job failure delivers a partial report or an explicit failure notice to chat — a research job never dies silently; a paper-mode run that fails before synthesis still opens whatever partial document exists, labeled partial, rather than leaving the drawer empty.

**Acceptance criteria** (the feature is done when all hold):

1. **Module reality:** `core/deep-research/SKILL.md` exists, declares tool `research.query`, tier T1, and exactly the egress of E10; a manifest test (modeled on web-retrieval's) proves the manifest parses and declares the egress the code uses. AImy can call `research.query` in the desktop app; the tool appears in her tool list with the E3 division-of-labor description.
2. **Golden loop:** the §7 golden test passes with clusters, gaps, and termination reasons asserted: fixed DDG fixture → judge extracts claims → corroboration marks a 2-host claim corroborated, a 1-host claim single-source, and a contradicted claim disputed with the contradicting source attached and rendered.
3. **Honesty invariants (automated):** every factual claim in a report has ≥1 evidence attachment or is explicitly a coverage/framing claim badged `unverified`; no claim's rendered support count exceeds its attached supporting evidence; every contradicting URL in the fixture appears in the output's Disputes section or inline dispute marker.
4. **Budgets and termination:** a run against an over-budget fixture stops at the depth's caps, states `budget-exhausted`, and lists open gaps as unverified; a stage timeout produces a partial report naming the stage, per E5/C6 timeouts (90 s per stage, 6 min total at deep).
5. **Fallbacks:** planner failure degrades to the Phase-1 fallback and the report says so (existing Phase-1 tests keep passing); judge/corroborate/gap/synthesis malformed-output fixtures degrade per E5 and say so in coverage.
6. **Field test — competitive paper:** "Research <a real competitive question>, draft a brief" produces, within the deep budget, a drawer document matching E8's structure: header with true counts, a comparison matrix whose cells trace to claims, a Disputes section if the sources disagreed, an explicit Gaps list, and Sources with dates where recorded. Kimler can edit the document in the drawer, save it to `planning/research-<slug>.md`, and download the Markdown.
7. **Field test — answer mode:** a standard-depth research question returns a chat answer with badge/dispute markers, coverage, and gaps, and no document is created or saved.
8. **Field test — honest emptiness:** a question with no findable sources returns "no sources found" with zero factual claims, in both modes (paper mode opens a document whose content is the honest empty report).
9. **Progress:** during a deep/paper run, the log shows every stage transition with counters (E4), and the user-visible job status names the current stage; the run's searched queries are fully listed in the deliverable (E10).
10. **No regressions:** web-retrieval behavior and its tests unchanged; Phase-1 deep-research tests unchanged and passing; the knowledge protocol (§4.3) flow still works — a format-class task still researches via `retrieval.query` and distills a card, undisturbed by the new tool.

### Build order (spec §8, updated for current state)

1. **Wiring first (small):** SKILL.md + `tools.ts` (tool def, hooks, arg validation mirroring web-retrieval's) + the InferencePool→`ResearchModel` adapter + agent-tool adapter + desktop/CLI wiring, exposing the *existing Phase-1 flow* as `research.query`. This makes the feature reachable and testable end-to-end before the loop deepens. (Spec Phase 4's wiring, pulled forward — the drawer and module seam exist now in ways they didn't when §8 was written.)
2. **Judge + claim extraction** (spec Phase 2), with E5 fallbacks and E7 source standards.
3. **Corroboration + gap loop** (spec Phase 3), with E6 counter-evidence rendering.
4. **Synthesis + paper mode + drawer delivery** (spec Phase 4 remainder), visuals per E9.
5. **Sovereignty review + field tests** (spec Phase 5 + E12 items 6–9).

### Decisions record (2026-10-12)

Kimler accepted the recommended defaults for all nine open decisions:

1. **Corroboration bar** — 2 hosts for ordinary claims; 3 to present a contested claim as settled (E6).
2. **Contradiction handling** — attach and present both sides; never hold back (E6).
3. **Counter-evidence mechanism** — report-layer rendering over `source` evidence marked `CONTRADICTS: `; the honesty contract is not amended in v1 (E6).
4. **Paper export formats** — Markdown + PDF ship with the feature; standalone HTML deferred (E9).
5. **Paper trigger** — fixed triggers (document words / explicit arg / `/research paper:`), never ask (E3).
6. **Execution model** — inline for quick/standard answer mode; background job for deep and paper mode (E4).
7. **Academic full text** — abstracts + metadata only, cited as abstract-only (E7).
8. **Prompt versioning** — versioned stage-prompt constants; no learning-loop refinement in v1 (E5).
9. **Phase 1** — ratified as-built (E1).

---

## Extension v0.3 (2026-10-12) — Projects, scale, scheduling, visibility

Added on Kimler's directions of 2026-10-12: research and papers happen under **Projects** (planning/projects-design.md); projects and documents may be far larger than one context window; research may run in sections alongside normal chat, with scheduling implications; and the requestor must be able to see when a run started, how long it has been going, its current progress, an ongoing completion estimate, and what the deliverable will be. Where this extension and earlier text conflict, this extension governs.

### E13. Project binding

Every research run belongs to exactly one project: the active declared project at run start, else Default (projects are user-declared; Default always exists — see projects-design.md). The binding is recorded on the run and never changes mid-run. The deliverable registers as a project asset (`role: "deliverable"`; the run itself as `kind: "research-run"`). E8's deliverable path stands (`planning/research-<slug>.md`); binding is by record, not folder, so re-binding never moves files.

### E14. Context-scale execution

Run state lives on disk in the project's run directory (`~/.aimy/projects/<projectId>/research/<runId>/`): `run.json` (the progress record, E16), `plan.json`, `sources/<n>.json` (per-source extraction, as read), `claims.json` (ledger claim ids + badges snapshot), `clusters.json`. Stages read and write these incrementally — the reader extracts claims per source, chunking long sources; corroboration works pairwise over claims; synthesis runs **per deliverable section** over only that section's clusters. No prompt ever contains the corpus. A run's size is bounded by disk and budget, not by the context window.

### E15. Sectioned execution and scheduling

The unit of work is a *section* (one stage-step: a search batch, a source read, a corroboration pass, one paper section). A run executes section by section, persisting progress after each, so it can pause, resume after restart, and interleave with normal chat — chat always wins the conversation; research continues between turns. Deep and paper runs execute on the agent-loop background registry (desktop); quick/standard answer runs may execute inline but still write the run record. A run may carry a schedule (`startAt`); the host starts it when due. Slicing is inherent, not a mode. One active run per project (E4's contention rule, refined per project). **Stated platform limit:** the inference pool has no priority or concurrency mechanism today; coexistence works because sections are short and the single local endpoint serializes requests. Pool-level foreground priority is future work (already a MoSCoW Should).

### E16. Requestor visibility

`run.json` is the requestor's record, updated after every section: `{ runId, projectId, query, mode, depth, status, startedAt, updatedAt, stage, counters {searches, fetches, claims, clusters, rounds}, budget, deliverable {title, path, structure}, etaMs, schedule }`. Elapsed derives from the timestamps. **ETA semantics:** `etaMs` is an estimate computed from budget consumption (sections completed vs remaining, weighted by stage) once at least one round has completed; before that it is `null` and surfaces say "estimating…" — an estimate is always labeled an estimate, never a promise. The deliverable spec (title, path, and for papers the section structure) is fixed at run start from E8, so the requestor knows what will exist before it exists. Paper sections are appended to the deliverable document as they complete; the document is readable mid-run and labeled partial until synthesis finishes.

### E17. Wiring corrections (survey-proven, 2026-10-12)

(a) `job.spawn` currently resolves only builtin tools and cannot spawn module tools — although its own description advertises `retrieval.query`. Fixing it to resolve `extraTools` is part of the wiring step, since E4/E15 execution rides it. (b) `DeepResearchReport` grows: `runId`, `projectId`, `startedAt`, `finishedAt?`, `deliverable?`, plus the E5 fields (`clusters`, `gaps`, `visuals`, `"no-gaps"`). (c) The CLI gains a background registry (the chat stack already accepts one; the CLI doesn't pass it) so `/research` behaves like desktop. (d) The chat stack's module-host hook registration is retrieval-specific and must be generalized for research hooks to fire.

### Build order (v0.3 — supersedes v0.2's where they differ)

1. **Projects store + tools + prompt injection** (projects-design.md build order step 1).
2. **Research wiring**: SKILL.md, module tools, chat adapter (PlanModel over InferencePool), engine + CLI extraTools, the E17 fixes — the Phase-1 flow callable as `research.query`, project-bound, writing run records.
3. **Judge + claim extraction** (per-source, on-disk), **corroboration + gap loop** (sectioned), dispute rendering per E6.
4. **Synthesis + paper sections + deliverable assembly** into the project, readable as it fills.
5. **Visibility surface**: drawer-home project section + running-research progress (elapsed, counters, ETA, deliverable); `startAt` scheduling.
6. **Acceptance**: E12 criteria + project-binding checks (a run lands in the declared project; Default catches undeclared work; artifacts attribute correctly when one chat serves two projects).

