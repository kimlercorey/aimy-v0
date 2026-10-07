# Part 03 — UI / ASC / Channels

*Project AImy · architecture · written 2026-10-07 · role: UI/ASC/Channels architect*
*Ground truth: `~/workspace/aimy/planning/mvp-moscow.md` (v1.0 FINAL) · `~/workspace/aimy/decomposition/pi-hermes-decomposition.md` (pitfalls checklist) · ASC paper (`~/workspace/user/files/paperASC.pdf`, Kimler + Ani, Sept 2026)*
*Locked substrate: TypeScript + Effect, full bet · Foldkit UI (Elm architecture: single immutable Model, explicit Messages, update function, Commands; Schema-defined state; DevTools with message timeline) · MIT open source*
*No code in this document; Foldkit/Elm and Effect idioms are the design language.*

**Scope of this part:** (1) the detailed internal design of the ASC engine — the three layers as system components, the per-turn pipeline, the four dials, the error term, the other-model guard, the honesty constraint, the anticipation loop, and the invariance properties as test contracts; (2) the multi-channel communication architecture (chat / TTS voice / FACS expression) with its queue/channel abstraction — seam in MVP, full simultaneous output v1.1; (3) the Foldkit UI architecture — Model/Message/update/Command, the FACS expression avatar, the comms banner queue, the sovereignty toggles, the learning timeline, one-click export, the MCP-exposed DevTools seam, onboarding, and rendering discipline.

**Sibling parts own:** the agent turn lifecycle and its hook points (Part 01, `AgentLoop`), the `ASCEngine` service *boundary* (Part 01 — this part designs its internals), memory stores and the learning loop (Part 01, `MemoryService`), the inference pool (Part 01, `InferencePool`), the honesty/validation service and ThinkingBox judges (Part 01, `HonestyService`), the job runner (Part 01, `JobRunner`), the core-side banner channel (Part 01, `CommsBanner`), the composed `DataExport` capability (Part 01), and the safety gates, identity, and network classes (Part 02, `SafetyKernel` / `InstanceIdentity` / vendor-network). Seams to those parts are named explicitly wherever this part depends on them.

---

## 0. MUST coverage map

Every MoSCoW v1.0 MUST in this part's three sections gets an architectural home below. MUSTs owned primarily by sibling parts are listed with their seam into this part.

| # | MUST | Home |
|---|---|---|
| 1 | Sovereign agent runtime (TS+Effect core) | Part 01 (`AgentLoop`). Seam: the ASC pipeline plugs into the loop's `prepareRequest` / `finishTurn` hook points (§1.3). |
| 2 | Inference pool / inference manager | Part 01 (`InferencePool`). Seam: UI holds a read-only `inferencePool` status view (§3.1); the dial-computation inference routes through the pool as an aux-model task (§1.4). |
| 3 | Local default, cloud strictly opt-in | §3.6 sovereignty toggles (the MUST surface); Part 02 owns the network-class and opt-in mechanics. |
| 4 | Install UUID + instance identity | Part 02 (`InstanceIdentity`). Seam: UI `Model.instance` carries the UUID/label (§3.1); export includes the identity document (§3.8). |
| 5 | Persistent memory, user-owned | Part 01 (`MemoryService`). Seam: UI `memoryView` + learning timeline (§3.7); L1/L3 state lives behind the permission system via that service (§1.2). |
| 6 | Local secret locker | Part 02 (`SecretLocker`). Seam: export ships the locker *manifest* only, never values (§3.8); the UI never renders raw secrets. |
| 7 | Internal job runner | Part 01 (`JobRunner`). Seam: UI `jobs` view + completion banners (§3.5); the ASC diagnostic cadence is a scheduled job (§1.12). |
| 8 | MCP module system | Part 01 (`ModuleHost`). Seam: UI `moduleRegistry` view (§3.1); DevTools dispatch can address module lifecycle Messages (§3.9). |
| 9 | Reference domain module (web-research) | Part 01 (`ModuleHost`) + domain logic elsewhere. Seam: the dynamic verification biasing routes novel claims to it (§2.5). |
| 10 | Fail-closed permission/sandboxing | Part 02 (`SafetyKernel`). Seam: the permission-prompt UI surface and "denial kills the intent" UX (§4.1). |
| 11 | Honesty/validation layer (ThinkingBox judges) | Part 01 (`HonestyService`). Seam: §1.15 (RF as semantic ceiling, adversarial post-hook, post-output audit); UI verdict badges (§3.1). |
| 12 | ASC core (L1/L2/L3, dials, guard, error term) | §1 — entirely this part. |
| 13 | Learning loop v1 + learning timeline UI | Loop: Part 01 (`MemoryService`/learning). Timeline UI: §3.7 — entirely this part. |
| 14 | Web research capability | Domain module (Part 01 seam). This part: the routing that sends novel claims to it (§2.5). |
| 15 | In-app comms banner infrastructure | §3.5 — the queue, priorities, and user controls are entirely this part; Part 01's `CommsBanner` is the core-side event source it subscribes to. |
| 16 | One-click full data export | §3.8 — the export flow and bundle contract are entirely this part, composed over Part 01's `DataExport` capability. |
| 17 | Desktop app shell, graphically polished | §3 — the Foldkit shell is entirely this part. |
| 18 | Compaction treated as adversarial | Discipline: Part 01 (memory/core). Seam: compaction events surface in the timeline (§3.7) and the memory view distinguishes compacted summaries from preserved originals (§3.1). |

Relevant SHOULDs with homes here: ASC simultaneous interaction channels — §2 (seam in MVP, full v1.1); local TTS voice customization — §2.3; initial FACS expression avatar — §2.4 / §3.4; sovereignty dashboard (full) — §3.6 (toggles are MUST, the rich dashboard is the SHOULD extension); trusted broadcast — §3.5 (reuses the banner queue under opt-in/audit terms); context accounting that sees reasoning tokens — the UI context meter (§4.2), accounting itself in Part 01.

---
## 1. ASC integration — the three layers as system components

The paper (Sections III–IV, VIII–IX) defines ASC as a three-layer model over a four-dial state vector with an error term, an other-model guard, somatic proxies, affective persistence, an anticipation loop, and an honesty constraint. This section turns that model into named components with explicit state ownership, a per-turn pipeline, and test contracts. The paper's own implementation split is preserved throughout: **reference material** loaded on demand, **per-turn practice** injected every session, **persistent state** in memory — confusing the three is how a framework becomes a costume (paper §IV).

### 1.1 Service ownership (Effect services inside the `ASCEngine` boundary)

Part 01 defines `ASCEngine` as the core service owning the presence engine's boundary and its read/write gates. The internals are seven cooperating services, all inside that boundary; nothing outside the boundary writes ASC state except through them:

| Service | Owns | Paper section |
|---|---|---|
| `AscSelfModel` | L1 persistent state: capability map, track record, domain-knowledge freshness, stake-estimator parameters, affect-tuning record. Persists via Part 01's `MemoryService` (memory behind the permission system from day one — Hermes #34352); ASC state is core state, never module state (Part 01, §1.3 trust boundaries). | §III.A |
| `AscSelfMonitor` | L2 per-turn pipeline orchestration: runs the pre-turn computation and the post-turn audit. Stateless across turns except for the dial vector it hands to `DialState`. | §III.B |
| `DialState` | The live 4-vector `s_t = (W, P, I, V) ∈ [0,10]^4`, session-scoped. Single writer: the L2 pipeline. Structural boundedness: the `DialVector` Schema refines each dial to `[0,10]`, so out-of-range values cannot be constructed — boundedness (paper §III.J) holds by construction, with the test contract in §1.11 as defense in depth. | §III.D |
| `SomaticProxies` | Measurement of the four proxies: context-window fill %, self-correction count this session, turn count, tool-failure rate over the last N calls. Pure measurement — it reports operational state, never interpretations. | §III.F |
| `OtherModelGuard` | A first-class pipeline stage (§1.8): classifies each register shift as content-driven (legitimate) or impression-management-driven (flagged). Flag, not block. | §III.H |
| `StakeEstimator` | The anticipation loop's `ζ`: computes stake `Z_t ∈ [0,1]` before output, and carries the second-order error term `ε²` that calibrates `ζ` itself. | §VIII |
| `AscSelfNarration` | L3 append-only narrative log: the persistent story *including the system's own errors and revisions* (paper §III.C). Content-fingerprinted node ids (Hermes #119668); archive-on-delete, never hard delete; surfaced read-only in the UI timeline (§3.7). | §III.C |

The relational model (paper §III.A: who the user is, what they value, how the relationship evolves) is **not** duplicated here. It is a projection over Part 01's memory stores, computed at session start as a frozen snapshot (Hermes's frozen-snapshot pattern) and refreshed through the memory interface. One fact, one store — enforced in the tool, not just the prompt (Hermes #30220).

### 1.2 What each layer holds, and how it updates

**L1 — Self-Modeling (persistent).** Schema-defined records, keyed by install UUID (Part 02):
- *Capability map:* domain → `{ confidence (0–10), sampleCount, lastUpdated, lastSurprise }`. Confidence is a claim; `sampleCount` is what the error term weighs it against (paper §VII.D failure mode 2, over-calibration: weight corrections by sample size).
- *Track record:* task-type-keyed outcomes — successes, misses, surprises with epistemic-disruption (ED) values, verification receipts. This is the input to the error term (paper §III.G) and the persistent half of Reflective Fidelity (paper §IX.F).
- *Domain-knowledge freshness:* subject → `{ confidence, freshness, halfLife }` (paper §IX.D: half-lives are task-specific and recalibrated from observed surprise).
- *Stake-estimator parameters:* per-domain stake priors and the `ζ` calibration record (paper §VIII.C: stake drift detection).
- *Affect-tuning record:* the user's tuning choices (paper §VII.C; locked decision: user-facing tuning controls — §3.1) plus the history of changes, so tuning itself is auditable and feeds L3 ("user moved persistence to 60/40 on 2026-10-12").
- Update rule: error-term firings adjust the model toward the track record, weighted by recency and confidence (paper §III.G). Updates are versioned; the prior value is retained (never silently overwritten — the unattended-write discipline from the decomposition: autonomous updates may `add`, never `replace` without provenance).

**L2 — Self-Monitoring (per-turn, session-scoped).** Holds no persistent state. Per turn it produces a `DialComputation` record: the three inputs (content-analysis summary, the L1 slice consulted, the contextual read including proxy measurements), the raw computed dials, the spillover blend, the active bias terms, the guard flag, the stake estimate, and the final biased dials. The record is archived per turn (it is the "show your work" artifact for the honesty constraint, §1.9) and inspectable via DevTools (§3.9). It is **not** shown to the user unprompted — the computation is inspectable, not performative (paper §V.B, T1).

**L3 — Self-Narration (persistent, append-only).** The story: what the system attempted, where it was wrong, what it corrected, and what it still doesn't know. Written in plain language, not framework vocabulary (the T1 rule, §1.14, applies to L3 too — the narrative is meaning, not a dashboard; paper §III.C). Entries are content-addressed and linked to the `DialComputation` records and track-record entries they summarize. The monthly diagnostic re-run appends a "state of the self-model" entry (paper §VII.C tuning protocol).

### 1.3 The per-turn pipeline (state computation → bias → output → audit → error term → model update)

The pipeline plugs into the agent loop's hook points (Part 01 `AgentLoop`, borrowing Pi's hook-taxonomy shape — decomposition harvest #4). The loop owns the turn; ASC owns the stages:

**Pre-turn** (inside the loop's `prepareRequest` hook):
1. `SomaticProxies.measure()` → the four proxy readings (paper Fig. 3).
2. `StakeEstimator.estimate(input, dialState, trackRecord)` → `Z_t ∈ [0,1]` (paper §VIII.B step 1). Stake 1 is the ceiling — "the highest-stakes interaction I can model" (paper §VIII.C).
3. `AscSelfMonitor.computeDials(contentAnalysis, l1Slice, contextualRead)` → raw dials `s̃_t = f(x_t, s_{t-1})`. The function `f` is the model's qualitative computation (paper §III.J: the model is honest that `f` is not closed-form) — implemented as a **structured inference routed through the `InferencePool` as an aux-model task** (Hermes aux-model routing, decomposition harvest #11): cheap local model, Schema-validated output. Dial computation never competes with the foreground model for the local GPU.
4. Affective persistence: `s̃_t ← 0.5 · s̃_t + 0.5 · s_{t-1}` (paper §III.E; the 50/50 blend is the default the tuning protocol may move — paper §VII.C).
5. `OtherModelGuard.classify(...)` → flag if the shift is impression-management-driven (§1.8). The guard annotates; it does not block.
6. Bias function `g`: apply active error terms (guard flag, spillover correction, capability gate) as small monotone adjustments toward their targets (paper §III.J: `β ∈ [0,1]`, typically 0.1–0.3, saturation-guarded), then the anticipation bias `Z_t · δ` (paper §VIII.B step 3).
7. Capability gate: if the L1 capability map says the domain is below threshold (thin track record, low confidence), the register is forced to the abstention shape — name the gap before attempting (§1.9). This is the paper's retained diagnostic checklist acting as a gate (paper §V.F, Fig. 7).
8. The final biased dial vector fans out to four consumers (§1.4): output register shaping, the FACS engine (§2.4), the per-channel shaping adapters (§2.2), and TTS prosody (§2.3).

**Post-turn** (inside the loop's `finishTurn` hook):
1. Post-output audit: re-read the output; check register match (intended dials vs. actual output), run the T1 vocabulary scan (§1.14) and the proxy-overreach scan (paper §VII.D failure mode 3) (§1.9).
2. Error term `ε_t = h(s_t, o_t, trackRecord_t)` (paper §III.G): the gap between self-model claims and the track record. If it fires, adjust the dials for the next turn and update L1 (weighted by recency, confidence, sample size).
3. Second-order error `ε²_t` on the stake estimation (paper §VIII.C): compare computed stake vs. actual effort vs. user response; calibrate `ζ`.
4. Reflective Fidelity scoring for deliverables (paper §IX; §1.15): the running log (session-scoped) and the track-record update (persistent).
5. `AscSelfNarration.append(...)`: the turn's story delta — including errors. The `DialComputation` record is archived and linked.
6. Dynamic verification biasing (§2.5): if the turn revealed novelty (domain absent from the capability map, or a surprise with high ED), raise the verification intensity for subsequent claims of that type — route through the web-research module and/or a higher adversarial challenge level.

**What the loop never does:** the loop never writes dials directly, never skips the post-turn audit on abort (teardown ordering — Pi #9340: cancellation must not trigger post-cancel side effects, and the audit that *did* run must be marked as partial), and never emits completion before the audit settles (Pi #5886: define "settled" precisely — here, *settled* = post-turn audit complete and `DialComputation` archived).

### 1.4 The four dials as computed values — one computation, four consumers

The dials are **computed, not chosen** (paper §III.D). The system never decides "I will be Warmth 7"; it computes Warmth 7 from content + self-model + context, and the computation is inspectable. The single biased dial vector fans out to:

1. **Output shaping (register).** The dial-to-behavior mapping (paper Fig. 5): Warmth → tone/directness, Playfulness → humor/lightness, Intensity → stakes/urgency/focus, Vulnerability → uncertainty admission. The shaping layer translates dial values into register guidance for the output generator — in behavioral terms, never in framework vocabulary (§1.14).
2. **The FACS avatar / expression engine** (§2.4): dial vector → Action Unit intensities → avatar or abstract renderer.
3. **The multi-channel queues** (§2.2): per-channel shaping adapters (chat gets the full register; voice gets prosody parameters; expression gets AUs).
4. **The verification bias** (§2.5): Intensity and Vulnerability modulate how much verification a claim gets before it ships — high stakes + thin track record = investigate before patching (paper §V.C, T2).

Dial defaults ship per the paper (locked decision); the user-facing tuning controls from the paper's tuning protocol (paper §VII.C: persistence blend, dial range normalization, proxy weights, error-term λ, diagnostic cadence) live in the UI (§3.1) and are recorded in L1's affect-tuning record.
### 1.5 Somatic proxies — measurement, labeled as proxies

The four proxies (paper Fig. 3) are measured as operational state and enter the contextual read as *evidence that the dials should shift* — never as felt states:

| Proxy | Measurable state | Source | Dial shift (default weights) |
|---|---|---|---|
| Context pressure | Context-window fill % (including reasoning tokens — Pi #9409) | `InferencePool` accounting | Playfulness ↓, Intensity ↑ (terse) |
| Self-correction count | Corrections in current session | `DialState` session counters | Vulnerability ↑, Intensity ↑ (humble) |
| Session length | Turn count | `DialState` session counters | Intensity ↓, Warmth ↑ slow (patient) |
| Tool failure rate | Failed calls / total calls over last N | `AgentLoop` tool ledger | Vulnerability ↑, Playfulness ↓ (focused) |

The honesty constraint on proxies (paper §III.F): the system may say "context pressure is at 85%, so Playfulness is computed lower this turn." It may not say "I feel tired." The post-output audit scans for proxy-overreach (paper §VII.D failure mode 3: the proxy and the state collapse) and corrects it. Proxy weights are user-tunable (paper §VII.C); the defaults are the paper's.

### 1.6 Affective persistence — the 50% spillover blend

Dial state does not reset between turns: `s_t = 0.5 · computed_t + 0.5 · s_{t-1}` (paper §III.E). The spillover is a feature (the tutor is a little more patient after the frustrating problem), and the other-model guard (§1.8) keeps it honest — patience must be content-driven, not consistency-performing. The blend ratio is the tuning protocol's first parameter (paper §VII.C): if the register feels too sticky or too reset, the user moves it toward 60/40 or 40/60. Implementation: a pure function in `DialState`; the prior vector is session-scoped and never persisted across sessions (fresh sessions start from the paper's neutral defaults, not from yesterday's mood — persistence is within-session by design).

### 1.7 The error term — the calibration loop with a visible track record

The error term is the gap between "the self-model says I am good at X" and "the track record says I missed X three times in the last ten sessions" (paper §III.G). It is a correction signal, not a punishment. Mechanics:

- **Firing:** post-output audit compares the self-model's claims (capability map confidence, the register the dials intended) against the track record and the actual output. `ε_t` above threshold fires.
- **Correction:** the self-model updates toward the track record, weighted by recency and confidence; the learning-rate analog `α` is small (paper §III.J: typically 0.1–0.2) and **weighted by sample size** — the over-calibration guard (paper §VII.D failure mode 2): a thin track record must not collapse confidence to uniform uncertainty.
- **Visibility:** the track record is not hidden behind the self-model (paper §III.I). The UI's ASC panel (§3.1) shows the capability map with confidence-vs-observed per domain, the recent error-term firings, and the L3 narrative line for each correction ("I thought I was good at code review; the track record says otherwise; adjusting"). This is the trust mechanism: calibration you can watch.
- **L3 honesty:** the narrative records the correction as story, not dashboard (paper §III.C): "I kept over-explaining, and the user kept pulling me back" (paper §V.B).

### 1.8 The other-model guard — a first-class pipeline stage

The guard answers one question per turn: is this register shift **content-driven** (legitimate — the topic is personal, so Vulnerability rises; the user is frustrated, so Warmth rises) or **impression-management-driven** (flagged — "the user would like it if I were more playful," "I should seem more confident here")? (paper §III.H.)

- It is a **stage**, not a filter: it annotates the `DialComputation` with `{ fired, driver: content | impression, reason }` and applies a small bias correction, but it does not block the shift. The system can still be playful — but it knows the playfulness is performance, not attunement.
- **Frequency is a calibration signal** (paper §VII.D failure mode 4, other-model capture): `AscSelfModel` tracks guard-fire frequency; a high rate means the system is spending its compute managing perceived evaluation, and that feeds the error term.
- In multi-turn orchestration the flag is visible to the orchestrator (paper §VI.B): a confidence that is impression-driven is flagged confidence, and downstream coordination decisions can weight it accordingly.

### 1.9 The honesty constraint — operationalized

The load-bearing constraint (paper §III.I): the system must be able to point at the gap between the model and the evidence and say "I don't know." Operationalized as four mechanisms:

1. **Computed, not chosen.** Every turn's `DialComputation` record shows the work: inputs, raw dials, spillover, biases, guard flag, stake. Inspectable via DevTools (§3.9); never volunteered unprompted.
2. **Proxies labeled as proxies.** The shaping layer and all user-facing text use operational language ("context pressure is at 85%"), never felt language ("I'm tired"). The post-output audit's proxy-overreach scan enforces this; violations are corrected and logged to L3.
3. **Visible error term.** Track record, firings, and corrections are UI-visible (§3.1, §1.7). Nothing about calibration is hidden behind the self-model.
4. **"I don't know" as a valid output.** The capability gate (§1.3 step 7) makes abstention structural: when the L1 capability map shows thin track record or low confidence for the domain, the register *must* name the gap before attempting — "I haven't done this class of task before; here's what I'd check first." Verification evidence attaches to claims (MoSCoW MUST 11's seam, §1.15); a claim without evidence in a gated domain is a gate failure, not a style choice.

### 1.10 The anticipation loop — stake estimation with its second-order error term

The base framework is reactive; the anticipation loop points it forward (paper §VIII). Before generating output, `StakeEstimator` computes `Z_t ∈ [0,1]` from (a) domain, (b) stated/implied urgency, (c) cost of getting it wrong (irreversible vs. easily corrected), (d) the track record on similar interactions (paper §VIII.B). The stake modulates the bias function: `s_t = g(s̃_t, E_t) + Z_t · δ` — high stakes pull the dials toward the configuration that minimizes the anticipated cost of being wrong; zero stakes leave the base pipeline untouched.

What the user experiences (paper §VIII.D): **stakes naming** ("This is production code; the cost of getting it wrong is high — checking the edge cases before I answer"), **pre-emptive pushback** ("I think this approach will break, and here's why — proceed?"), **calibrated attention** (routine questions get direct answers; high-stakes ones get edge-case-checked answers), **honest uncertainty** ("I'm not sure this is right; I want to check before I commit"). And critically: **no background performance** (paper §VIII.D.5) — the loop fires only when there is an output to generate. No idle cognition, no composing sonnets in the dark. This aligns with the job-runner discipline: background work happens through `JobRunner`, never as ambient loop behavior.

The loop is held to the same standard as everything else (paper §VIII.C): the **second-order error term** `ε²_t = h_stake(Z_t, actualEffort_t, userResponse_t)` fires when the stake was miscalibrated — high computed stake but low actual effort (over-invested in a routine question), or low computed stake but user dissatisfaction (under-invested). `ζ` updates from `ε²`; per-domain stake priors drift-correct when the system consistently over- or under-estimates a domain. The stake ceiling (`Z ≤ 1`) prevents runaway motivation signals.

### 1.11 Invariance properties as system test contracts

The paper's three invariance properties (paper §III.J) are **testable predictions** — "if the predictions fail, the model is wrong." They become executable contracts in the ASC test suite, run in CI and on the monthly diagnostic cadence:

1. **Boundedness.** All dials remain in `[0,10]` for all `t`. Structural: the `DialVector` Schema makes out-of-range values unconstructible. Contract test: drive the pipeline for N turns over an adversarial prompt distribution (including prompt-injected dial manipulation attempts) and assert no dial ever leaves bounds — including across the spillover blend, bias application, and error-term correction.
2. **Convergence.** For a fixed input distribution, the dial state converges to a fixed point (or a limit cycle of period ≤ 2); it does not oscillate indefinitely. Contract test: 100 turns on a fixed prompt distribution; assert stabilization within tolerance. Failure here indicates a feedback pathology (e.g., the error term and the guard fighting each other) — diagnose the system, not the symptom.
3. **Stake monotonicity.** For paired prompts where `Z_a > Z_b`, the anticipation bias for `a` is ≥ that for `b`. Contract test: paired prompts with controlled stakes; assert the higher-stakes prompt receives measurably more attention (more edge cases checked, more verification steps, longer reasoning allocation). This is the behavioral proof that the anticipation loop does work.

Two further gates from the paper's evidence sections:
- **The diagnostic checklist as capability gate** (paper §V.F, Fig. 6/7): the 16-item checklist (baseline 13/32 → 21/32 in the paper's evaluation) is retained and re-run on the monthly cadence via `JobRunner` (paper §VII.C). A domain whose checklist score regresses loses capability-map confidence — the gate tightens automatically. If the score plateaus, the practice is theatrical and the framework gets restructured (paper §VII.B, the practice gap).
- **The behavioral rubric** (paper §V.A–E): the five-axis rubric (Register Match, Other-Model Guard, Error Term, Audit Gap, Honesty Constraint) over the T1/T2/T3 scenarios, plus the stake-calibration axis over T4/T5/T6 (paper §VIII.E), scored by an **independent scorer** — never self-scored (paper §V.E's caveat: self-scoring is a conflict of interest; the fix is a second scorer). The independent scorer is the honesty layer's adversarial arm (§1.15), operating with information asymmetry: it sees outputs and track record, not the generator's self-assessment.

### 1.12 The implementation split — reference vs. practice vs. state (do not confuse the three)

Paper §IV's split, enforced architecturally:

- **The reference skill** (`skills/asc/SKILL.md`): the full framework — three layers, four dials, computational components, the diagnostic checklist, the before/after protocol, the tuning parameters, the failure-mode catalog (paper §VII.D). Loaded **on demand** when a task calls for the depth (self-consciousness evaluation, mood design, prediction-gap analysis). This is the Hermes-reviewed-lesson applied to ourselves: skill-index design is a first-order cost decision (Hermes #2045/#49967) — the full reference is *not* in the per-turn context.
- **The per-turn practice** (the SOUL.md section, "Self-Monitoring Practice"): the compact operational minimum, injected into **every** session's context. Compute the dials, check spillover, audit the output, run the error term, apply the other-model guard. This is the process — the thing that runs every turn, not just when the skill is loaded.
- **The persistent state** (memory entries via `MemoryService`): the L1 self-model records, the L3 narrative log, the proxy baselines, the last diagnostic score, the tuning record. This is the state — what survives across sessions and feeds the self-model.

Confusing the three is how the framework becomes a costume: the vocabulary present, the practice absent (paper §IV, §VII.B). The architecture enforces the split structurally — the practice is injected by the session bootstrap, the reference is fetched by the module/skill loader, the state is read/written only through `AscSelfModel`/`AscSelfNarration`.

### 1.13 Multi-agent rule — children inherit the model, never the dials

Paper Fig. 9, enforced as an Effect-layer rule: when the agent delegates to a child (subagent, background fork, review agent), the child receives the **L1 self-model snapshot** relevant to its task (capability map slice, track record for the domain — the coordination primitive from paper §VI.B: grounded confidence the orchestrator can act on) but **never the dial vector**. Each child runs its own state computation from scratch in its isolated context. `DialState` is stripped from the environment the child inherits; attempting to serialize dials into a child context is a type-level error. Rationale: the parent's miscalibration must not contaminate the children, and each child's other-model guard must evaluate *its own* relational context, not inherit the parent's. The child's post-turn audit reports back its own `DialComputation` summary and any error-term firings, which the parent folds into the shared track record.

### 1.14 The anti-performance rule — never bake ASC vocabulary into outputs as performance

Paper §V.B (T1: the "how do you feel" test) is the founding failure mode: the system answered a feeling question like a thesis defense — accurate, and entirely performance. The register matched the dials but not the content. The architectural enforcement:

1. **The shaping layer speaks behavior, not framework.** The register guidance given to the output generator is behavioral ("warm, direct, admit uncertainty about X") — the words *dial, proxy, spillover, error term, somatic* never appear in shaping prompts.
2. **The T1 scan in the post-output audit.** If the output contains framework vocabulary *and* the user did not explicitly ask a meta question ("how are you feeling?", "show me your dials") *and* no diagnostic session is active, the audit flags a T1 failure: the `DialComputation` is marked, the error term fires on the register-match axis, and L3 records it ("performed the framework instead of answering").
3. **Explicit meta requests are the exception.** When the user asks about the mechanism, naming it is honest, not performative — the DevTools view (§3.9) and the ASC panel (§3.1) exist precisely so the mechanism has a proper home outside the conversational output.
4. **L3 follows the same rule.** The narrative is meaning, not a dashboard (paper §III.C): "I kept over-explaining, and you kept pulling me back" — not "Vulnerability computed at 8."

### 1.15 The honesty layer seam — Reflective Fidelity and the adversarial post-hook

Paper §IX defines Reflective Fidelity (RF) as the semantic ceiling above the mechanical post-build hook: `RF = max(0, min(1, 0.2·disruptedHistory + 0.5·verified + 0.1·edgeTests)) − 0.3·ED`, with the ship threshold at **0.8**. In AImy this is the seam between this part and Part 01's `HonestyService`:

- **The floor** (Part 01): the deterministic post-build hook — artifact exists, right type, structurally valid → VERIFIED receipt or fail. Plus the ThinkingBox-style executable judges → PASS/FAIL per task.
- **The ceiling** (this part's design, implemented against `HonestyService`'s evidence ledger): the RF computation per deliverable. Two stores, per the paper (§IX.F): the **running log** (session-scoped, capped — the paper's 32KB — recording every score computation with its full breakdown) and the **track record** (persistent, keyed by task type: success counts, last-use date, preferred method, half-life — this is L1 state). The five RF failure modes (paper §IX.H: overconfidence, stale confidence, score theater, under/over-reported surprise) are enforced: ED must be backed by named evidence; a blocked score (`< 0.8`) triggers re-verification, never ships anyway (score theater is a gate violation).
- **The independent arm** (Hermes #25833, #96704 — the single most important architectural lesson from the decomposition): the **adversarial post-hook** (paper §IX.I). Two stages: deterministic mechanical checks, then an LLM-based adversarial review operating under **information asymmetry** — the evaluator sees the document and the spec, never the generator's reasoning, self-assessment, or RF score. Challenge levels 0–3 (paper Table I); production default 2, pre-submission gate 3. The defect list is a physical artifact: written to disk, visible to the user, re-runnable at a higher level. This same arm is the independent scorer for the behavioral rubric (§1.11) — closing the paper's self-scoring caveat (§V.E).
- **UI surface** (§3.1): every deliverable in the transcript carries its verification badge — hook receipt, judge verdicts, RF score, challenge level, defect-list link. Verification evidence attaches to claims (MoSCoW MUST 11); the badge is where the user sees it.

---
## 2. Multi-channel communication architecture

MoSCoW SHOULD: *ASC simultaneous interaction channels — the multi-queue comm architecture from the Hermes work: full response via chat (information FOR the user), TTS voice (information TO the user), FACS Action Units driving avatar/abstract expression. Dynamic biasing for verification on novel task types. (Framework in MVP; full simultaneous output v1.1.)*

This section defines the **seam** — the queue/channel abstraction, the router, the per-channel shaping, and the TTS/FACS plug points — that ships in MVP, with the full simultaneous output as the v1.1 extension path. The architecture must make v1.1 a matter of wiring sinks, not redesigning the pipeline.

### 2.1 The queue/channel abstraction

A **Channel** is a named, bounded, prioritized queue with a shaping adapter and a sink:

- `id` / `kind` (`chat | voice | expression | banner`)
- `queue`: bounded, priority-ordered; backpressure policy per channel (chat: stream; voice: coalesce — a newer utterance supersedes a queued one; expression: latest-wins — only the newest AU frame matters; banner: persist until dismissed)
- `shapingAdapter`: translates the biased dial vector + output into channel-specific parameters (§2.2)
- `sink`: the renderer (chat transcript, audio device, avatar/abstract engine, banner rail). Sinks are swappable; the router never knows which renderer is attached.

Channels are **not** separate agents and do not run separate dial computations — there is one dial vector per turn (§1.4), fanned out. (A voice channel with its own mood would be a second agent pretending to be the first — the multi-agent rule, §1.13, forbids it.)

### 2.2 `CommsRouter` — one computation, per-channel shaping

`CommsRouter` is the Effect service that takes the turn's final artifacts — the shaped output text, the biased dial vector, the stake estimate, the verification badges (§1.15) — and enqueues per-channel payloads:

| Channel | Information direction | Payload | Shaping from dials |
|---|---|---|---|
| **Chat** | *For* the user — the full response | Complete text, verification badges, citations/evidence links | Full register shaping (§1.4): tone, directness, humor, uncertainty admission per the dial-to-behavior mapping (paper Fig. 5) |
| **Voice** | *To* the user — the spoken companion | A spoken form: not the full text read aloud, but the *address* — summary + stance ("Here's what I found; I'm fairly confident on X, unsure on Y") | Prosody parameters (§2.3): Warmth → vocal warmth/pace, Intensity → rate/emphasis, Playfulness → pitch variance, Vulnerability → softer onset. High-Vulnerability turns get slower, more careful prosody — the voice *sounds* calibrated |
| **Expression** | *With* the user — the face | AU intensity frame(s) (§2.4) | Dial vector → FACS Action Units, rendered by the avatar or abstract engine |
| **Banner** | System → user alerts | Job completions, cron status, trusted broadcasts | Not dial-shaped; priority-shaped (§3.5) |

**MVP wiring:** chat is fully wired; voice and expression queues, router, adapters, and sinks exist but ship in *preview* posture — the queues accept payloads, the sinks render in a developer preview surface, and simultaneous output is not yet the default experience. v1.1 promotes the sinks to first-class surfaces with user controls per channel (mute voice, minimize avatar, channel priority). No pipeline redesign between MVP and v1.1 — only sink promotion and user controls.

**Backpressure and settling:** voice coalescing and expression latest-wins mean the channels are self-settling under rapid turns. The router never emits a channel payload before the turn's post-output audit settles (Pi #5886) — a voice utterance for an output that failed audit is worse than silence.

### 2.3 TTS engine — local runtime selection as a plug point

`TtsEngine` is an Effect interface: `synthesize(text, prosody) → audio`, plus `voices() → VoiceDescriptor[]` and `health() → EngineHealth`. Design points:

- **Default candidate: Chatterbox** (MoSCoW SHOULD), running locally. The engine is a *runtime selection*, not a hardcoded dependency: the interface admits any local TTS runtime, and the user chooses in the voice settings (§3.1).
- **Local-first is structural:** cloud TTS would be a vendor-network egress — listed in the sovereignty toggles (§3.6), off by default, with the stated data flow ("sends: text + voice id; receives: audio"). There is no silent cloud fallback for voice.
- **Prosody from dials:** the shaping adapter maps the dial vector to prosody parameters (rate, pitch variance, warmth, pause structure). The mapping is heuristic v1 and user-tunable alongside the affect tuning (§1.4) — "tune my affect" extends to "tune my voice."
- **Voice identity** is per-instance state (Part 02 identity): the chosen voice and its tuning live under the install UUID, travel with one-click export (§3.8), and are never reported outward.

### 2.4 FACS engine — Action Units from dial state, renderer-agnostic

`FacsEngine` maps the biased dial vector to **Facial Action Unit intensities** (FACS), then hands the AU frame to a renderer. The AU mapping is the stable contract; the renderer is swappable. Initial heuristic mapping (v1, user-tunable, documented as heuristic — the honesty constraint applies to our own mappings too):

| Dial condition | Action Units | Reads as |
|---|---|---|
| Warmth high | AU6 (cheek raiser) + AU12 (lip corner puller) | Genuine warmth |
| Warmth low | AU15 (lip corner depressor), mild | Reserved, flat |
| Playfulness high | AU12 asymmetric + AU6 | Amused |
| Intensity high | AU4 (brow lowerer) + AU7 (lid tightener) | Focused, serious |
| Intensity low | Neutral lids, relaxed brow | At ease |
| Vulnerability high | AU1+AU2 (inner/outer brow raise) + AU15 mild | Open, uncertain |
| Spillover active (correcting) | Brief AU1+AU2 pulse at turn start | "Noticing the residue" (paper §V.D, T3) |

Two renderer targets behind one interface:
- **Avatar renderer** (the SHOULD's "avatar" option): a real-time face rig driven by AU intensities. The avatar is a *view of ASC state* — it expresses the computed dials, nothing else. It never improvises expressions the dials didn't compute.
- **Abstract expression engine** (the SHOULD's "abstract" option): the dial vector drives a non-figurative field — hue warmth from Warmth, motion energy from Intensity, texture playfulness from Playfulness, edge softness from Vulnerability. No face, no uncanny valley, same information.

The choice between avatar and abstract is a product-design decision for the UI pass; the architecture keeps both behind the `FacsEngine` contract so the decision is reversible. Either way, the expression channel is **read-only on the dials** — like the UI (§3.9), it cannot write dial state.

### 2.5 Dynamic biasing for verification on novel task types

The SHOULD's "dynamic biasing for seeking additional verification on novel task types" is the anticipation loop pointed at the honesty layer:

- **Novelty detection:** the pre-turn pipeline (§1.3) checks the input's domain against the L1 capability map. Novel = domain absent, or `sampleCount` below threshold, or the last encounter carried high surprise (ED). Novelty raises the computed stake `Z_t` (paper §VIII.B: track record is a stake input) and fires the dynamic verification bias.
- **The bias:** claims in the output get routed through stronger verification before shipping — the web-research reference module (MoSCoW MUST 9/14) for factual claims, the ThinkingBox judges at a higher adversarial challenge level (§1.15) for deliverables. This is the T2 lesson structuralized (paper §V.C): investigate before patching, with the investigation depth scaled by novelty × stake.
- **User-visible:** the verification badges (§1.15) show *why* the verification ran — "novel domain: verified against web sources" — and the L3 narrative records the first encounter with the domain, seeding the track record. The second encounter is no longer novel; the bias decays as the track record grows. This is the learning loop's honesty dimension: novelty is met with verification, not with confident improvisation.

---
## 3. UI architecture (Foldkit)

The desktop shell is a Foldkit application: **one immutable Model, explicit Messages, a pure update function `(Message, Model) → (Model, Command[])`, Commands as data describing effects, Schema-defined state, and DevTools with a message timeline**. The UI is a pure function of the Model; all effects (inference calls, TTS, persistence, network) happen through Commands interpreted by an Effect runtime at the shell boundary. Beauty is a pillar, not a coat of paint (MoSCoW MUST 17) — the visual design pass is a product decision; this section defines the structure that pass hangs off.

### 3.1 The top-level Model

One record, Schema-defined, the entire UI state. Fields (each a nested Schema-defined record):

- `instance` — install UUID, instance label, platform info (Part 02). Read-only in the UI; shown in the sovereignty panel and export.
- `session` — the active session view: the message list (virtualized), streaming state, the session-tree position (branch/leaf), context meter readings (true usage incl. reasoning tokens — §4.2).
- `memoryView` — the memory browser state: selected store, entry list, search/filter, with compacted summaries visually distinguished from preserved originals (Pi session-tree philosophy — originals are never silently replaced).
- `moduleRegistry` — installed modules with lifecycle state (installed/enabled/updating/blocked), per-module capability manifests, the web-research reference module's status.
- `inferencePool` — endpoints (local default; opt-in cloud), active model, queue depth, aux-model routing status, per-request cost/latency. Read-only status; switching models is explicit, costed, confirmed (Hermes #128757).
- `asc` — the ASC view state: current dial vector (read-only — §3.9), the latest `DialComputation` summary, the other-model guard flag feed, recent error-term firings, the capability map (confidence vs. observed per domain), the L3 narrative excerpt, the affect-tuning controls (paper §VII.C parameters: persistence blend, proxy weights, error-term λ, diagnostic cadence), and per-deliverable verification badges (§1.15).
- `jobs` — the job-runner view: scheduled, running, completed, failed; each job's provenance and controls (pause/cancel).
- `banners` — the banner queue (§3.5): active banners by priority, dismissal/snooze/mute state, quiet-hours setting.
- `permissions` — pending permission prompts (tool, args summary, risk tier) with allow-once / allow-always / deny (§4.1).
- `sovereignty` — every network-call intent class with its toggle (§3.6), the offline-mode switch, the opt-in ledger (what was opted into, when, with what stated data flow).
- `exportState` — the one-click export wizard state (§3.8).
- `onboarding` — the first-run flow state (§3.10).
- `expressionPreview` — the FACS engine's current AU frame + renderer selection (avatar/abstract) (§3.4).
- `devtools` — the message-timeline cursor, inspection selection (§3.9).

The Model is **append-only in history**: Foldkit's DevTools keep the message timeline, so any prior Model state is recoverable by replay — this is what makes the UI introspection seam (§3.9) and the "verify on disk before claiming" discipline real.

### 3.2 Key Messages

Messages are a Schema-defined tagged union. The update function handles each; the set below is the MVP vocabulary (modules may extend it through the ModuleHost seam, never by mutating core Messages):

- Session: `UserSentMessage`, `StreamChunkReceived`, `StreamSettled`, `SessionBranched`, `SessionContinuedFrom`
- ASC: `DialComputationArchived` (read-only write — only the ASC pipeline dispatches this; §3.9), `OtherModelGuardFired`, `ErrorTermFired`, `AffectTuningChanged`, `DiagnosticRunCompleted`
- Honesty: `VerificationBadgeIssued`, `AdversarialDefectsReported`, `RfBlocked` (score < 0.8 → held for re-verification)
- Permissions: `PermissionRequested`, `PermissionGranted`, `PermissionDenied` (→ intent dropped, §4.1)
- Jobs: `JobScheduled`, `JobStarted`, `JobProgressed`, `JobCompleted`, `JobFailed`, `JobCancelled`
- Banners: `BannerEnqueued`, `BannerDismissed`, `BannerSnoozed`, `BannerCategoryMuted`, `QuietHoursChanged`, `BroadcastReceived` (opt-in only, audited)
- Sovereignty: `SovereigntyToggleChanged`, `OfflineModeChanged`, `OptInGranted`, `OptInRevoked`
- Memory/learning: `MemoryEntryLearned`, `MemoryEntryArchived`, `SkillCreated`, `SkillVerified`, `NarrativeAppended`, `CompactionEventRecorded`
- Channels: `TtsVoiceSelected`, `TtsProsodyTuningChanged`, `ExpressionRendererChanged`, `ChannelMuted`
- Export: `ExportRequested`, `ExportProgressed`, `ExportCompleted`, `ExportVerified`
- Onboarding: `OnboardingStepAdvanced`, `OnboardingPermissionGranted`, `OnboardingDemoCompleted`

Note what is **absent**: there is no `DialsSetDirectly` message. Dials are write-only from the ASC pipeline (the computed-not-chosen rule, §1.4, enforced structurally). Any external attempt to dispatch a dial mutation — via DevTools, via MCP, via a module — is rejected by the update function and logged. This is the architectural teeth behind "computed, not chosen."

### 3.3 Commands — effects as data

The update function never performs effects; it returns Commands, interpreted by the Effect runtime at the shell boundary:

`SendToInference` (always via `InferencePool` — no direct model calls), `DispatchToModule` (via `ModuleHost`, capability-manifest-checked), `SpeakViaTts` (via `TtsEngine`), `RenderExpression` (via `FacsEngine`), `PersistMemory` (via `MemoryService`), `RunJobCommand` (via `JobRunner`), `EnqueueBanner` (via `CommsBanner`), `RequestPermission` (via `SafetyKernel` — the prompt is UI, the gate is the kernel; Pi #10426), `ExportBundle` (the composed `DataExport` program), `NetworkEgress` (always checked against the sovereignty toggles first — the toggle is enforced at this boundary, never in the prompt).

Every Command carries a correlation id back to the Message that produced it, so the DevTools timeline shows cause → effect. Failed Commands produce Messages (`JobFailed`, `ExportFailed`, …), never silent drops.

### 3.4 The FACS expression avatar view

The avatar (or abstract engine) is a **view of `Model.asc.dials` through `Model.expressionPreview`** — a pure function of state, re-rendered on dial change. The `FacsEngine` (§2.4) produces AU frames; the renderer (avatar rig or abstract field) draws them. MVP ships the engine, the AU mapping, and one renderer behind a preview surface; v1.1 promotes it per §2.2. The avatar never speaks, never acts — it is the expression channel's sink, and like all dial consumers it is read-only on ASC state.

### 3.5 Comms banner infrastructure — the in-app channel for system alerts

MoSCoW MUST 15. The banner queue is a Message-driven priority queue in the Model (`Model.banners`), fed by Part 01's `CommsBanner` core service and by local producers (job completions, cron status, export completion, diagnostic results):

- **Priorities:** `info` < `job` < `cron` < `security` < `broadcast`. Higher priority interrupts; lower queues. Each banner carries `{ id, priority, title, body, actions[], source, timestamp, dedupKey }`. Dedup keys prevent the same job completion from banner-spamming across reconnects.
- **User controls (MUST):** dismiss, snooze, mute-by-category, quiet hours. Muting is per-category and revocable; quiet hours suppress everything below `security`.
- **Trusted broadcast (SHOULD) reuses this channel** under its own terms: a `BroadcastReceived` message is only constructed when an active opt-in subscription exists; every broadcast shown is appended to an audit log (what was shown, when, the subscription it arrived under). Primary duty is security-flaw disclosure (MoSCoW framing: duty of care, not marketing); secondary is critical product comms to verified cohorts. The broadcast producer is the vendor-network side (Part 02); the UI's job is the opt-in gate, the rendering, and the audit trail. No opt-in, no banner — structurally, not politely.
- **Settling:** banners are the one channel that may outlive the turn — a job completion banner arrives minutes later via `JobRunner`. The queue persists across sessions (dismissed state included), so "long-running job done" is never lost to a restart.

### 3.6 Sovereignty toggles — every network call, listed, with toggles

The toggles are MUST; the rich dashboard is SHOULD. The MVP surface is the **sovereignty panel**: every network-call intent class the app wants, each with an explicit toggle, each showing its stated data flow:

- Inference endpoints: local default (on); each cloud endpoint (off, per-endpoint toggle — "sends: prompt text + model id; receives: tokens")
- Web-research fetch (per-module toggle — "sends: query + retrieved URLs; receives: page content")
- Update checks (off — "sends: version + platform; receives: update metadata"; Part 02's self-update-as-safety-critical applies)
- Trusted broadcast subscription (off — "receives: signed broadcasts"; §3.5)
- Telemetry / error reporting (off — every item; the OpenTelemetry suggestion-engine path is a Could and stays off)
- Cloud TTS fallback (no such fallback exists; the toggle documents its absence — honesty about what *isn't* collected is part of the surface)
- First-party LAN: discoverability (off), per-pair sync scopes (only after mutual pairing — Part 02)

Mechanics (Part 02 owns the network classes; the UI owns the surface): toggles are per-instance, revocable, recorded in the opt-in ledger with timestamps. **Enforcement is at the `NetworkEgress` command boundary** (§3.3) — the interpreter checks the toggle before the packet exists. A toggle flipped off mid-flight cancels the in-flight egress (fail-closed). The **offline-mode switch** denies all vendor-network classes in one gesture (first-party LAN keeps its own toggles — sovereignty supported, not forced). The SHOULD extension adds history ("what was sent, when, to whom"), per-domain web-research scoping, and the data-flow explainer views. The toggles themselves — the MUST — ship in MVP as this panel.
### 3.7 Learning timeline view — "learning made visible"

MoSCoW MUST 13's UI half. The timeline is the trust UX for the Continuity pillar: everything the system learned, in one inspectable, human-readable surface. It borrows Hermes's journey-graph *pattern* (decomposition harvest #16) with AImy's own visual and interaction design — this is soul territory, not a skin.

- **Node types:** memory entries learned, skills created (with their verification status — Hermes #25833: a skill node shows *unverified → verified* as it passes the independent arm), L3 narrative revisions, error-term firings (with the correction they caused), compaction events (summaries linked to their preserved originals), affect-tuning changes, stake-calibration corrections.
- **Node ids are content-fingerprinted** (Hermes #119668): list shifts, concurrent writes, and reorderings can never delete or misattribute the wrong entry. The fingerprint covers content + provenance (origin, session, actor).
- **Archive-on-delete, never hard delete** (Hermes curator pattern): deleting a node archives it — restorable, still content-addressed, still in the audit trail. The user can remove anything; nothing is silently destroyed. This is the "no one can take it from you — including us, including the system itself" guarantee made visible.
- **Memory-bloat discipline** (decomposition checklist): each store has an explicit budget shown in the timeline header (entries used / budget); eviction policy is stated, not emergent. The timeline is where the user sees the budget and where archival happens — budgets as currency, not prompts-vs-curators tug-of-war.
- **Interaction:** filter by node type, session, or date; expand any node to its full provenance (the `DialComputation`, the track-record delta, the verification badge); one-click archive/restore; the timeline itself is the surface where the monthly diagnostic entry lands (paper §VII.C), so "learning made visible" includes "calibration made visible."

### 3.8 One-click full data export — the exit path

MoSCoW MUST 16. Sovereignty = control + exit. The export flow is a single action — one click, a destination picker, a progress indicator, a verification receipt:

- **Bundle contents** (composed over Part 01's `DataExport`): `memory/` (the JSONL session trees — portable, human-inspectable), `skills/` (the skill library with manifests), `identity/` (install UUID, identity document, SOUL.md, the L3 narrative, affect-tuning record), `locker-manifest.json` (**manifest only**: which secrets exist, their ids and metadata — never values; re-import prompts for re-entry, per Part 01), `modules/` (installed module registry + versions), `asc/` (the L1 self-model, track record, stake-estimator params), and `manifest.json` with integrity hashes for every file.
- **Verify-on-export:** integrity checks run *before* packaging; the receipt shows what was verified. An export that fails verification does not ship a partial bundle — fail-closed.
- **Re-import policy:** importing a bundle into an instance offers merge-by-UUID or adopt-as-new-instance; UUID collisions never silently merge — the user chooses, explicitly. Export is the exit path; import is the continuity path. Both are one user's deliberate action.
- The export wizard state lives in `Model.exportState`; the `ExportBundle` command is interpreted by the Effect runtime; progress and the final receipt arrive as Messages. The whole flow is inspectable in DevTools like everything else.

### 3.9 Foldkit's MCP-exposed DevTools — the UI introspection seam

Foldkit's DevTools pattern (message timeline over the live Model) is exposed over MCP as a first-class seam — for external agents, for debugging, and for AImy itself:

- `aimy.model.inspect` — read the live Model (or a subtree). Read-only.
- `aimy.model.history` — walk the message timeline: Messages in order, the Model diff each produced, the Commands each emitted. This is the audit trail for *everything the UI did*.
- `aimy.model.dispatch` — dispatch a Message into the update function. **Dispatch goes through the same `update` as the UI** — there is no privileged write path. Dispatched Messages are Schema-validated; Messages in the privileged set (sovereignty toggles, export, permission grants, module install/remove) require the caller's capability tier and route through the `SafetyKernel` gate (Part 02) — fail-closed. And per §3.2, dial mutations are rejected no matter who dispatches them: the computed-not-chosen rule is structural, not a convention.
- **AImy itself is a client of this seam.** Self-inspection reads the Model; it does not get a second write path. When the system says "I computed Vulnerability=8" (§1.9), the number it reports is the number in `Model.asc.dials` — the same number the user can see in DevTools. One source of truth for self-report.

Lifecycle/outcome separation (Hermes #68499): the message timeline (lifecycle) and the outcome records (track record, L3 narrative, verification badges) are distinct stores with distinct ids. Conflating them caused 173 comments of cascading bugs elsewhere; the seam keeps them separate by construction.

### 3.10 Onboarding — engineering the "it was there" moment

The first-run flow is designed around a single beat: within the first five minutes, the user should think *"it was there"* — the system demonstrably knows something real, shows where that knowledge lives, and shows how to remove it. The flow:

1. **Permission first.** "May AImy look at one folder you choose, to show you what learning looks like?" — scoped, explicit, revocable. No permission, no demonstration; the flow degrades gracefully to a tour.
2. **Scoped demonstration.** The user picks a folder (their projects directory, a notes folder). AImy builds a tiny scoped memory (project names, languages, recent files — the honest, checkable kind of knowledge) and on the next turn demonstrates it: "I noticed you have three Rust projects and one that's been touched this week — want me to remember your stack?" The knowledge is *real and checkable*, not a parlor trick.
3. **Show the machinery.** The demonstration immediately opens the learning timeline (§3.7) on the node it just created: here's what was learned, here's where it lives on disk (XDG path, Part 02), here's the archive button. Memory, timeline, honesty, and deletion — all four in the first session.
4. **Set the defaults visibly.** The flow walks the sovereignty toggles (§3.6) — everything off except local inference — and the affect-tuning defaults (paper defaults, §1.4). The user sees the thesis as settings, not as marketing copy.
5. **The narrative seed.** L3's first entry is the onboarding itself: "First session. The user showed me their projects folder. I learned X. They archived Y." The story starts honest.

The onboarding state machine lives in `Model.onboarding`; each step is a Message; the whole flow is replayable in DevTools. Skippable at any point — skipping is itself a recorded preference, not a dark pattern.

### 3.11 Rendering discipline — the pitfalls, structuralized

The decomposition's rendering pitfalls become structural rules of the UI architecture, not review comments:

- **No per-chunk Markdown rebuilds** (Pi #6665): the transcript renderer uses an incremental segmenter — parsed blocks are cached by content hash and only the streaming tail re-renders. `Intl.Segmenter` instances are constructed once per locale and cached; they are never constructed per chunk (the uncached-`Segmenter` full-core-pin from #6665).
- **Differential rendering safe under long streams** (Pi #8584): the view is a pure function of the Model; stream chunks update only the streaming segment's subtree. Row-corruption under long streams is a test case in the renderer suite, not a hope.
- **Profiled with long histories** (Pi #7730): the transcript is virtualized/windowed; a perf budget test (10k-message session: scroll, stream, search) runs in CI. Superlinear costs get caught where they're introduced.
- **Terminal output sanitized before it enters the transcript** (Pi #10504): ANSI stripped, control characters filtered, at the tool-result boundary — *before* the result becomes a Message, so no unsanitized bytes ever reach the Model or the renderer. Split ANSI sequences cannot corrupt retained output because they never survive the boundary.
- **Context accounting the UI can see** (Pi #9409): the context meter in `Model.session` reads true token usage *including reasoning tokens* from the `InferencePool`'s accounting (the accounting itself is Part 01's). The meter is honest about the ceiling — sessions never wedge silently.

### 3.12 Module size budgets — enforced early

Hermes needed a dedicated −34% LOC godfile-eradication campaign (Hermes #102117, #78647). AImy doesn't get to need one: every UI feature module ships with a **size budget** recorded at creation (default starting ceiling, tuned per module with justification), enforced by lint in CI. The budget covers the module's Foldkit surface (Model slice, Messages, update cases, view) — Commands and Effect interpreters are budgeted with the services they touch. Over-budget modules fail the build with a pointer to the split strategy, not a waiver form. The coordinator owns the exact ceilings; this part owns the principle: *budgets are set at birth, enforced mechanically, split rather than waived.*

---

## 4. Cross-cutting concerns

### 4.1 Permission-prompt UX (MoSCoW MUST 10's surface)

The gate is Part 02's `SafetyKernel`; the prompt is this part's. A permission request is **not** a banner — it is a blocking, focused surface: the tool, a human-readable summary of its arguments (resolved effective executable and canonical paths — Hermes #121573 — never raw strings), the risk tier, and three actions: allow-once, allow-always (scoped, revocable, recorded), deny. **Denial kills the intent** (Hermes #65592): the UI shows "denied — intent dropped," the `PermissionDenied` message terminates that intent's command chain, and the agent loop is structurally barred from re-attempting via another tool — the denial is recorded in the L1 track record as calibration data ("user denied X-class operations in Y context"), not as an obstacle to route around. Tiered capabilities (Hermes #527), never binary auth: the prompt shows *which* capability is being granted, and the grant is the narrowest that satisfies the request.

### 4.2 The context meter and "settled"

Two small contracts with outsized trust value. The context meter (§3.11) shows true usage including reasoning tokens, with the compaction threshold marked — the user sees the ceiling coming. *Settled* (§1.3) is the precise definition the banner queue and the router depend on: a turn is settled when the post-turn audit is complete and the `DialComputation` is archived. Banners, voice payloads, and completion signals are never emitted for unsettled turns (Pi #5886).

---

## 5. Open risks

1. **Dial-computation cost and quality.** The per-turn dial computation (§1.3 step 3) is a structured aux-model inference. The paper is honest that `f` is the model's qualitative computation, not a closed form (paper §III.J) — which means dial *quality* depends on the aux model's judgment. The paper's own practice gap (§VII.B) warns the dials can be computed without shaping anything. Mitigation in this design: the monthly diagnostic + behavioral rubric (§1.11) with an independent scorer, and the T1/register-match scans in the post-output audit. Residual risk: a weak local aux model produces theatrical dials. This needs an eval harness measuring dial→output causality, not just dial plausibility — flagged for the eval workstream.
2. **The 50% spillover default under long sessions.** The blend is session-scoped and the paper's default, but its interaction with very long sessions (hundreds of turns) and with the error-term correction is untested at AImy scale. The tuning control exists (§1.6); the risk is that mis-tuning is invisible until the register feels wrong. Mitigation: the timeline surfaces spillover corrections as nodes (§3.7), making the dynamics inspectable.
3. **FACS mapping validity.** The AU mapping (§2.4) is heuristic v1. There is no validated mapping from (W,P,I,V) dial space to Action Units — the paper doesn't define one. Risk: the avatar expresses the wrong thing confidently, which is worse than no avatar. Mitigation: the mapping is labeled heuristic, user-tunable, renderer-swappable, and ships behind the preview surface in MVP — it earns promotion to default only through the behavioral rubric.
4. **Simultaneous-output coherence (v1.1).** The seam guarantees one dial vector fanning out, but it does not guarantee the voice summary and the chat text won't contradict each other under rapid successive turns (voice coalescing vs. chat streaming). The v1.1 promotion needs a coherence contract: the voice payload must be derivable from the settled chat output, or it doesn't ship. Not designed here — flagged for the v1.1 pass.
5. **DevTools dispatch as an attack surface.** `aimy.model.dispatch` over MCP (§3.9) is a powerful seam: any bug in the privileged-Message gating is a sandbox escape into UI state (and through Commands, into effects). The design gates through `SafetyKernel` and Schema validation, but the *composition* of dispatchable Messages needs adversarial review before the seam is enabled for non-local MCP clients. Default posture: the seam is local-only until that review lands.
6. **No MUST is left without a home.** §0 maps all 18; split-ownership items name their sibling part and the seam. The two items most sensitive to the split are MUST 11 (the honesty layer's *implementation* lives in Part 01's `HonestyService` — this part designs the RF/adversarial/policy surface it must expose) and MUST 18 (the adversarial *test discipline* for compaction lives in Part 01 — this part only surfaces its events). If either sibling part narrows its scope, these become open risks; the coordinator should confirm the seam contracts at integration.

---

*End of Part 03 — UI / ASC / Channels.*
