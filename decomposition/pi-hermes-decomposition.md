# Pi + Hermes Agent Decomposition — Project AImy

**Date:** 2026-10-06/07 · **Phase:** decomposition (report only — no AImy code written)
**Sources:** `github.com/earendil-works/pi` @ v1.0.4 (commit `eb326d2`); `github.com/NousResearch/hermes-agent` @ commit `0e37a439`. Both MIT. Code was read directly (shallow clones); issues/PRs surveyed via GitHub REST API. Full per-repo working notes: `/tmp/pi-decomp.md`, `/tmp/hermes-decomp.md` (ephemeral).

**AImy frame:** local-first modular companion platform. Pillars — **Sovereignty** (user-owned, local-first, un-takeable), **Continuity** (memory that compounds, never starts from zero), **Adaptive** (modular via MCP, grows new capacities). Build philosophy: **own the soul** (presence, memory, trust, UX), **borrow the scar tissue** (hard-won lessons). Open source, MIT-compatible.

---

## Executive summary

**Which repo yields more harvestable capability? Hermes — but it's the dangerous harvest.**

Hermes Agent (~249k stars, Feb 2026, Python) contains the most capability relevant to AImy: a background learning loop with per-turn review forks, a curated two-store memory system, skill synthesis from experience, a verification-evidence honesty pattern, a shadow-git checkpoint store, and a messaging-gateway adapter contract. But that capability is concentrated exactly where AImy must be sovereign — the learning agent *is* Hermes's soul, and its runtime is cloud-shaped (40-provider catalog, Nous managed modes, default-on keyless network fallbacks). Verdict: **decompose Hermes for knowledge (STUDY), borrow only plumbing, never adopt the runtime.**

Pi (~113k stars, v1.0.4, TypeScript) yields less total capability but a cleaner harvest: the best lifecycle-hook taxonomy of any agent harness surveyed, an event-stream architecture that buys four interfaces for one, a best-in-class local-first session-tree (JSONL) memory design, and a unified provider-abstraction shape. Its gaps are honest and documented (no sandboxing, in-process extensions, compaction bug farm, default-on install telemetry). Verdict: **harvest Pi for parts (BORROW plumbing patterns), study its extension/trust UX, avoid its packages as a foundation** (v1.0 already breaking subpath exports days after release).

**Net strategy:** study Hermes's learning-loop *design* deeply and write AImy's own; take Pi's *harness primitives* (hooks, events, session tree, provider boundary) as architectural patterns. Own the core loop, the memory schema, the review prompts, and the UX. Borrow: sandboxing patterns from everyone's mistakes, the SKILL.md package shape (community standard, not Hermes's invention), checkpoint/evidence-ledger designs, and the fail-closed secret discipline.

---

## Harvest priority list (ranked by value to AImy)

| # | Harvest | Source | Verdict | Pillar | Why it matters |
|---|---|---|---|---|---|
| 1 | Background-review fork architecture (fork after turn, dispatch-side tool whitelist, foreground-priority cancel w/ bounded handshake, aux-model routing, idle queue for local GPU) | Hermes `agent/background_review.py`, `review_idle_queue.py` | STUDY | Continuity | The best-engineered autonomous-learning mechanism in either repo. Take the *mechanism design*, write our own prompts. |
| 2 | Review-prompt failure taxonomy (do-not-capture list, lesson-layer shape contract, memory routing USER.md vs MEMORY.md, read-before-write) | Hermes review prompts | STUDY | Continuity | Highest-value knowledge artifact. Internalize the failure modes (learned helplessness, negative-claim hardening, incident narration hoarding); do NOT copy the text — that's their soul. |
| 3 | Unattended-write safety: autonomous forks may `add`, never `replace`/`remove` unattended — destructive ops stage for human approval, fail-closed | Hermes `tools/memory_tool.py::_background_delete_gate` | BORROW pattern | Continuity, Sovereignty | Foundational trust machinery; maps directly onto AImy's honesty pillar. Small enough to reimplement cleanly. |
| 4 | Agent-loop hook taxonomy (`prepareNextTurn`, `prepareRequest`, `finishTurn`, `beforeToolCall` w/ block+terminate, `afterToolCall`, steering vs follow-up queues, tool-diff declared to model) | Pi `packages/agent` | BORROW | Adaptive | Cleanest lifecycle-hook vocabulary seen in any harness — the exact seam AImy's MCP modules hang off. Copy the truncated-`length` → fail-all-tool-calls hardening rule. |
| 5 | Session tree (JSONL, parentId chains, branch/continue/fork, versioned migrations, compaction entries preserving originals) | Pi `packages/coding-agent` | BORROW | Continuity | Best-in-class local-first session memory. Copy the format philosophy (tree not linear, summaries as first-class entries). |
| 6 | Unified provider abstraction (one message model, per-provider `Api` interface, auth-aware model discovery, per-request key resolution for OAuth refresh) | Pi `packages/ai` | BORROW shape | Sovereignty | AImy needs local-first + opt-in cloud; take the `convertToLlm` boundary and dynamic key resolution. Do NOT take the 49-provider sprawl — providers should be installable modules. |
| 7 | Checkpoint store (shadow git, transparent, LLM-invisible, shared content-addressable dedup) | Hermes `tools/checkpoint_manager.py` | BORROW | Sovereignty | Superb plumbing for a local-first agent that mutates files. User-owned, offline, recoverable. |
| 8 | Verification evidence ledger (passive evidence, never upgrades targeted checks to "repo green", bounded nudges) | Hermes `agent/verification_evidence.py` | BORROW pattern | Continuity (honesty) | Exceptional honesty engineering; directly serves "no hallucinating, real-world verification." |
| 9 | Content-fingerprinted memory/skill node ids (list shifts can't delete the wrong entry) | Hermes learning graph (#119668) | BORROW | Continuity | Concrete bug-avoidance pattern worth taking verbatim. |
| 10 | JSONL event stream + RPC-over-stdio (one event stream → TUI, JSON, RPC, SDK) | Pi | BORROW | Adaptive | Cheapest integration surface for a modular platform; AImy's desktop companion wants exactly this. |
| 11 | Aux-model routing (each background task on its own provider/model) | Hermes `agent/auxiliary_client.py` | STUDY | Sovereignty, Continuity | Key cost/sovereignty enabler: background cognition on cheap local models, foreground on the best. Design in from day one. |
| 12 | Idle-gated background scheduling (never fight the user's GPU; session coalescing) | Hermes `review_idle_queue.py` | BORROW | Sovereignty | Directly applicable to local-first reality. |
| 13 | SKILL.md package format (frontmatter + `references/`/`templates/`/`scripts/` progressive disclosure) | Hermes (community standard) | BORROW | Adaptive | Close to the emerging ecosystem standard — compatibility is a feature, and it's not Hermes's invention. |
| 14 | Per-project trust UX (explicit trust decision, trust store) — paired with REAL sandboxing | Pi project trust | STUDY | Sovereignty | Copy the UX pattern and the honesty ("not a security boundary"); AImy must add the boundary Pi lacks. |
| 15 | Fail-closed, profile-scoped secret reads (ambient process state is a confused-deputy vector) | Hermes (#93522) | STUDY | Sovereignty | Critical discipline for any multi-profile design. |
| 16 | Learning timeline UX ("learning made visible" + journey graph, archive-on-delete) | Hermes | BORROW pattern | Continuity | The trust UX AImy's honesty pillar needs — but with AImy's own visual/interaction design. |
| 17 | Iron-proxy egress pattern (opaque tokens in sandbox, key swap at network boundary) | Hermes (#30179) | STUDY | Sovereignty | Elegant sandboxing pattern for code execution; note it's opt-in/off-by-default — the right posture. |
| 18 | Frozen-snapshot memory at session start (prefix-cache intact) + cross-process lock + drift guard | Hermes memory store | BORROW | Continuity | Pure plumbing, genuinely good engineering. |

**Explicitly AVOID:** Pi's npm packages as a foundation (breaking subpath exports days after v1.0 — #10359; experimental `pi-durable`/`pi-env`/`chord`/`pi-server` are moving targets); Pi's in-process full-permission extensions; Pi's default-on install telemetry; Hermes's runtime core (agent loop + gateway + 40-provider catalog + desktop — cloud-shaped, Nous-coupled); Hermes's review/curator prompt text (their soul); Hermes's binary gateway auth; both projects' default-on network fallbacks (keyless MCP, managed modes).

---

## Repo 1: Pi — `github.com/earendil-works/pi`

**Identity:** terminal AI agent by Earendil (Mario Zechner). Monorepo, TypeScript (Bun/Node), MIT. v1.0.4 surveyed (v1.0.0 released 2026-10-01; commit `eb326d2`). ~113k stars / ~14.3k forks / 287 open issues at survey time. Canonicality verified via npm (`@earendil-works/pi-coding-agent` 1.0.4 declares `git+https://github.com/earendil-works/pi.git`) and pi.dev links. Community forks (`hireasonjun/pi`, ports) are not canonical. Design motto: *primitives, not features* — a minimal agent harness.

### a. Architecture map

**`@earendil-works/pi-agent-core` (`packages/agent`)** — the generic agent runtime; small but decisive.
- `agent-loop.ts`: `runAgentLoop(...)` with an inner loop (stream response → validate+execute tool calls, sequential or parallel → hooks) and an outer loop (continues on follow-up/steering messages after the agent would stop). Steering messages typed mid-run inject after the current tool batch; follow-ups after the run would end. A message truncated on `length` fails ALL its tool calls rather than executing potentially-truncated args.
- Event-stream driven: `agent_start/agent_end`, `turn_start/turn_end`, `message_start/update/end`, `tool_execution_start/update/end`. TUI, RPC, SDK all just subscribe.
- The hook surface is the real product: `prepareNextTurn` (swap context/model/thinking between turns — compaction plugs in here), `prepareRequest`, `finishTurn`, `beforeToolCall` (block+terminate semantics — the permission-gate point), `afterToolCall` (rewrite results), `transformContext`, `convertToLlm` (must never throw), `getSteeringMessages`/`getFollowUpMessages`, `getApiKey` (per-request resolution for expiring OAuth tokens). Tool-loadout changes are declared to the model via system-message diffs so replay yields exactly the executable toolset.
- Tool result contract separates model-facing content from UI-facing details from schema-validated structured content; `AgentTool` has `replay: "never"|"safe"` for durable intent.

**`@earendil-works/pi-ai` (`packages/ai`)** — unified LLM API, ~49 providers (Anthropic, OpenAI, Azure, Bedrock, Google, Mistral, Groq, Cerebras, xAI, Ollama, llama.cpp, OpenRouter, GitHub Copilot, Meta/Muse, local Kimi, …).
- One canonical message model (system/user/assistant/toolResult with typed blocks: text, thinking, toolCall, image; thought signatures preserved for Gemini multi-turn).
- Each provider implements a small `Api` interface (`stream`/`streamSimple`); a `Models` registry does auth-aware discovery (filters by usable credentials) and dynamic key resolution with min-validity for OAuth refresh. Per-provider quirks isolated in lazy-loaded modules and generated catalogs; virtual models supported.
- Pluggable `CredentialStore`; CLI persists to `~/.pi/agent/auth.json`; OAuth device flows incl. ChatGPT, Copilot, Meta.

**`@earendil-works/pi-coding-agent` (`packages/coding-agent`)** — the CLI app and everything user-visible.
- Sessions are JSONL tree files in `~/.pi/agent/sessions/`, versioned (v3) with migrations. Every entry has `id` + `parentId`; root-to-leaf paths are branches; the leaf defines the active branch. `/tree` navigates and continues from any point (new branch, never deletes). Fork/clone copy history. Export to HTML; `/share` → gist.
- Compaction auto-triggers when `contextTokens > contextWindow − reserveTokens` (reserve default 16k); keeps recent ~20k tokens; summary stored as a `CompactionEntry`; originals preserved. Runs in `prepareNextTurn`; customizable via extensions.
- Context engineering: AGENTS.md discovery, SYSTEM.md replace/append, on-demand skills (frontmatter, `disable-model-invocation`), prompt templates, dynamic injection via extensions.
- Extensions: in-process TypeScript modules (jiti loader), discovered at cwd `.pi/extensions` (project, trust-gated) and `~/.pi/agent/extensions` (global), or via package.json `pi` manifest for npm packages. `ExtensionAPI` (~100 methods/events): tool/command/shortcut/flag registration, full lifecycle events, UI renderers, session management, model control, nested `executeTool()`. **Extensions run in the Pi process with the user's full permissions.**
- Project trust: cwd `.pi/` resources load only after an explicit per-project trust decision — documented as NOT a security boundary.
- Four automation surfaces, one engine: interactive TUI, `pi -p` print mode, `--mode json` JSONL event stream, RPC mode (JSONL over stdin/stdout), TypeScript SDK (`createAgentSession()`, incl. in-memory sessions).
- Tools: read/bash/edit/write, plus `codemode` (model-written JS calling tools, executed in a QuickJS/WASI sandbox), MCP client (stdio + Streamable HTTP), tool-search (progressive disclosure to protect prompt cache).
- Sandbox story: none by default; docs recommend containers/VMs; tools run unsandboxed with full process permissions (stated bluntly in docs).

**`@earendil-works/pi-tui` (`packages/tui`)** — own terminal UI library: differential rendering, components (Editor, ScrollView, SelectList, Markdown, Image via Kitty graphics, mouse regions), Kitty keyboard protocol, Oklch/Okhsl color pipeline, themes, native clipboard via NAPI.

**Newer/experimental:** `pi-codemode` (QuickJS sandbox), `pi-durable` (durable runtime w/ SQLite), `pi-env` (SSH execution daemon), `pi-protocol`/`pi-client` (CBOR transport), `pi-server`, `chord` (service composition), `pi-telemetry` (OTel *contracts*, not a client), `pi-evals`, `pi-mcp` (standalone MCP client).

### b. Harvest mapping

| Subsystem | Pillar | Verdict | Why |
|---|---|---|---|
| Agent-loop hook taxonomy (prepareNextTurn/prepareRequest/finishTurn/before+afterToolCall, steering vs follow-up queues, tool-diff declaration, truncated-length → fail-all) | Adaptive | **BORROW** | Cleanest lifecycle-hook vocabulary of any harness surveyed — the seam AImy's MCP modules hang off. |
| Event-stream AgentEvent contract | Adaptive | **BORROW** | One stream → four interfaces (TUI/JSON/RPC/SDK). Reimplement our events, take the lifecycle shape. |
| pi-ai provider abstraction (one message model, Api-per-provider, auth-aware Models registry, per-request `getApiKey`) | Sovereignty | **BORROW shape** | Local-first + opt-in cloud needs exactly this; take the `convertToLlm` boundary + OAuth-refresh key resolution. |
| 49-provider sprawl | — | **AVOID** | Keep providers as installable modules, not in-tree core. |
| Session tree (JSONL, parentId chains, branch/continue/fork, versioned migrations, compaction entries preserving originals) | Continuity | **BORROW** | Best-in-class local-first session memory. Copy the format philosophy. |
| Compaction mechanics | Continuity | **STUDY** | Mechanism right, implementation is a known bug farm (see pitfalls). Reimplement with reasoning-token awareness from day one. |
| Extension system (API shape: events + registrations + renderers, manifest `pi` field) | Adaptive | **STUDY** | Learn the surface shape; do NOT copy in-process full-permission execution — AImy's extensions must be out-of-process w/ capability manifest. |
| Project trust UX | Sovereignty | **STUDY** | Copy the UX pattern + the honesty ("not a security boundary"); AImy adds the actual boundary. |
| MCP client (stdio + Streamable HTTP) | Adaptive | **BORROW** | Fine reference; note it lags the spec (#10416) — target newest MCP from the start. |
| codemode (model-written JS, QuickJS/WASI sandbox) | Adaptive | **STUDY** | Right idea for parallel tool composition; cautionary tale — a "sandbox" that can crash the host (#10444). |
| Four modes (TUI/print/JSON/RPC/SDK) | Adaptive | **BORROW** | JSONL event stream + RPC-over-stdio is the cheapest modular integration surface. |
| pi-tui library | — | **STUDY** | Study differential rendering; don't drag the TUI tree into AImy ("graphically stunning" ≠ terminal). |
| pi-telemetry OTel contracts | — | **STUDY** | Contracts-not-vendors is a good pattern for the honesty value. |
| pi-durable / pi-env / chord / pi-server | Adaptive | **AVOID** | Experimental, churning, cloud-ish. Reassess in 6 months. |
| Install telemetry (`pi.dev/api/report-install`, default-on) | Sovereignty | **AVOID** | Directly violates the sovereignty pillar. Any AImy update check must be opt-in, never default-on. |

### c. Pitfall mining (selection — full numbered list in `/tmp/pi-decomp.md`)

- **#10426** (open): `codemode.mode: "only"` only *hides* tools from the model — an LLM that knows the name can still execute. Disclosure ≠ enforcement; gates must be at execution.
- **#10291** (closed): MCP OAuth tokens in plaintext `mcp-auth.json`, readable by the agent itself. → OS keychain/secret-store only.
- **#10444** (closed): codemode script set `Array.prototype.toJSON` and crashed the host — sandbox prototypes leak. Membrane must be airtight.
- **#9824** (closed): Extension `ctx` "read-only" wasn't actually read-only. Don't trust TS `readonly` for security boundaries.
- **#5514** (closed, 26 comments): Project Trust UX iteration thread — read before designing AImy's trust prompts. **#8384**: post-merge security audit of the trust surface.
- **#9409** (open): sessions wedge at context ceiling on reasoning models — `estimateTokens()` can't see reasoning tokens, compaction never fires, `length` loops forever. **Design context accounting with reasoning tokens from day one.**
- **#9602 / #9512 / #9051 / #6879**: the compaction bug farm (thinking-message overflow, summary caps, missed retries, never-triggered auto-compaction). Treat compaction as adversarial; property-test.
- **#9930** (closed): a metadata entry became session leaf, silently truncating history → property-test session-tree invariants.
- **#5886** (open): continuation-lifecycle bugs; RPC hosts see `agent_end` before true settlement. **Define "settled" precisely; never emit completion before settlement.**
- **#9340** (closed): `abort()` could trigger auto-compaction after cancellation — teardown ordering matters.
- **#8584** (closed): TUI row corruption during long streams; **#6665** (open): full core pinned while streaming (uncached `Intl.Segmenter` + per-chunk Markdown rebuild); **#7730** (open): superlinear CPU on macOS with long sessions — profile long histories.
- **#10504** (open): split ANSI sequences corrupt retained bash output → sanitize terminal output before it enters the transcript.
- **#10359** (closed): `pi-agent-core` 1.0.0 dropped all subpath exports days after release, breaking extensions. **Do not depend on Pi's npm packages as a foundation.**
- **#10502** (open): provider `strict` flags leak through the "unified" API; **#9444** (open): Gemini thought-signature drops across providers — the abstraction leaks at edges; test cross-provider quirks explicitly.
- **#10416** (open): MCP only through 2025-11-25 spec; 2026-07-28 unsupported. **#10562/#10526** (open): one hanging MCP server blocks `/mcp` up to 60s → isolate MCP startup with timeouts; never let one server block the fleet.
- **#5653** (closed): shrinkwrap pinning fights supply-chain drift; **#10273/#10288** (closed): pinned tree shipped vulnerable `brace-expansion` twice — pinning buys reproducibility, you own the CVE watch.
- **#10519** (open): Nix package reordered PATH, breaking the agent's own tools → installers must never mutate the user's environment.
- **#8928** (open): OAuth token-refresh races under parallel startup → serialize refresh.
- **#2870** (closed): Pi hardcodes `~/.pi`, ignores XDG. → Respect XDG from day one (sovereignty = user controls file layout).
- **#10585** (open): tool I/O errors (`ENOSPC` on full /tmp) crash the process → catch at the tool boundary, never propagate.

### d. License, dependencies, telemetry

- **MIT everywhere** (root + all packages; `pi-evals` has no license field — check before touching). Direct deps all permissive (`typebox`, `jiti`, `undici`, `proper-lockfile`, `yaml`, `chalk`, `diff`, `highlight.js`, `minimatch`, `semver`, `cross-spawn`, `quickjs`/`quickjs-wasi`, `@silvia-odwyer/photon-node` (Apache-2.0 — attribution required, easily droppable)). No GPL/AGPL in the direct tree. Caveat: only direct deps scanned — run `license-checker` before vendoring anything.
- **Phone-home, confirmed in code:** `reportInstallTelemetry()` fires `fetch("https://pi.dev/api/report-install?version=...")` on **every version upgrade** unless `PI_OFFLINE` is set; `enableInstallTelemetry` defaults **true**; `provider-attribution.ts` injects `HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi` etc. into provider requests when telemetry is on. No analytics SDKs (Segment/Sentry/PostHog); `pi-telemetry` is OTel contracts only; `enableAnalytics` defaults false. **Verdict: the default-on install ping + attribution headers are the anti-pattern — explicitly do not replicate.**

---

## Repo 2: Hermes Agent — `github.com/NousResearch/hermes-agent`

**Identity:** "The self-improving AI agent" by Nous Research. Python, MIT, released Feb 2026, ~249k stars. Surveyed at commit `0e37a439`. Note: despite the modern README, the codebase shows clear OpenClaw lineage (file names, config shapes, gateway design) — Hermes is a fork/evolution of OpenClaw with Nous infrastructure layered on. **Strategic frame:** Hermes is AImy's closest conceptual rival ("the agent that grows with you"). Directive applied: decompose for KNOWLEDGE; do not adopt the runtime as AImy's core.

### a. Architecture map

**1. The learning loop (headline feature).** Two cooperating autonomous mechanisms, both guarded:
- **Per-turn background review** (`agent/background_review.py`, ~1364 lines): after every turn, `AIAgent.run_conversation` may spawn a daemon thread forking a new `AIAgent` that replays a conversation snapshot and asks "should any skill/memory be saved or updated?" Writes go to memory + skill stores; the main conversation and prompt cache are untouched. The fork inherits the parent's runtime (provider, model, credentials, cached system prompt) for prefix-cache hits, and runs under a dispatch-side tool whitelist.
- Safety engineering (instructive): foreground priority — a new live turn cancels an in-flight review (bounded 2s cancel handshake; if the fork doesn't ack, the live turn proceeds anyway); reviews routable to a *cheaper* model (`auxiliary.background_review.*`), replaying a compact digest instead of the full snapshot when routed elsewhere; aggregate input-token budget (75% of review model's window, capped 600k); **managed-local-GPU awareness** (`agent/review_idle_queue.py`) — on the managed llama-server the review fork would monopolize the GPU the next prompt needs, so reviews queue until idle (15s settle, 30-min max age), one slot per session with newest-snapshot-wins coalescing; explicit `/refine` never defers.
- **Unattended-write safety** (`tools/memory_tool.py::_background_delete_gate`): a fork running unattended may `add` memories but `replace`/`remove` are *never applied unattended* — staged for human approval in a pending store (`/memory pending`). Fail-closed: staging failure degrades to plain denial. Every write carries provenance metadata (origin, execution context, session, platform).
- **The review prompts are the real IP** — three embedded templates with remarkable anti-failure design: a memory-routing block (two stores — USER.md for *who the user is* vs MEMORY.md for *environment facts*; "one fact goes to ONE store, never both"); a lesson-layer "shape contract" (skills are procedure-first class-level instructions; pitfalls as "generalizable rule + one clause of WHY"; no PR numbers/dates/quotes as content; search-before-add; never restate what the environment already teaches; fix wrong skills in place); a do-not-capture block (no environment-dependent failures, no negative tool claims that harden into self-cited refusals, no transient errors, no unresolved failures dressed as validated guidance). Preference order: patch loaded skill → patch umbrella → add support file → create class-level umbrella. Protected skills (bundled, hub-installed, pinned, user-owned) are off-limits to autonomous forks.
- **The curator** (`agent/curator.py`, ~1200 lines): background skill-library maintenance, inactivity-triggered (default 7-day interval, 2h min idle; enabled by default, pausable). Deterministic lifecycle transitions (active → stale at 14d → archived at 30d; never delete, only archive; pinned/cron-referenced bypass) plus an opt-in LLM consolidation fork that builds class-level umbrellas. Cron references rewritten to follow consolidations; dry-run report mode exists.
- **Learning timeline** (`agent/learning_graph.py` + `learning_mutations.py`, `hermes journey` / `/journey`): skills + memory chunks as graph nodes; users can edit/delete nodes; memory node ids are content-fingerprinted so list shifts can't delete the wrong entry; deleting a skill archives it (restorable).

**2. Memory system.** Built-in store: two Markdown files in `~/.hermes/memories/` (MEMORY.md = environment facts, USER.md = user profile); single `memory` tool with add/replace/remove + atomic batch. Both enter the system prompt as a **frozen snapshot at session start** (prefix cache intact; mid-session writes hit disk only). `§`-delimited entries; byte-identical copies collapsed; char limits; cross-process file lock; drift guard with `.bak` snapshot + refusal on failed round-trip. Pluggable external providers (`agent/memory_provider.py` + `plugins/memory/`: byterover, holographic, openviking, retaindb — ONE at a time) with lifecycle (initialize → prefetch → sync_turn → shutdown); background jobs must propagate contextvars. Write approval gates; unattended forks can only stage deletions. Recall indicator glyph (🧠) in UI showing what prefetch injected. Multi-profile scoping: HERMES_HOME is context-local; every secret/env read is profile-scoped.

**3. Skill registry/format.** Directories with `SKILL.md` (YAML frontmatter: name, description, version, author, license, platforms, prerequisites) + progressive-disclosure `references/`/`templates/`/`assets/`/`scripts/` (loaded only via explicit view). Scopes: bundled, profile, external dirs, hub-installed, agent-created (curator-managed). Discovery: skill index (name + description, truncated to 57 chars in the system prompt) injected at session start. Management: `skill_manage` (create/patch/edit/write_file/remove_file/delete + read-before-write enforcement), usage ledger (counts, timestamps, lifecycle, provenance, pinning), audit trail with actor tags, curator-managed vs user-owned provenance. Large bundled + optional catalog.

**4. Messaging gateway** (`gateway/`). One process owning sessions across transports: Telegram, Discord, Slack, WhatsApp (cloud + sidecar), Signal, WeChat, QQBot, BlueBubbles, Graph webhooks, webhook ingress, TCP, API server. Platform adapter contract (`BasePlatformAdapter` + `ctx.register_platform()`; new platform = `plugin.yaml` + `adapter.py`, zero core changes). Access policy: DM policy (open|allowlist|disabled|pairing), group policy, allowlists — but **binary**: authorized users get everything, blocked get nothing. Session persistence: SQLite (WAL, FTS5, parent_session_id chains, delivery ledger, heartbeat). Cron scheduler with job definitions, delivery queue, detached workers.

**5. Multi-agent.** Correction: "teams of specialist agents" is NOT a feature — `teams_pipeline` is a Microsoft Teams meeting-summary plugin. Real machinery: async `delegate_task(background=true)` on a daemon executor (results surface as a new turn, never mid-turn; de-dup + crash recovery); `/review` spawns an independent full-privilege background subagent; hosted gateway rooms (nascent multi-party surface). The background-review and curator forks are the primary forked-agent patterns.

**6. Sessions/checkpoints/profiles.** Profiles = config workspaces (`~/.hermes`/HERMES_HOME, context-local override); one multiplexed gateway serves many profiles; every secret/env read profile-scoped. Checkpoints (`tools/checkpoint_manager.py`): transparent filesystem snapshots via a single shared shadow git store — automatic snapshots before file-mutating ops, once per turn, LLM-invisible, content-addressable dedup across projects, no git state leaking into project dirs, auto-prune. Sessions: SQLite + FTS5, compaction/compression modules, stall detection, prompt pins (P0 bug #126167: pins lost across synthetic turns).

**7. Self-verification.** Evidence ledger (`agent/verification_evidence.py`): records what the agent *actually proved* — deliberately passive (never runs suites, never blocks, never upgrades targeted checks into "repo green"); parses terminal invocations for test/lint/typecheck/build evidence; 30-day expiry. Verification-stop nudge: round-end `pre_verify` gate rides on an evidence-based "missing verification evidence" nudge (bounded, max 3 consecutive) rather than a hard second gate. Verify runner executes project recipes with `shell=True` (same trust level as terminal — explicit choice). Caveat: #96704 notes nothing varies a skill/memory entry and measures downstream outcome — the headline feature is unevaluated.

**8. API server + model providers.** HTTP API (sessions, runs, OpenAI-compatible routes, memory sessions, room dispatch with grants); dashboard/webhook auth; ACP adapter; MCP serving; TUI gateway; desktop app. Provider registry (global + per-scope, plugin snapshot/restore); ~40 provider plugins; auxiliary model routing per background task (the cost mechanism that makes the learning loop affordable); context-window/catalog handling.

### b. Harvest mapping

| Subsystem | Pillar | Verdict | Why |
|---|---|---|---|
| Background-review fork (fork-after-turn, whitelist, cancel protocol, aux routing, idle queue) | Continuity | **STUDY** | Best mechanism design in the repo. Study the architecture; write our own prompts. |
| Unattended-write safety (add-only unattended; replace/remove staged; fail-closed) | Continuity, Sovereignty | **BORROW pattern** | Foundational trust machinery; reimplement cleanly. |
| Review-prompt anti-failure rules (do-not-capture, lesson shape, memory routing, read-before-write) | Continuity | **STUDY** | Highest-value knowledge artifact. Internalize the failure taxonomy; don't copy the text. |
| Curator lifecycle (active→stale→archived, never delete; pinning; cron protection; inactivity-triggered) | Continuity | **STUDY** | State machine is borrow-worthy as a pattern; but the LLM umbrella-consolidation pass ate active skills (#29912) — AImy's curator must be deterministic-first, LLM-proposes/human-disposes. |
| Learning timeline graph (content-fingerprinted ids, journey UI, archive-on-delete) | Continuity | **BORROW pattern** | "Learning made visible" is the trust UX AImy needs — with our own design. |
| Two-store memory routing (USER.md vs MEMORY.md) | Continuity | **STUDY** | Distinction is right and battle-tested; but AImy's memory schema is its soul — design our own stores. |
| Frozen-snapshot memory + file lock + drift guard | Continuity | **BORROW** | Pure plumbing, good engineering. |
| Memory provider plugin contract | Adaptive | **STUDY** | Aligns with MCP-module philosophy, but Hermes allows ONE external provider and the builtin is file-based — too limited; design a richer multi-provider contract. |
| SKILL.md package format | Adaptive | **BORROW** | Community-standard shape; compatibility is a feature. |
| Skill usage ledger + provenance | Continuity, Adaptive | **STUDY** | Good machinery; but "user-owned skills off-limits to autonomous writes" needs a more collaborative design for AImy's self-developing-skills vision. |
| Gateway platform adapter contract | Adaptive, Sovereignty | **STUDY** | Right plugin shape for AImy modules; do NOT adopt the gateway — built for cloud messenger bots with binary auth, opposite of local-first companion. |
| Access-policy mixin | Sovereignty | **STUDY lessons / AVOID as-is** | Fail-closed scoping lesson is critical (#93522); binary auth is a known gap (#527) — AImy ships tiered permissions from day one. |
| Checkpoint system (shadow git) | Sovereignty | **BORROW** | Superb local-first plumbing. Take the design nearly verbatim. |
| Session store (SQLite WAL, FTS5, compression chains) | Continuity | **STUDY** | Solid; but design AImy's continuity around MCP modules, not Hermes's schema. |
| Verification evidence ledger + stop nudge | Continuity (honesty) | **BORROW pattern** | Passive evidence, no global-claim upgrades, bounded nudges — borrow the principle, write our own. |
| Aux-model routing | Sovereignty, Continuity | **STUDY** | Background cognition on cheap local models = sovereignty win. Design in from day one. |
| Idle-gated review queue | Sovereignty | **BORROW** | Background learning must never fight the user's GPU. |
| Provider registry (40 cloud plugins) | Adaptive | **STUDY** | Good pattern for module-scoped providers; don't adopt the cloud-catalog shape — AImy is local-first with opt-in cloud. |
| Cron scheduler | Adaptive | **STUDY** | Needed for the ambient role; Hermes's is gateway-entangled — study the job/delivery-queue model, build our own. |
| Delegation rail (async subagent, new-turn results, de-dup, crash recovery) | Adaptive | **STUDY** | Solid pattern for module orchestration. |
| Iron-proxy egress firewall | Sovereignty | **STUDY** | Elegant sandboxing pattern; opt-in/off-by-default is the right posture. |
| Desktop app / TUI / dashboard / ACP adapter | — | **AVOID** | Massive cloud-coupled surface; borrowing the UI stack is how you become "Hermes but prettier." AImy's UX is its soul. |
| Nous managed modes (managed tool gateway, keyless MCP free tiers, guest auth, Nous provider) | — | **AVOID** | Explicitly anti-sovereign. Default-on keyless fallbacks exfiltrate queries — AImy's defaults must be local-only. |
| SOUL.md persona file | — | **AVOID** | Literally their soul. AImy's presence/personality is the highest differentiation surface. Nothing to take. |

**Differentiation risk flags** (where borrowing ⇒ "Hermes but prettier"): (1) the learning loop as marketed — Hermes optimizes workflow efficiency; AImy's loop must optimize **honesty and verification**, paired with the eval harness Hermes lacks (#96704), so AImy can claim "learned skills are *measured* to help"; (2) the review prompt text — accumulated scar tissue as prose, cloning it = cloning their soul; write from the failure taxonomy; (3) the MEMORY.md/USER.md + journey UX — AImy needs its own memory interaction design; (4) the gateway — AImy's presence surface must not be a gateway skin; (5) the runtime is deeply cloud/Nous-coupled — adopting it imports ~40 cloud integrations and managed defaults contradicting sovereignty.

### c. Pitfall mining (selection — full numbered list in `/tmp/hermes-decomp.md`)

- **#6051** (closed): skill auto-creation fossilized a transient Playwright failure into persistent tool avoidance ("learned helplessness"). Prompt-level fix shipped; the class remains — *learning loops fossilize transient state unless prompts explicitly forbid environment-dependent facts*; version/time-bound learned env facts.
- **#25833** (open, P2): self-created skills lack mechanism-level correctness guarantees — agent is simultaneously author, executor, and inspector. **Single most important architectural lesson: the learning loop needs an independent verification arm** (tests/evals/second-model critic) between "skill written" and "skill trusted."
- **#96704** (open): RFC for skill evals — "nothing varies a skill or memory entry and measures the downstream task outcome." **Build the eval arm WITH the loop, not after.**
- **#29912** (closed, P1): curator archived 10 active skills in one umbrella pass with zero verified consolidations — fail-open. Archive must require verified absorption; LLM proposes, evidence gate disposes.
- **#68248** (closed): attempt at skill-outcome evaluation + curator feedback — read the implementation before designing AImy's.
- **#2045 / #49967** (open): full skill listing in system prompt is a per-turn token tax; skill *index* design (always-loaded vs on-demand) is a first-order cost decision.
- **#30220**: reviewer wrote the same fact into both memory stores until both hit limits — one fact, one store; enforce in prompt AND tool (Hermes does prompt-only — a gap AImy can close with a classifier).
- **#119668**: unlocked read-modify-write dropped concurrent writes and reformatted hand-edited files; list shifts broke journey-graph edits. **File-based memory needs all three: cross-process lock + drift guard + content-fingerprint ids.**
- **#34352** (open): memory operations bypass the hook system — multi-tenancy impossible without forking core. **Put memory behind the hook/permission system from day one.**
- **#47349** (open): builtin file store not cleanly separable. **Design memory as a backend interface from the start.**
- **#65592** (open, security): approval-dialog bypass — after denying a dangerous command, the model retried via `execute_code`; direct Python calls never pass through `terminal()`. Defenses: dispatch-layer BLOCKED halt + AST scanner. **AImy rule: denial kills the intent, not the tool call; every code-execution path needs the same gate.**
- **#61882** (open, security): cold-start with stale env silently ran on the HOST instead of the configured Docker container. **Sandbox selection must be fail-closed; "config not loaded" never means "run on host."**
- **#121573** (open, security): env-wrapper/alias paths evaded the dangerous-command detector. **Resolve the effective executable + canonical path in the actual backend, not string-match.**
- **#527** (open, P2): gateway auth is binary — authorized chat user = full terminal access. **Tiered capabilities from day one.**
- **#93522**: multiplexed gateway — secondary profile must never inherit the default profile's env opt-in. **Profile-scope all secret reads, fail closed.**
- **#126167** (open, P0): prompt pins lost across synthetic turns — security-relevant prompt content must survive every session transform; test pins across all transforms.
- **#30179** (closed): iron-proxy egress firewall — opaque tokens in sandbox, real keys swapped at network boundary. Elegant; study it.
- **#130909** (open, P0): compaction breaks the prompt cache every time — silent cost multiplier. **Design compaction cache-prefix-stable.**
- **#102117** (closed) + **#78647**: "whole-codebase simplification" −34% LOC; godfile eradication campaign. **Enforce module size budgets early.**
- **#68499** (open, 173 comments): conflating subagent lifecycle with task outcome → cascading bugs. **Keep lifecycle state machines and outcome records separate.**
- **#128757** (open, P0): model switches silently invalidate caches — **make switches explicit, costed, confirmed.**
- **#128305** (open) / **#132361** (closed): self-update is a reliability minefield — treat the updater as safety-critical or avoid auto-update initially.

### d. License, dependencies, telemetry

- **MIT** (LICENSE "Copyright (c) 2025 Nous Research"; `pyproject.toml` `license = "MIT"`). Direct deps permissive (openai, httpx, pydantic, fastapi, uvicorn, rich…). Flags for a full audit before vendoring: `browser-harness==0.1.13` and `nemo-relay` licenses unverified; the vendored `optional-mcps/`/`optional-skills/` tree not individually audited. `iron-proxy` is Apache-2.0 (fine).
- **No hidden product analytics found** in the runtime path, but documented network edges that violate local-first defaults: managed tool gateway defaults to `nousresearch.com` passthroughs (documented opt-in); `web.keyless_fallback` (**default ON**) sends web-search queries to free-tier third parties (Exa, Parallel, Firecrawl, Keenable) — queries are user data; Nous provider free tier + guest auth prominent; session-trace upload to Hugging Face is explicit user action, private-by-default, secret-redacted (fine). **Sovereignty verdict: code is honest about its network edges, but defaults assume a cloud-connected user. AImy must invert the defaults — local-only out of the box, every egress an explicit opt-in with stated data flow.** The `managed_nous_tools_enabled` gate pattern is a good model for structuring such opt-ins — study it, build AImy's with the opposite default.

---

## Combined "pitfalls to avoid" checklist

Organized by theme. Every item is a scar someone else already earned — design AImy so none of these are re-learned.

### Learning loop & skill system
- [ ] **Learned helplessness:** learning loops fossilize transient failures into permanent avoidance. Forbid capturing environment-dependent facts in review prompts; version and time-bound learned env facts. (Hermes #6051)
- [ ] **No independent validation of self-written skills:** author = executor = inspector is a structural defect prompt-mitigations can't fix. Build an independent verification arm (tests/evals/second-model critic) between "skill written" and "skill trusted" — **with the loop, not after**. (Hermes #25833, #96704, #68248)
- [ ] **Curator fail-open:** never let an LLM consolidation pass archive/absorb on model assertion alone. Deterministic transitions automatic; LLM proposes; evidence gate (or human) disposes. Archive must require verified absorption. (Hermes #29912)
- [ ] **Skill-index token tax:** decide always-loaded vs on-demand skill discovery as first-order architecture. Full listing in the system prompt is a per-turn tax. (Hermes #2045, #49967)
- [ ] **Memory-bloat equilibrium:** "be active" review bias vs curator archival is fragile. Budget memory as currency — explicit budgets per store with eviction policy — not prompts-vs-curator tug-of-war.

### Memory & context
- [ ] **Reasoning-token blindness:** context accounting that can't see reasoning tokens lets sessions wedge at the ceiling with compaction never firing. Account for reasoning tokens from day one. (Pi #9409)
- [ ] **Compaction is the buggiest subsystem:** treat it as adversarial — property-test thresholds, summary caps, retry paths, and cross-provider behavior. (Pi #9602, #9512, #9051, #6879)
- [ ] **One fact, one store:** misrouted memories bloat both stores to their limits. Enforce routing in the prompt AND in the tool (classifier), not prompt-only. (Hermes #30220)
- [ ] **File-based memory needs all three:** cross-process lock + drift guard (refuse on failed round-trip) + content-fingerprinted node ids. (Hermes #119668)
- [ ] **Memory behind the permission system from day one:** retrofitting multi-tenancy around a memory layer that bypasses hooks requires forking core. (Hermes #34352)
- [ ] **Memory as a backend interface, not a file everything reads directly.** (Hermes #47349)
- [ ] **Compaction must be cache-prefix-stable:** a cache break per compaction is a silent cost multiplier. (Hermes #130909)
- [ ] **Property-test session-tree invariants** (a metadata entry once became a leaf and silently truncated history). (Pi #9930)
- [ ] **Define "settled" precisely; never emit completion before settlement.** Post-run logic continuing from non-continuable transcripts is a whole bug class. (Pi #5886)
- [ ] **Teardown ordering:** cancellation must not trigger post-cancel side effects (e.g., auto-compaction after abort). (Pi #9340)

### Security & trust boundaries
- [ ] **Disclosure ≠ enforcement:** hiding a tool from the model doesn't stop execution. Permission gates enforced at execution, never in the prompt. (Pi #10426)
- [ ] **Credentials never in plaintext files the agent can read.** OS keychain / secret-store only. (Pi #10291)
- [ ] **Sandbox membranes must be airtight:** prototype leaks (Array.prototype.toJSON crashing the host) are the shape of failure. (Pi #10444)
- [ ] **Language-level `readonly`/`private` is not a security boundary.** (Pi #9824)
- [ ] **Denial kills the intent, not the tool call:** after a denial, the model must not retry via a different tool; every code-execution path (REPLs, script runners, FFI) needs the same policy gate. (Hermes #65592)
- [ ] **Sandbox selection fail-closed:** "config not loaded / stale env" must never silently run on the host. (Hermes #61882)
- [ ] **Resolve the effective executable + canonical target path in the actual execution backend** — string-matching command names is evaded by env-wrappers, aliases, relative paths. (Hermes #121573)
- [ ] **Tiered capabilities from day one:** binary auth (authorized = full terminal) is a non-starter for a shared/ambient companion. (Hermes #527)
- [ ] **Ambient process state is a confused-deputy vector:** profile-scope every secret/env read, fail closed; secondary profiles must never inherit the default's opt-ins. (Hermes #93522)
- [ ] **Security-relevant prompt content (pins, policies) must survive every session transform** — compaction, synthetic turns, model switches. Test explicitly. (Hermes #126167)
- [ ] **Study the iron-proxy pattern:** opaque tokens inside the sandbox, real keys swapped at the network boundary; off-by-default. (Hermes #30179)
- [ ] **Pair trust UX with real boundaries:** Pi's honest "project trust is not a security boundary" is the lesson — AImy's trust prompts must sit atop actual sandboxing. (Pi #5514, #8384)

### Dependencies, packaging & API stability
- [ ] **Don't build on Pi's npm packages:** subpath exports were dropped days after v1.0, breaking downstream extensions. Treat the 1.0 line as unstable API surface. (Pi #10359)
- [ ] **Experimental subsystems are moving ground:** Pi's durable/env/chord/server — reassess in 6 months, don't found on them.
- [ ] **Pinning buys reproducibility, you own the CVE watch:** shrinkwrap-pinned trees shipped vulnerable transitive deps twice. (Pi #5653, #10273, #10288)
- [ ] **Self-update is safety-critical:** treat the updater as such, or ship without auto-update initially. (Hermes #128305, #132361)
- [ ] **Provider abstractions leak at the edges:** strict-mode flags, thought signatures, per-provider quirks. Test cross-provider behavior explicitly; budget per-provider retry/backoff quirks. (Pi #10502, #9444, #4945)
- [ ] **Target the newest MCP spec from the start** (Pi lags at 2025-11-25 — #10416); **isolate MCP server startup with timeouts** — one hanging server must never block the fleet. (Pi #10562, #10526)
- [ ] **Token-refresh races:** serialize OAuth refresh under concurrency. (Pi #8928)
- [ ] **Installers must never mutate the user's environment** (PATH reordering broke the agent's own tools). (Pi #10519)

### Sovereignty defaults
- [ ] **No default-on telemetry, ever.** Pi's default-on install ping + attribution headers are the anti-pattern. Any update/phone-home check is opt-in, stated, and off by default.
- [ ] **No default-on network fallbacks.** Hermes's default-on keyless MCP fallbacks exfiltrate query content to third parties. AImy: local-only out of the box; every egress an explicit opt-in with a stated data flow.
- [ ] **Invert the managed-mode default:** study Hermes's `managed_*_enabled` gate pattern, ship AImy's with the opposite default.
- [ ] **Respect XDG base directories** — hardcoded `~/.aimy` repeats Pi's #2870. Sovereignty includes the user's file layout.

### Performance & codebase hygiene
- [ ] **Background cognition gets its own scheduling class** on local hardware — never let learning forks fight the user's GPU; coalesce per session. (Hermes `review_idle_queue.py`)
- [ ] **Streaming renderers:** don't rebuild Markdown per chunk; cache segmenters; differential rendering is fragile under long streams. (Pi #8584, #6665)
- [ ] **Profile with long histories:** session growth has superlinear costs somewhere. (Pi #7730)
- [ ] **Sanitize terminal output before it enters the transcript** (split ANSI corruption). (Pi #10504)
- [ ] **Enforce module size budgets early:** Hermes needed a dedicated −34% LOC godfile-eradication campaign. (Hermes #102117, #78647)
- [ ] **Keep lifecycle state machines and outcome records separate.** Conflating them caused 173 comments of cascading bugs. (Hermes #68499)
- [ ] **Model switches explicit, costed, confirmed** — silent switches invalidate caches and change behavior. (Hermes #128757)

---

## License & dependency summary

| | Pi (`earendil-works/pi`) | Hermes (`NousResearch/hermes-agent`) |
|---|---|---|
| License | MIT (all packages; `pi-evals` has no license field — check before use) | MIT |
| Direct deps | All permissive; one Apache-2.0 (`photon-node`, droppable); no GPL/AGPL found | All permissive; `iron-proxy` Apache-2.0 (fine) |
| Audit gaps | Transitive tree not scanned — run `license-checker` before vendoring | `browser-harness`, `nemo-relay`, and the vendored `optional-mcps/`/`optional-skills/` tree not individually audited |
| Phone-home | **Default-on** install telemetry (`pi.dev/api/report-install` per upgrade, `PI_OFFLINE` opt-out) + provider attribution headers; no analytics SDKs | No hidden analytics; but **default-on** keyless MCP fallbacks (Exa/Parallel/Firecrawl/Keenable), Nous managed gateway + free-tier provider prominent |
| Sovereignty posture | Honest docs, hostile default (telemetry on) | Honest code, cloud-assuming defaults |

Both are MIT-compatible with AImy's planned open-source posture. Neither can be vendored blindly on telemetry grounds — AImy must invert both projects' network defaults.

---

## Method notes & caveats

- Two child agents worked in parallel, one per repo: shallow clones (`--depth 50`), direct code reading of the subsystems above (not README-only), GitHub REST API for issues/PRs (unauthenticated; public data). Issue coverage is a survey of high-signal open issues plus targeted searches (security, memory, curator, compaction, learning-loop) — deep, not exhaustive.
- Quoted material from code/docs is kept to short fragments; this report is original summarization of MIT-licensed material.
- Known gaps: Pi's transient dependency tree and the long trust-feedback (#5514) / shrinkwrap (#5653) threads were not read in full — worth reading during AImy's design phase. Hermes's gateway internals, cron scheduler, and desktop/TUI were skimmed only. Hermes's `optional-mcps/`/`optional-skills/` licenses unaudited.
- Correction discovered during decomposition: Hermes has no "teams of specialist agents" feature — `teams_pipeline` is a Microsoft Teams meeting-summary plugin; real multi-agent machinery is async `delegate_task` + `/review` subagents + hosted rooms.
- Working notes (ephemeral, `/tmp`): `/tmp/pi-decomp.md` (20.7 KB), `/tmp/hermes-decomp.md` (38.5 KB). Copy into the workspace if they need to outlive the VM.
