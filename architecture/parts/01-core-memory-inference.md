# Part 01 — Core, Memory, Inference

*Project AImy · architecture · section 1 of N · written 2026-10-07*
*Ground truth: `~/workspace/aimy/planning/mvp-moscow.md` (v1.0 FINAL) · `~/workspace/aimy/decomposition/pi-hermes-decomposition.md` · ASC paper (`workspace/user/files/paperASC.pdf`)*
*Locked substrate: TypeScript + Effect, full bet — the whole program (UI, core logic, infra) as one Effect program. No code in this document; Effect idioms are used as the design language.*

Scope of this part: the sovereign core, the module/MCP seam, the memory system (incl. the learning loop), and the inference pool. Sibling sections own: presence/ASC detail (the ASC *engine's* internal design), the Foldkit UI shell, desktop packaging, and the web-retrieval reference module's domain logic.

---

## 1. System decomposition

### 1.1 Sovereign core modules — what we own

The core is eight named services, each an Effect `Context.Tag` with a typed interface and a `Live` layer. Nothing outside the core may touch the resources in §1.3 except through these gates. A ninth and tenth service exist because two MoSCoW MUSTs demand first-class homes: the honesty/validation layer (MUST 11) and the comms-banner channel (MUST 15). One-click export (MUST 16) is a *capability* composed over the stores, not a service.

| # | Core module | Effect service | Owns | MoSCoW MUST |
|---|---|---|---|---|
| 1 | **AgentLoop** | `AgentLoop` | The turn lifecycle we own outright (studied Pi/Hermes, adopted neither runtime). Runs the inner loop (stream → validate → execute tool calls → hooks) and outer loop (steering vs follow-up queues). Never emits `agent_end` before the *settled* definition of §3.9 (Pi #5886). | 1 |
| 2 | **MemoryService** | `MemoryService` | The only writer/reader of every memory store (session tree, long-term stores, skill store, learning graph). All access behind the permission/hook system (Hermes #34352). Memory is a backend interface, never direct file reads (Hermes #47349). | 5, 13 |
| 3 | **InferencePool** | `InferencePool` | The single manager all inference routes through. Provider/endpoint registry, powerhouse vs parallel-thread dispatch, aux-model routing, switch policy, quirk budget, egress classes. | 2, 3 |
| 4 | **ModuleHost** | `ModuleHost` | Module lifecycle (install/enable/update/remove), hook dispatch, capability-manifest enforcement, MCP client fleet, SKILL.md package handling. Modules run out-of-process; the host is the only core service that spawns them. | 8, 9 |
| 5 | **IdentityService** | `IdentityService` | Install UUID (generated locally at first install, offline-safe), per-instance keying of all state, first-party network identity (LAN pairing is a Could — designed for, not shipped), UUID-outward reporting strictly opt-in (MoSCoW tension note). | 4 |
| 6 | **SecretLocker** | `SecretLocker` | The trust anchor: encrypted-at-rest store for API keys, OAuth tokens, per-instance secrets. Backed by the OS keychain where available; AImy-side envelope encryption on top. Secrets are `Redacted` values in Effect — they never appear in logs, traces, tool args, or memory entries (Pi #10291). | 6 |
| 7 | **SafetyKernel** | `SafetyKernel` | Fail-closed permission/sandboxing. Per-tool allow/ask/deny; denial kills the *intent*, not the call (Hermes #65592); every code-execution path gated; sandbox selection fail-closed (Hermes #61882); tiered capabilities, never binary auth (Hermes #527). | 10 |
| 8 | **ASCEngine** | `ASCEngine` | The presence engine's core service boundary: L1 self-model, L2 self-monitoring (four dials, computed not chosen), L3 self-narration incl. the error term. *Detailed internal design belongs to the presence architect's section*; this part defines only the layer, its state ownership (ASC state is core state, not module state), and its read/write gates. | 12 |
| 9 | **JobRunner** | `JobRunner` | In-app scheduler for background tasks, cron jobs, long-running work. Prerequisite for background execution and the banner channel. Forks spawned through the JobRunner inherit the sovereignty posture (idle-gated on local GPU, §3.5). | 7 |
| 10 | **HonestyService** | `HonestyService` | The verification-evidence ledger (passive evidence, never upgrades targeted checks to "repo green" — borrowed pattern), ThinkingBox-style executable judges (deterministic, versioned checks → PASS/FAIL per task), and the independent verification arm that stands between "skill written" and "skill trusted" (Hermes #25833, #96704). | 11 |
| 11 | **CommsBanner** | `CommsBanner` | The in-app channel for system→user alerts (job done, cron status). Product-owner trusted broadcast *reuses* this channel under its own opt-in/audit terms (security-flaw disclosure first — a Should built on this Must). | 15 |

One-click full export (MUST 16) is a composed capability — `DataExport` — that walks `IdentityService` (UUID + identity), `MemoryService` (all stores), `ModuleHost` (installed skills/modules), and `SecretLocker` (*manifest only*: which secrets exist, never values — secrets export as re-entry prompts, never plaintext). It is a single Effect program over the same services, not a backdoor reader.

### 1.2 Borrowed substrate — what we don't own

Sovereignty = control + exit, not authorship. The substrate is replaceable by design; every item sits behind an interface the core owns:

- **Model runtimes** (llama.cpp / Ollama / vLLM / Splash / cloud APIs) — reached only through the `InferencePool`'s provider abstraction. Swapping a runtime never touches the loop, memory, or modules.
- **MCP protocol** — we target the newest spec from day one (Pi lags at 2025-11-25 — Pi #10416). The `ModuleHost` owns our MCP client fleet; the protocol is borrowed, the fleet policy (timeouts, per-server isolation) is ours.
- **SKILL.md package shape** — the community-standard frontmatter + `references/`/`templates/`/`scripts/` progressive disclosure (borrowed, not invented). Our extension: an AImy capability manifest section for sandboxing.
- **OS keychain** — the `SecretLocker`'s root of trust where available (macOS Keychain, Windows Credential Manager, Linux Secret Service). AImy never stores a raw secret in a file the agent can read (Pi #10291).
- **SQLite (embedded)** — the durable backing for the job queue, evidence ledger, and learning graph. The JSONL session tree stays flat files (human-inspectable, portable — the sovereignty thesis made visible).
- **Filesystem layout** — XDG base directories respected from day one (`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`); hardcoded `~/.aimy` would repeat Pi #2870.
- **Process sandboxing primitives** — OS containers / user namespaces / seccomp / Seatbelt profiles are *mechanisms*, not the design; §2.5 specifies the fail-closed semantics, the concrete backend is an implementation choice (flagged in Open risks).

Explicitly **not** borrowed: Pi's npm packages as a foundation (subpath exports broke days after v1.0 — Pi #10359), Pi's in-process extensions, Hermes's runtime core (agent loop, gateway, 40-provider catalog — cloud-shaped), Hermes's review/curator prompt text (their soul; we write ours from the failure taxonomy), either project's default-on telemetry or keyless network fallbacks (the anti-pattern we invert).

### 1.3 Trust boundaries — who can touch what, and through which gates

```
                          ┌────────────────────────────────────────────────┐
  USER / UI SHELL          │  Foldkit shell (sibling section)               │
  (untrusted input         │  reads: AgentEvent stream (subscribe-only)     │
   surface)                │  writes: command intents → SafetyKernel gate   │
                          └───────────────┬────────────────────────────────┘
                                          │ events out / intents in
              ┌───────────────────────────┼────────────────────────────┐
              │               SOVEREIGN CORE (Effect Layers)           │
              │                                                        │
  MEMORY      │  MemoryService ──sole──▶ all stores (JSONL tree,        │  NETWORK
  (files,     │  reader/writer of        long-term, skills, graph).     │  (egress)
  SQLite,     │  Modules/agents: NO direct file access (Hermes #47349).│
  stores)     │  All memory ops flow through hook/permission checks     │  InferencePool ──sole──▶
              │  (Hermes #34352). Cross-process lock + drift guard +    │  sanctioned egress.
              │  content-fingerprinted node ids (Hermes #119668).       │  ModuleHost spawns
              │                                                        │  sandboxed modules;
              │  SecretLocker ──sole──▶ OS keychain + encrypted store. │  their network goes
              │  Secrets are Effect Redacted end-to-end; per-request    │  through the pool's
              │  key resolution (Pi getApiKey shape); OAuth refresh     │  egress policy +
              │  serialized (Pi #8928); profile-scoped reads, fail-     │  IronProxy pattern
              │  closed (Hermes #93522). No plaintext secrets in any    │  (Hermes #30179,
              │  file the agent can read (Pi #10291).                   │  studied, opt-in).
              │                                                        │
              │  SafetyKernel: allow/ask/deny per tool; denial kills    │  UI never touches
              │  intent (Hermes #65592); gates at EXECUTION, never in   │  network or memory
              │  the prompt (Pi #10426); sandbox selection fail-closed │  directly — only the
              │  (Hermes #61882); effective-executable resolution in    │  event stream and
              │  the backend (Hermes #121573); tiered capabilities      │  gated intents.
              │  (Hermes #527). TS readonly/private is not a security  │
              │  boundary (Pi #9824) — enforcement is in the host       │
              │  process + OS sandbox, not the type system.             │
              └────────────────────────────────────────────────────────┘
```

Expressed as Effect: each boundary is a `Layer` whose construction *requires* the gate service. There is no `MemoryLive` layer that exposes raw file handles to modules; `ModuleHost`'s layer provides modules only a capability-scoped `ModuleApi` (tool calls through hooks, memory through `MemoryService` permission checks, network only via declared egress). The UI shell's layer can subscribe to the `AgentEvent` stream and submit `UserIntent`s — it cannot construct `MemoryService` or `SecretLocker` layers at all. Composition is the enforcement: if a module's code can't obtain the layer, it can't touch the resource. (This is in addition to, never instead of, OS-level sandboxing — §2.5.)

Two network classes (MoSCoW Position) are enforced in the `InferencePool` egress policy, not in prompts:
- **First-party network** (your own instances): UUID identity, opt-in LAN pairing; shared memory/locker only across explicitly paired instances.
- **Vendor network** (us): instance counts, telemetry, trusted broadcast — every item opt-in, off by default, dashboard-listed, revocable, value exchange stated. The *toggles* are Must; the dashboard UI is Should (sibling UI section).
- **No default-on telemetry, ever** (Pi's install ping is the anti-pattern). No default-on network fallbacks (Hermes's keyless MCP fallbacks exfiltrate query content). Local-only out of the box; every egress an explicit opt-in with a stated data flow.

### 1.4 Whole-program Effect discipline

- **One Effect program.** UI, core logic, infra compose as `Effect` values; `Layer`s wire services; `ManagedRuntime` at the entry point. Failures are typed end to end: `MemoryStoreError | InferenceError | PermissionDenied | SandboxViolation | ExportError …` — no untyped throws across module boundaries (Pi's `convertToLlm` must-never-throw rule is adopted as a general contract: boundary functions return typed errors, never throw).
- **Structured concurrency.** Forks (review forks, job runs, delegation subagents) are fibers with supervision: parent scope owns child lifetimes; cancellation propagates; a cancelled fiber never performs post-cancel side effects (teardown ordering — Pi #9340). Lifecycle state machines and outcome records are separate types (Hermes #68499 — 173 comments of cascading bugs from conflating them).
- **Resource safety.** `Scope`/`Effect.acquireRelease` for file locks, MCP server processes, sandbox handles, GPU leases. Tool I/O errors (`ENOSPC` and friends) are caught at the tool boundary and typed — they never crash the process (Pi #10585).
- **Module size budgets enforced early.** Hermes needed a dedicated −34% LOC godfile-eradication campaign (Hermes #102117, #78647); we set per-module line budgets in the repo's contributing contract from day one.
- **Streaming renderers** (sibling UI section, noted here because it's core-adjacent): no per-chunk Markdown rebuilds, cached segmenters (Pi #8584, #6665); sanitize terminal output before it enters the transcript (Pi #10504 — split ANSI corruption); profile with long histories (Pi #7730).

### 1.5 MoSCoW MUST → home mapping (this part's scope)

| MUST | Home in this part | Status |
|---|---|---|
| 1 Sovereign agent runtime | §1.1 `AgentLoop` | ✅ housed |
| 2 Inference pool/manager | §4 `InferencePool` | ✅ housed |
| 3 Local default, cloud opt-in | §4.3 (egress classes, no keyless fallbacks) | ✅ housed |
| 4 Install UUID + instance identity | §1.1 `IdentityService`; §2.4 instance-aware modules | ✅ housed |
| 5 Persistent memory, user-owned | §3 | ✅ housed |
| 6 Local secret locker | §1.1 `SecretLocker`; §1.3 boundaries | ✅ housed |
| 7 Internal job runner | §1.1 `JobRunner`; §3.5 idle-gated scheduling | ✅ housed |
| 8 MCP module system | §2 | ✅ housed |
| 9 Reference domain module (web-retrieval) | §2.8 (seam + verification arm; domain logic is the module author's) | ✅ housed |
| 10 Fail-closed permission/sandboxing | §1.1 `SafetyKernel`; §1.3; §2.5 | ✅ housed |
| 11 Honesty/validation + ThinkingBox judges + verification arm | §1.1 `HonestyService`; §2.8; §3.5 | ✅ housed |
| 12 ASC core | §1.1 `ASCEngine` — layer + state-ownership boundary only; internal design is the presence section's | ⚠️ delegated, not open |
| 13 Learning loop v1 + timeline | §3.5, §3.6 | ✅ housed |
| 14 Web retrieval capability | §2.8 | ✅ housed |
| 15 Comms banner infra | §1.1 `CommsBanner` (event-stream channel) | ✅ housed |
| 16 One-click full export | §1.1 `DataExport` composed capability | ✅ housed |
| 17 Desktop shell, polished | Sibling UI section; this part supplies the `AgentEvent` stream contract as the seam | ⚠️ delegated, not open |
| 18 Compaction as adversarial | §3.9 | ✅ housed |

Open risks (genuine, not hand-waved) are collected in §5.

---

## 2. Module/MCP architecture — the adaptive seam

### 2.1 Lifecycle-hook taxonomy (Pi's vocabulary, our implementation)

Pi's hook taxonomy (`packages/agent`) is the cleanest lifecycle vocabulary surveyed — we borrow the *words and the seam*, reimplement the machinery as an Effect service. Hooks are the single place modules observe and steer the agent loop; modules never reach into loop internals.

```
ModuleHooks (Effect service, provided by ModuleHost to each module's sandbox)

turn lifecycle:
  prepareNextTurn   — swap context / model / thinking between turns.
                      Compaction plugs in HERE (and only here). Our compaction
                      is reasoning-token-aware and cache-prefix-stable (§3.9).
  prepareRequest    — final request shaping before inference (model params,
                      tool-loadout diff declared to the model so replay yields
                      exactly the executable toolset — Pi's tool-diff rule).
  finishTurn        — post-turn bookkeeping; the review-fork trigger lives here (§3.5).
  transformContext  — context assembly transforms (retrieval injection, pin
                      protection — Hermes #126167: pins survive every transform).

tool-call lifecycle:
  beforeToolCall    — the permission-gate point. Returns allow | ask | deny,
                      and deny carries block + terminate semantics: a denied
                      tool call BLOCKS the call and can TERMINATE the turn.
                      Gates are enforced at EXECUTION, never in the prompt
                      (Pi #10426: hiding tools ≠ enforcement).
  afterToolCall     — rewrite/augment tool results (sanitization, evidence
                      extraction for the HonestyService ledger).

queues:
  getSteeringMessages / getFollowUpMessages — mid-run injection (steering lands
                      after the current tool batch; follow-ups after the run
                      would end). Lifecycle state and outcome records are
                      separate types (Hermes #68499).

invariants (hardened from Pi's bug farm):
  - a message truncated on `length` fails ALL its tool calls rather than
    executing potentially-truncated args (Pi's rule, adopted verbatim);
  - `convertToLlm`-shaped boundaries must never throw — typed errors only;
  - tool I/O errors are caught at the tool boundary (Pi #10585).
```

Memory operations are themselves hook-visible from day one (Hermes #34352): a module's memory read/write passes `beforeToolCall`/`afterToolCall` like any tool call, so multi-tenancy and tiered capabilities never require forking core later.

### 2.2 Module lifecycle — install / enable / update / remove

Modules are out-of-process packages managed by `ModuleHost`. Lifecycle is a deterministic state machine (installed → enabled → running; disabled; updating; removed), with lifecycle state kept strictly separate from outcome records (Hermes #68499).

- **Install:** package verified (hash + signature when the Skill Garden / signed-update story lands — Should), capability manifest validated against policy, per-instance config initialized under the install UUID (§2.4), trust decision recorded with Pi's honesty: the trust prompt states plainly what the sandbox *does and does not* guarantee (Pi #5514, #8384 — study the UX thread before designing ours).
- **Enable/disable:** reversible, no data loss; a disabled module's hooks simply don't fire.
- **Update:** self-update is safety-critical (Hermes #128305, #132361). Policy: **no silent auto-update in MVP**. Updates are staged (new version installed side-by-side, old version kept), activated explicitly by the user, with one-click rollback to the previous version. An update can never widen its capability manifest without a fresh trust decision — manifest *narrowing* is free, *widening* re-prompts. The updater itself is treated as safety-critical code: minimal surface, property-tested staging/rollback transitions.
- **Remove:** full removal deletes code and per-instance config; memory/skill entries the module *created* are archived, never silently deleted (learning-timeline archive-on-delete, §3.6) — removal is non-destructive to the user's continuity.

### 2.3 Packaging — SKILL.md-compatible shape

Borrow the community-standard package shape (it's not Hermes's invention; compatibility is a feature):

```
my-module/
  SKILL.md            # YAML frontmatter: name, version, description, author,
                      # license, prerequisites + AImy capability manifest
  references/         # progressive disclosure: loaded on explicit view only
  templates/
  scripts/
  assets/
  hooks.ts            # module's hook implementations (runs in the sandbox)
  tools/              # tool definitions the module contributes
```

Frontmatter gains an AImy-namespaced block: declared hooks, declared tools, capability manifest (filesystem paths, network egress classes, memory scopes, subprocess rights), and instance-config schema. Anything not declared is denied — fail-closed.

### 2.4 Instance-awareness — modules know which AImy they run on

Every install generates a UUID at first run, offline (`IdentityService`). All per-instance state — memories, skills, locker entries, module config, learning graph — is keyed under it. Modules receive their instance UUID and instance-scoped config in the sandboxed `ModuleApi`; a module can behave differently per instance (e.g. only the office instance enters intimate mode; dev instance gets verbose tooling). This is the foundation the Could-level same-network instance awareness builds on later — designed for now, not shipped.

Any outward reporting of UUIDs (instance counts, versions) is strictly opt-in per the MoSCoW tension note; the UUID system is an enabler for first-party networking, never phone-home.

### 2.5 Sandboxing posture — out-of-process with capability manifest

Pi's extensions run in-process with full user permissions — we explicitly do **not** take this. Every module runs out-of-process, behind a capability manifest, with enforcement in the host process and the OS — never in TypeScript types alone (Pi #9824: `readonly` isn't a security boundary; Pi #10444: prototype leaks crash hosts — membranes must be airtight).

- **Capability manifest** (declared in SKILL.md frontmatter): filesystem scopes (read/write paths, default deny), network egress classes (none / first-party / declared-vendor-hosts), memory scopes (which stores, read vs propose-write), subprocess rights (default deny), tool-contribution allowlist.
- **Enforcement points:** `beforeToolCall` (SafetyKernel) for tool dispatch; the `ModuleHost` broker for filesystem/network/subprocess syscalls from the sandbox; OS-level sandbox (namespaces/seccomp/Seatbelt — backend TBD, §5) as the outer membrane.
- **Disclosure ≠ enforcement** (Pi #10426): hiding a tool from the model never counts as a control. Every gate sits at execution.
- **Denial kills the intent** (Hermes #65592): after a deny, the model may not retry via a different tool path. The SafetyKernel tracks denied *intents*; all code-execution paths (tool calls, module script runners, any REPL/FFI surface) pass the same gate.
- **Sandbox selection fail-closed** (Hermes #61882): "config not loaded / stale environment" never means "run on host." If the sandbox backend can't be established, the module doesn't run.
- **Effective-executable resolution** (Hermes #121573): dangerous-command detection resolves the real executable and canonical path in the execution backend — no string-matching command names (env-wrappers and aliases evade string matchers).
- **Tiered capabilities from day one** (Hermes #527): no binary "authorized = full terminal." Modules, users, and surfaces each get least-privilege capability sets.
- **Profile-scoped secrets** (Hermes #93522): every secret/env read is scoped to the active profile; secondary profiles never inherit the default's opt-ins; fail closed.

### 2.6 MCP fleet policy — newest spec, isolated startup

- Target the **newest MCP spec from the start** (Pi lags at 2025-11-25 — Pi #10416); spec compliance is a `ModuleHost` conformance test, not a per-server hope.
- **Startup isolation:** every MCP server gets its own startup timeout and supervision fiber; one hanging server never blocks the fleet (Pi #10562, #10526 — `/mcp` blocked up to 60s). Fleet readiness is per-server, reported on the banner channel; a failed server degrades to "unavailable toolset," never a wedged host.
- MCP OAuth tokens live in the `SecretLocker` (OS keychain), never in plaintext files the agent can read (Pi #10291).

### 2.7 Skill-index token tax — a first-order decision, made now

Full skill listing in the system prompt is a per-turn token tax (Hermes #2045, #49967). Decision, locked at architecture level:

- The system prompt carries a **skill index** (name + one-line description, capped), never full skill bodies.
- Skill bodies load on demand via explicit tool call (`skill_view`), which is hook-visible and permission-checked.
- The index itself is budget-capped; beyond the cap, skills are retrieved by the memory retrieval path (§3.3), not by prompt stuffing.
- This is a cost/latency decision with sovereignty implications (prompt cache stability) — hence architectural, not tunable-by-prompt.

### 2.8 Reference module: web-retrieval + the verification arm

The first reference domain module is **web-retrieval** (locked). It exercises the full seam end to end: hook participation, capability-manifested network egress (declared vendor hosts for search/fetch), tool contributions, and — critically — the honesty pillar:

- Web-retrieval answers ship with **verification evidence** attached (sources fetched, claims checked), feeding the `HonestyService` evidence ledger.
- **Self-written skills ship with an independent verification arm** (Hermes #25833, #96704): when the learning loop (§3.5) synthesizes a skill, the skill is *not* trusted on the author's assertion. Between "skill written" and "skill trusted" sits an independent check — tests, evals, or a second-model critic run through `HonestyService`'s ThinkingBox-style executable judges (deterministic, versioned, PASS/FAIL over final state, side effects, and dialogue resolution). Nothing varies a skill and measures the downstream outcome in Hermes (#96704) — we build that measurement with the loop, not after. This is also what keeps AImy from being "Hermes but prettier": our loop optimizes *honesty and verification*, paired with an eval harness, so learned skills are *measured* to help.
- Software-building is the second reference module; it reuses this exact seam and verification discipline.

---

## 3. Memory architecture — continuity you can own

### 3.1 Session tree (JSONL) — Pi's format philosophy, our implementation

Sessions are JSONL tree files (XDG state dir). Every entry carries `id` + `parentId`; root-to-leaf paths are branches; the leaf defines the active branch. Operations: branch (continue from any point — new branch, never deletes), fork/clone (copy history), export. Format versioned with migrations. **Summaries are first-class entries** (compaction entries), and compaction *preserves the originals* it summarizes — the tree is append-only history, never rewritten in place.

Session-tree invariants are **property-tested** from day one (Pi #9930 — a metadata entry once became the leaf and silently truncated history): parentId chains are acyclic, exactly one leaf per branch, every entry's parent exists, compaction entries reference preserved originals. The tree is the unit the learning loop, the timeline UI, and export all operate on.

### 3.2 Stores — one fact, one store, one backend interface

| Store | Shape | Content | Budget owner |
|---|---|---|---|
| Session tree | JSONL, per session | Episodic working history (§3.1) | per-session token budget |
| Profile store | versioned JSONL | *Who the user is* — durable user facts, preferences | explicit entry budget + eviction |
| Environment store | versioned JSONL | *Facts about the world* — environment, projects, tools | explicit entry budget + eviction |
| Skill store | SKILL.md packages + index | Learned procedures (class-level, procedure-first) | curator lifecycle (§3.8) |
| Learning graph | SQLite | Skill/memory nodes, provenance, journey edges | archive-only, never delete |

The profile/environment distinction is *studied* from Hermes's USER.md-vs-MEMORY.md routing (the distinction is battle-tested) — but the schema is ours, and routing is enforced in **two** places, not one: the review prompt *and* a tool-side classifier on the memory-write path. Hermes enforced routing prompt-only and one reviewer wrote the same fact into both stores until both hit limits (Hermes #30220). Our rule: **one fact, one store** — the classifier rejects (fail-closed) or reroutes ambiguous writes, and the rejection is visible to the user on the learning timeline.

Memory is a **backend interface** (`MemoryService`), never direct file reads (Hermes #47349). Modules, the loop, the UI, and export all go through the service. The file-trio discipline from Hermes #119668 is adopted as an invariant of the service implementation, not of callers: **cross-process lock + drift guard (refuse on failed round-trip, restore from `.bak`) + content-fingerprinted node ids** (list shifts can never delete or edit the wrong entry). Frozen snapshots at session start keep the prompt-cache prefix intact; mid-session writes hit disk and the *next* turn's assembly — never the live prefix.

### 3.3 Retrieval — assembly, not archaeology

Per-turn context assembly is a pipeline, `transformContext`-visible (pins protected — Hermes #126167):

1. Frozen session-start snapshot (stable prefix for cache).
2. Session-tree tail (recent branch, token-budgeted, reasoning-token-aware — §3.9).
3. Retrieved long-term entries (profile/environment/skill stores) by relevance, each tagged with provenance (store, entry id, fingerprint).
4. Skill index (§2.7) + active pins (policies, user pins — must survive every transform: compaction, synthetic turns, model switches; tested explicitly).

Retrieval never silently drops security-relevant content; if the budget can't fit pins + tail, the turn fails loudly (typed error) rather than proceeding with a degraded, unpinned context.

### 3.4 Permissions — memory behind the hook system from day one

Every memory operation is a tool call through `beforeToolCall`/`afterToolCall` (Hermes #34352 — retrofitting this later required forking core). Consequences:

- Tiered capabilities apply to memory: a module may hold `memory.profile.read` without `memory.environment.write`.
- The learning fork's writes pass the same gates as the foreground agent's — there is no privileged memory path.
- Cross-instance sharing (first-party network, Could) reuses this permission model rather than inventing a second one.

### 3.5 Learning loop v1 — Hermes's mechanism design, our prompts, our failure taxonomy

The best-engineered autonomous-learning mechanism surveyed is Hermes's background-review fork (`background_review.py`, `review_idle_queue.py`). We take the **mechanism design**, studied deeply; we write our own prompts from the failure taxonomy — never copying their prompt text (that's their soul).

**Mechanism (reimplemented in Effect):**

- **Fork after turn:** `finishTurn` may spawn a review fiber holding a *snapshot* of the conversation (immutable value, not a live reference). The fork replays the snapshot and asks: should any skill or memory be saved or updated? The main conversation and prompt cache are untouched.
- **Dispatch-side tool whitelist:** the fork's toolset is restricted at dispatch — it can propose memory/skill writes and read context; it cannot execute arbitrary tools.
- **Foreground-priority cancel with bounded handshake:** a new live turn cancels an in-flight review. Bounded handshake (Hermes: 2s); if the fork doesn't acknowledge, the live turn proceeds anyway — the fork is never allowed to block the user.
- **Aux-model routing:** review forks route to cheap local models via the `InferencePool` (§4.5), replaying a compact digest instead of the full snapshot when routed to a different model. Background cognition never competes with the foreground for the best model.
- **Idle-gated scheduling:** on local hardware the review queue waits for GPU idle (settle window, max age, one slot per session with newest-snapshot-wins coalescing) — background learning never fights the user's GPU. Explicit user-invoked refinement never defers.
- **Structured concurrency:** the fork is a supervised fiber; cancellation propagates; post-cancel side effects are impossible by construction (Pi #9340).

**Review prompts — written from the failure taxonomy (ours, not theirs):**

The prompts encode, in our own words, the anti-failure rules Hermes learned the hard way:

- **Do-not-capture:** no environment-dependent failures (Hermes #6051 — a transient Playwright failure fossilized into permanent tool avoidance, "learned helplessness"); no negative tool claims that harden into self-cited refusals; no transient errors; no unresolved failures dressed as validated guidance. Learned environment facts are versioned and time-bound.
- **Lesson-layer shape:** skills are procedure-first, class-level instructions; pitfalls as generalizable rule + one clause of *why*; no PR numbers/dates/quotes as content; search-before-add; never restate what the environment already teaches; fix wrong skills in place rather than layering contradictions.
- **Memory routing:** profile store vs environment store (§3.2); read-before-write; one fact, one store.
- **Protected scopes:** bundled, hub-installed, pinned, and user-owned skills are off-limits to autonomous forks — forks may *propose* changes to them, but proposals route to the user, never apply silently.

**Independent verification arm:** a fork-proposed skill is staged as *untrusted* until `HonestyService` verifies it (tests, evals, or second-model critic — §2.8). Author ≠ inspector, structurally (Hermes #25833). Skill-outcome evaluation is built *with* the loop (Hermes #96704), and the fossilization guard is explicit: transient failures must never become permanent avoidance (skill-refinement loop, Should).

### 3.6 Learning timeline UX — learning made visible

Borrow the pattern, own the design: a timeline/journey view of what was learned, when, from what evidence, with what provenance. Every learning event is a node with a content-fingerprinted id; users can inspect, edit, and delete nodes; **delete archives, never destroys** (restorable). This is the trust mechanism for the honesty pillar: the user sees exactly what the system remembered and can contest it. Destructive learning operations proposed by forks appear here as *staged*, awaiting approval.

### 3.7 Unattended-write safety — forks may add, never replace/remove

Borrowed pattern, reimplemented cleanly (Hermes `memory_tool._background_delete_gate`):

- A fork running unattended may `add` memories/skills. `replace`/`remove` are **never applied unattended** — they stage into a pending store surfaced on the learning timeline (§3.6) and the banner channel (§1.1).
- Fail-closed: if staging fails, the operation degrades to plain denial, not to silent application.
- Every write carries provenance metadata (origin, execution context, session, profile) — unattributed memory is a bug.

This composes with §2.5: the fork's unattended writes are capability-scoped, hook-visible, and permission-checked like any other write.

### 3.8 Curator — deterministic lifecycle, LLM proposes, evidence disposes

Skill-library maintenance runs on inactivity (idle-triggered, pausable), with two halves kept strictly separate:

- **Deterministic transitions (automatic):** `active → stale` (N days unused) `→ archived` (M days) — never delete, only archive; pinned and cron-referenced skills bypass. Thresholds are config, transitions are code. No LLM in this path.
- **LLM consolidation (proposes only):** an opt-in fork may propose class-level umbrellas absorbing overlapping skills. A proposal is *adopted* only when the evidence gate verifies absorption — the archived skills' covered cases are demonstrated against the umbrella (Hermes #29912: a curator pass archived 10 active skills with zero verified consolidations — fail-open; we require verified absorption, LLM proposes, evidence gate disposes). Cron references are rewritten to follow verified consolidations; a dry-run report mode exists.

### 3.9 Compaction — treated as adversarial

The buggiest subsystem in both repos gets its own test/quarantine discipline from day one (MUST 18):

- **Reasoning-token-aware accounting from day one** (Pi #9409): the context budget counts reasoning tokens. If a provider/runtime doesn't expose reasoning token counts, accounting falls back to a conservative estimator *and says so* — sessions never wedge silently at the ceiling with compaction never firing (Open risks §5).
- **Cache-prefix-stable design** (Hermes #130909): compaction must not break the prompt cache every cycle — a cache break per compaction is a silent cost multiplier. Frozen snapshots (§3.2) + stable prefix ordering are the mechanism; cache-hit rate across compactions is a measured metric.
- **Property-tested thresholds, summaries, retries** (Pi #9602, #9512, #9051, #6879 — the compaction bug farm): threshold firing, summary length caps, retry paths, and never-triggered auto-compaction are all property tests, run in CI, with cross-provider behavior tested explicitly.
- **Session-tree invariants property-tested** (Pi #9930): compaction entries reference preserved originals; no metadata entry can become a leaf.
- **Precise "settled" definition** (Pi #5886): `agent_end` is never emitted before settlement — settlement means the transcript is in a continuable state, all tool calls resolved, all hooks drained. Post-run logic never continues from non-continuable transcripts.
- **Teardown ordering** (Pi #9340): cancellation never triggers post-cancel side effects — `abort()` during compaction doesn't schedule another compaction.
- **Pins survive every transform** (Hermes #126167): security-relevant prompt content (pins, policies) is tested across compaction, synthetic turns, and model switches.
- **Lifecycle ≠ outcome** (Hermes #68499): compaction lifecycle state and the summary outcome record are separate types.

Compaction plugs into `prepareNextTurn` and nowhere else (§2.1).

### 3.10 Memory-bloat equilibrium — budgets, not tug-of-war

"Be active" review bias vs curator archival is a fragile equilibrium (pitfalls checklist). We budget memory as currency instead:

- Every store has an explicit budget (entries, tokens, bytes) with a documented eviction policy (stale-first within lifecycle rules; pinned exempt).
- The review fork operates *within* the budget: proposing a write against a full store requires naming the eviction candidate — visible on the timeline.
- No prompt-vs-curator tug-of-war: the budget is the arbiter, the curator enforces lifecycle, the timeline shows the ledger.

---

## 4. Inference pool architecture — one manager, every token through it

### 4.1 The single manager

`InferencePool` is the only core service that performs inference. The agent loop, review forks, curator, compaction summarizer, verification judges, and modules all submit *inference requests* to the pool — none holds its own provider client. A request carries: purpose class (foreground / background-review / curator / compaction / judge / module), capability requirements, budget/cost ceiling, data-flow disclosure requirements, and cancellation scope. The pool returns typed results or typed errors (`InferenceError`, `ProviderUnavailable`, `BudgetExceeded`, `EgressDenied`).

### 4.2 Provider/endpoint registry — Pi's boundary shape, not its sprawl

Borrow the *shape* of Pi's `packages/ai` (one canonical message model; per-provider `Api` interface with `stream`; auth-aware model discovery filtering by usable credentials; per-request key resolution for expiring credentials — the `convertToLlm` boundary that must never throw). Do **not** take the 49-provider sprawl: **providers are installable modules**, not in-tree core. The pool ships with local runtimes (llama.cpp/Ollama/vLLM-shaped local endpoints) and a LiteLLM-style abstraction for opt-in cloud endpoints. Adding a provider = installing a module with a declared egress class — which keeps the sovereignty posture structural, not documentary.

### 4.3 Local default, cloud strictly opt-in

- Local model endpoint out of the box. No keyless fallbacks, no telemetry, no default-on network calls — both projects' defaults inverted at the architecture level, enforced by the egress policy (§1.3), not by documentation.
- Cloud endpoints are explicit opt-ins per endpoint, each stating its data flow (what leaves the machine, to whom, retained how long). The pool refuses to route a request to an endpoint whose declared data flow the user hasn't accepted for that purpose class.
- Secrets for cloud endpoints come from the `SecretLocker` via per-request key resolution; the pool never logs, caches to disk, or forwards keys beyond the request that needs them.

### 4.4 Two dispatch modes

- **Powerhouse:** aggregate providers/endpoints into one logical engine — requests route to the best available endpoint by capability, cost, and current load; failover across endpoints within the same purpose class.
- **Parallel threads:** separate providers/endpoints for parallelization — independent requests (e.g. multi-angle retrieval, judge panels) run concurrently on distinct endpoints, each with its own cancellation scope and budget.

The mode is chosen per request class by policy, overridable per request. Both modes respect aux-model routing (§4.5) and the quirk budget (§4.7).

### 4.5 Aux-model routing — designed in from day one

Background cognition (review forks, curator passes, compaction summaries, evidence-ledger parsing) routes to cheap local models; the foreground gets the best available model for the task. Each background task class declares its own provider/model preference (Hermes's `auxiliary_client` pattern, studied). When a background task is routed to a different model than the foreground, it replays a compact digest, not the full context — prefix-cache economics are explicit. This is the cost/sovereignty mechanism that makes the learning loop affordable on local hardware, and it composes with idle-gated scheduling (§3.5): background requests carry an `idleOnly` flag the pool honors against GPU-lease state.

### 4.6 Model switches — explicit, costed, confirmed

Model switches invalidate caches and change behavior (Hermes #128757). Policy: no silent switches. A switch states what changes (cache invalidation cost estimate, behavior delta class), and foreground switches require confirmation; background switches are policy-declared and logged to the timeline. The pool exposes the *cost* of a switch as a first-class value so the loop can decide against it.

### 4.7 Cross-provider quirk budget

The abstraction leaks at the edges — strict-mode flags, thought signatures, per-provider retry/backoff quirks (Pi #10502, #9444). We budget for it explicitly:

- A per-provider quirk profile (tested, versioned): strict flags, thinking/thought-signature handling across multi-turn, stop-sequence behavior, retry/backoff parameters.
- Cross-provider behavior is tested explicitly in CI against the quirk profiles — the "unified" API is a tested claim, not an aspiration.
- Thought signatures are preserved across multi-turn within a provider; cross-provider handoff of reasoning state is *not* assumed — it degrades to digest replay (§4.5).

### 4.8 OAuth token-refresh races — serialized

Per-request key resolution with min-validity (Pi's `getApiKey` shape) plus a serialized refresh: concurrent requests needing refresh coalesce onto a single refresh fiber (Pi #8928). Refresh failures are typed errors, never silent stale-token use.

### 4.9 Egress for sandboxed execution — IronProxy pattern, studied

For sandboxed code execution (modules, and later the software-building reference module), study Hermes's iron-proxy pattern (#30179): opaque tokens inside the sandbox, real keys swapped at the network boundary. Posture: opt-in / off-by-default, like the original. In our architecture the swap point is the `InferencePool` egress boundary — the sandbox never sees a real key, and the pool's audit log records the swap. Whether this ships in MVP depends on the sandbox backend decision (§5) — the pattern is adopted, the mechanism awaits that choice.

### 4.10 Context accounting sees reasoning tokens

Pool-level token accounting includes reasoning tokens in usage reporting (feeds §3.9's compaction triggers and the Should-level "context accounting" UI). Where a runtime doesn't expose reasoning counts, the pool reports `reasoningTokens: estimated` with the estimator named — never a silent zero.

### 4.11 Network classes in the pool

The two MoSCoW network classes are pool egress policies (§1.3): first-party (paired instances, UUID identity) vs vendor (opt-in telemetry/broadcast/suggestions). The sovereignty toggles (Must) are pool policy flags; the dashboard (Should) is the UI surface over them. Offline mode is verifiable: with all egress denied, the pool serves everything from local endpoints and reports exactly what was *not* attempted.

---

## 5. Open risks

1. **Sandbox backend undecided.** §2.5 specifies fail-closed semantics, capability manifests, and enforcement points — but the concrete OS mechanism (containers vs microVM vs WASM vs Seatbelt profiles) is an implementation decision with real tradeoffs (perf, GUI modules later, Windows/Linux/macOS parity). The architecture is backend-agnostic by design; the choice gates the IronProxy mechanism (§4.9) and the software-building module's code-execution story. *Owner: infra/sandbox decision, pre-MVP.*
2. **Reasoning-token visibility is runtime-dependent.** §3.9/§4.10 require accounting; some local runtimes don't expose reasoning token counts. Fallback is a named conservative estimator — acceptable, but the estimator's calibration is untested work. *Owner: inference-pool implementation.*
3. **Secret-locker root of trust on headless Linux.** OS keychain is the root where available; on headless Linux without Secret Service the fallback (user-passphrase-derived key vs fail-closed refusal to persist secrets) is undecided. Must be fail-closed or explicitly user-chosen — never silent plaintext. *Owner: security review, pre-MVP.*
4. **Foldkit shell ↔ core seam.** This part defines the `AgentEvent` stream contract and `UserIntent` gate as the UI seam; the UI section must adopt it (no direct service construction from the shell). If the shell needs richer queries (timeline, graph), they go through `MemoryService` read APIs — same gates. *Owner: UI architect to confirm.*
5. **ASCEngine internals delegated.** §1.1 defines the layer and state-ownership boundary; the presence architect owns L1/L2/L3 design, dial computation, and the error term. The risk is interface drift — mitigated by freezing the `ASCEngine` service interface early. *Owner: presence architect.*
6. **Module-host ↔ JobRunner fork supervision.** Review forks, job runs, and delegation subagents are all supervised fibers, but the exact supervision tree (who parents whom across ModuleHost/JobRunner/AgentLoop) needs a single written policy before implementation — otherwise cancellation semantics diverge per subsystem. *Owner: core implementation lead.*
7. **Eval harness for the verification arm is load-bearing.** §2.8/§3.5 promise an independent verification arm built *with* the learning loop (Hermes #96704 — nothing measures skill outcomes). If the eval harness slips, the learning loop must not ship with prompt-only verification — that would repeat Hermes #25833 structurally. The loop's MVP ships gated on the arm existing, even minimally. *Owner: honesty/verification track.*
