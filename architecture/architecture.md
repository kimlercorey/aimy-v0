# AImy — System Architecture

**Status:** v1.0 · **Date:** 2026-10-07 · **Phase:** architecture (document only — no code)
**Owner:** architecture coordinator (subagent) · **Next gate:** core libs

## Sources (ground truth)

- `~/workspace/aimy/planning/mvp-moscow.md` — v1.0 FINAL scope contract (18 MUSTs)
- `~/workspace/aimy/decomposition/pi-hermes-decomposition.md` — harvest map (BORROW/STUDY/AVOID) + ~35-item pitfalls checklist
- `~/workspace/user/files/paperASC.pdf` — the ASC framework (Kimler + Ani, Sept 2026)
- ThinkingBox diagram — executable judges: deterministic checks over final state, side effects, dialogue → PASS/FAIL

## Locked decisions (not revisited here)

TypeScript + Effect as the full-stack substrate (one Effect program: UI, core logic, infra; failures typed end to end). Foldkit for the UI (Elm architecture). First reference domain module: web-research. ASC dial defaults per the paper, with user-facing tuning controls. MIT open source.

## Reading guide

This document is assembled from three specialist sections plus coordinator-written framing:

- **Part I — Core, Memory, Inference** (§2–§5): system decomposition, the MCP module seam, memory + learning loop, inference pool
- **Part II — Safety, Identity, Network** (§6–§8): install UUID + LAN pairing, secret locker, fail-closed safety, executable judges, verification arm, two network classes
- **Part III — UI, ASC, Channels** (§9–§11): ASC as system components, multi-channel seam, Foldkit UI
- **§12 Build order** (coordinator): milestones M0–M9, each independently demoable, mapped to MoSCoW
- **Appendices**: consolidated MUST coverage (A), consolidated open risks (B), cross-part seam contracts (C)

---

## 1. Executive summary

AImy is built as **one Effect program** whose composition *is* its enforcement: 11 sovereign core services (`AgentLoop`, `MemoryService`, `InferencePool`, `ModuleHost`, `IdentityService`, `SecretLocker`, `SafetyKernel`, `ASCEngine`, `JobRunner`, `HonestyService`, `CommsBanner`) expose typed interfaces as Effect Layers; if a component cannot obtain a layer, it cannot touch the resource. Trust boundaries are drawn in the dependency graph, on top of (never instead of) OS sandboxing.

**The module seam** reimplements Pi's lifecycle-hook taxonomy (`prepareNextTurn`, `beforeToolCall` with block+terminate, etc.) as the single place modules observe and steer the loop. Modules run **out-of-process** behind capability manifests — explicitly not Pi's in-process full-permission extensions. Packaging follows the SKILL.md community shape with an AImy capability-manifest extension. No silent auto-update in MVP: staged, explicit activation, rollback, manifest-widening re-prompts trust.

**Memory** is a JSONL session tree (Pi's format philosophy: parentId chains, branch/continue/fork, append-only with preserved originals) plus profile/environment/skill/graph stores behind one `MemoryService` — the only reader/writer, with every operation flowing through the permission hooks from day one. The learning loop reimplements Hermes's background-review fork mechanism (fork-after-turn, dispatch whitelist, foreground-priority cancel, aux-model routing to cheap local models, idle-gated GPU scheduling) with prompts written from the failure taxonomy, never copied. **Compaction is treated as adversarial**: reasoning-token-aware accounting, cache-prefix-stable design, property-tested thresholds and tree invariants, a precise "settled" definition, and no post-cancel side effects.

**The inference pool** is the single manager every token routes through: Pi's provider-boundary shape without the 49-provider sprawl (providers are installable modules), powerhouse vs. parallel-thread dispatch, aux-model routing designed in from day one, explicit/costed/confirmed model switches, and an egress policy enforcing the two network classes.

**Identity** is an install UUID + Ed25519 keypair + versioned identity document, all generated locally and offline. LAN discovery (mDNS, off by default) + mutual-consent QR pairing + X25519/TLS 1.3 gives first-party multi-instance: selective per-category sync, per-secret locker grants, per-instance mode grants (only the office instance enters intimate mode). The **secret locker** is AEAD-at-rest with the master key in the OS keychain only — never agent-readable plaintext — profile-scoped and fail-closed.

**Safety** is fail-closed throughout: per-tool allow/ask/deny across tiers T0–T3 (never binary auth), gates enforced at the *execution backend* (disclosure ≠ enforcement), denial kills the *intent* (one code-execution entry point, canonical path resolution in the backend), sandbox selection fail-closed, membranes tested adversarially. **ThinkingBox executable judges** — deterministic, versioned, out-of-process PASS/FAIL over final state, side effects, and dialogue — are the mechanism inside the honesty layer. **Self-written skills get an independent verification arm built with the learning loop, not after**: quarantine → generated tests + evals + second-model critic → evidence gate → trusted. LLM proposes, evidence disposes.

**ASC** is implemented as 7 Effect services inside the `ASCEngine` boundary (`AscSelfModel` L1, `AscSelfMonitor` L2, `DialState`, `SomaticProxies`, `OtherModelGuard`, `StakeEstimator`, `AscSelfNarration` L3). The per-turn pipeline (proxies → stake → dial computation via aux model → 50% spillover → guard → bias → capability gate → output → post-output audit → error term → second-order stake error → L3 append) plugs into the loop's hooks. "Computed, not chosen" is structural: the `DialVector` Schema makes out-of-range dials unconstructible, and the Foldkit update function *rejects* any externally-dispatched dial mutation — there is no `DialsSetDirectly` message. Reflective Fidelity (0.8 ship threshold) is the semantic ceiling over the deterministic hooks, with an adversarial post-hook under information asymmetry as the independent scorer — closing the paper's self-scoring caveat.

**The UI** is a Foldkit app: one immutable Model, explicit Messages, Commands as data interpreted at the Effect boundary. It ships the FACS expression engine (dials → Action Units → avatar or abstract renderer), the comms-banner priority queue, the sovereignty toggles panel (enforced at the `NetworkEgress` boundary), the learning timeline ("learning made visible," archive-on-delete), one-click full export (verify-before-package, locker manifest only), an onboarding flow engineered around the "it was there" moment, and MCP-exposed DevTools (inspect/history/dispatch through the same `update` — no privileged write path). The **multi-channel architecture** (chat/voice/expression/banner queues fed by one dial vector) ships as the seam in MVP; v1.1 promotes the sinks.

**The network** has two classes with separate code paths: first-party (your instances — sovereignty extended) and vendor (us — sovereignty exercised). Every vendor item is off by default, with stated data flow, dashboard listing, revocability + deletion. Both reference projects' defaults are inverted by name: no install ping, no keyless fallbacks, `managed_*_enabled`-pattern gates default-false. Trusted broadcast is security-disclosure duty first, never marketing. Self-update is safety-critical: signed, reproducible, staged, no silent auto-update at MVP.

**Headline open risks** (16 consolidated in Appendix B): sandbox backend undecided; headless-Linux keychain fallback; ASCEngine interface must freeze early; the eval harness is load-bearing for the learning loop (the loop must not ship on prompt-only verification); dial-computation quality depends on the aux model; DevTools dispatch needs adversarial review before non-local clients.

---
# Part 01 — Core, Memory, Inference

*Project AImy · architecture · section 1 of N · written 2026-10-07*
*Ground truth: `~/workspace/aimy/planning/mvp-moscow.md` (v1.0 FINAL) · `~/workspace/aimy/decomposition/pi-hermes-decomposition.md` · ASC paper (`workspace/user/files/paperASC.pdf`)*
*Locked substrate: TypeScript + Effect, full bet — the whole program (UI, core logic, infra) as one Effect program. No code in this document; Effect idioms are used as the design language.*

Scope of this part: the sovereign core, the module/MCP seam, the memory system (incl. the learning loop), and the inference pool. Sibling sections own: presence/ASC detail (the ASC *engine's* internal design), the Foldkit UI shell, desktop packaging, and the web-research reference module's domain logic.

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
| 9 Reference domain module (web-research) | §2.8 (seam + verification arm; domain logic is the module author's) | ✅ housed |
| 10 Fail-closed permission/sandboxing | §1.1 `SafetyKernel`; §1.3; §2.5 | ✅ housed |
| 11 Honesty/validation + ThinkingBox judges + verification arm | §1.1 `HonestyService`; §2.8; §3.5 | ✅ housed |
| 12 ASC core | §1.1 `ASCEngine` — layer + state-ownership boundary only; internal design is the presence section's | ⚠️ delegated, not open |
| 13 Learning loop v1 + timeline | §3.5, §3.6 | ✅ housed |
| 14 Web research capability | §2.8 | ✅ housed |
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

### 2.8 Reference module: web-research + the verification arm

The first reference domain module is **web-research** (locked). It exercises the full seam end to end: hook participation, capability-manifested network egress (declared vendor hosts for search/fetch), tool contributions, and — critically — the honesty pillar:

- Web-research answers ship with **verification evidence** attached (sources fetched, claims checked), feeding the `HonestyService` evidence ledger.
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
- **Parallel threads:** separate providers/endpoints for parallelization — independent requests (e.g. multi-angle research, judge panels) run concurrently on distinct endpoints, each with its own cancellation scope and budget.

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
# AImy Architecture — Part 02: Safety, Identity & Network

**Role:** Safety / Identity / Network architect · **Date:** 2026-10-07
**Status:** Draft for coordinator integration
**Ground truth:** `planning/mvp-moscow.md` (v1.0 FINAL) · `decomposition/pi-hermes-decomposition.md` (pitfalls checklist)
**Locked decisions honored:** TypeScript + Effect full-stack substrate · Foldkit UI · MIT open source · local default / cloud strictly opt-in · sovereignty supported, never forced · user sovereign over their own sovereignty setting.

**Scope of this part:** (1) Identity architecture — install UUID, instance identity, LAN pairing, secret locker, XDG layout, instance-aware modules. (2) Safety architecture — fail-closed permissions, execution-backend gates, sandboxing, trust UX, session-transform integrity, executable judges, the independent verification arm for self-written skills. (3) Vendor-network architecture — the two network classes (first-party vs vendor), opt-in mechanics for every vendor item, trusted broadcast as security-disclosure duty, self-update as safety-critical.
**Not in this part:** the agent loop itself, the memory schema (continuity part), the MCP module lifecycle machinery (adaptive part), the inference pool internals (inference part), the desktop shell / banner widget implementation (UI part). Seams to those parts are named explicitly wherever this part depends on them.

## Guiding principles (this part)

1. **Enforcement at the boundary, never in the prompt.** Anything the model can route around is UX, not security. (Pi #10426)
2. **Fail closed, everywhere.** Missing config, stale env, unknown tool, unclassified capability — the answer is *refuse*, never *run on host and hope*. (Hermes #61882)
3. **Denial kills the intent.** A denied action is a terminal state for that intent, not an invitation to try another tool. (Hermes #65592)
4. **Defaults are the thesis.** Local-only out of the box; every egress is an explicit, informed, revocable opt-in. Inverting Pi's install ping and Hermes's keyless fallbacks is not a preference — it is the product. (Pi telemetry anti-pattern; Hermes keyless-fallback anti-pattern)
5. **The user is sovereign over their own sovereignty setting.** Isolation is supported, never forced; connection is available, never coerced. (MoSCoW "Position" section)
6. **The broadcast channel is earned by duty of care, not marketing.** Its primary purpose is security-flaw disclosure to opted-in users. (MoSCoW trusted-broadcast framing)

---

## 1. Identity architecture

### 1.1 Install UUID + instance identity (MUST #4)

Every AImy installation generates, at first launch, an **install UUID** (v4, local CSPRNG) — offline-safe, no network involved, no registration. The UUID is the namespace key for *all* per-instance state: memory stores, skill library, secret locker, learning/evolution records, job schedules. Two instances never share a namespace unless the user explicitly pairs them (§1.3).

Identity is more than the UUID. First launch also creates:

- **Instance keypair** (Ed25519): the private half is sealed in the OS keychain/secret store (§1.5); the public half is published only during LAN pairing handshakes. This is what makes pairing authentication real rather than "we're on the same Wi-Fi, trust me."
- **Instance identity document** (versioned): `{ installUuid, publicKey, createdAt, instanceLabel, platformInfo }`. Portable — it is the unit that moves in one-click export (MUST #16) and in the optional identity copy/move service (Could). The identity document contains **no secrets**; secrets live in the locker.
- **Instance label + mode grants** (user-editable): e.g. `office`, `home-server`, `laptop`. Labels are user-chosen strings; mode grants (§1.6) are per-instance capability flags set explicitly by the user.

**UUID outward-reporting tension (MoSCoW tension note, honored):** the raw install UUID *never* leaves the device without explicit opt-in. Vendor-side instance counting (§3.3) uses rotated, unlinkable cohort tokens — never the UUID. The UUID system is the enabler foundation for multi-instance sovereignty, not phone-home.

*Effect shape (prose):* an `InstanceIdentity` service (Effect Tag) exposing the UUID, the identity document, and signing operations; constructed once per process from a Layer that reads the sealed identity at startup and fails closed if the seal is broken or the keychain is unavailable. Downstream services (memory, locker, sync) take `InstanceIdentity` as a dependency — identity is ambient *in the dependency graph*, never ambient process state (cf. Hermes #93522).

### 1.2 Filesystem layout: XDG from day one (Pi #2870)

No hardcoded `~/.aimy`. From the first commit:

- Config: `$XDG_CONFIG_HOME/aimy/` (policy documents, instance label, pairing grants, network opt-ins)
- Data: `$XDG_DATA_HOME/aimy/<install-uuid>/` (memory tree, skill library, locker ciphertext, job store) — namespaced by UUID so multi-instance and multi-profile coexistence is structural
- State: `$XDG_STATE_HOME/aimy/` (logs, audit trail)
- Cache: `$XDG_CACHE_HOME/aimy/` (model caches, prompt-cache artifacts)

Installer and first-run code resolve these via the XDG spec with platform fallbacks (macOS: `~/Library/...` conventions honored where the OS expects them, e.g. keychain access). Installers must never mutate the user's environment (PATH etc.) — Pi #10519.

### 1.3 First-party LAN discovery & pairing (the first-party network class)

**Discovery (convenience, not trust).** Instances advertise on the LAN via mDNS/DNS-SD (`_aimy-pair._tcp.local`). The advertisement contains *only*: install UUID, instance public key, instance label, protocol version, and a capability digest (e.g. "memory-sync v1, locker-grant v1"). No memory contents, no secrets, no user data. Discovery is off until the user enables "allow this instance to be discoverable" — default off, per the no-default-on-network principle.

**Pairing (trust, explicit, mutual).** Pairing requires explicit user consent **on both instances**:

1. Initiating instance shows discovered peers; user selects one.
2. An out-of-band pairing secret is established — QR code or short numeric code displayed on the *target* instance, entered/confirmed on the initiator (mutual approve, both screens show the same code; this defeats LAN-spoofing).
3. X25519 key exchange → per-pair session keys; all subsequent traffic over TLS 1.3 with pinned fingerprints. Pairing grants are recorded in each instance's config: *which* peer, *which* sync scopes were granted, *when*, revocable at any time.
4. Either side can revoke; revocation deletes session keys locally and the peer is notified on next contact (best-effort; local deletion is what matters — fail closed means a revoked peer gets nothing even if the notice never arrives).

Pairing is **pairwise and user-scoped**: pairing your laptop with your office machine does not transitively grant the office machine access to your home server. No mesh-by-default.

### 1.4 Selective sync across paired instances

Sync is **opt-in per category, per pair**, with per-category policies stored in the pairing grant:

- **Memory sync:** categories (e.g. `user-profile`, `project-facts`, `learned-skills`) each have a sync policy: `off | push | pull | bidirectional`. Conflict resolution is deterministic (content-fingerprinted node ids, last-writer-wins with provenance preserved — borrowed from Hermes's learning-graph id discipline, decomposition harvest #9). Sync never merges *policy documents* (permissions, trust decisions) — those are per-instance and never sync.
- **Locker sync (selective grants):** individual secrets can be granted to a paired instance by name ("share my GitHub token with the office instance"). Grants are explicit, per-secret, per-pair, revocable; revocation triggers a remote-delete request *and* local re-encryption rotation guidance. The locker never syncs wholesale.
- **Instance-aware modes:** mode grants (e.g. `intimate-mode`, `ambient-listening`) are per-instance, set by the user on that instance, and are **not** transferable by sync. The motivating example from the MoSCoW: three systems share memories + locker, but *only the office instance* enters intimate mode — because the grant lives on the office instance's config, set by the user there, and pairing sync cannot move it.

Sync transport reuses the pairing session (TLS 1.3, pinned). Sync is pull-with-push-notify: instances announce "I have new items in categories you pull," the receiver fetches. This keeps the data-flow direction auditable.

### 1.5 Secret locker (MUST #6)

The locker is the trust anchor for memories' keys, API credentials, OAuth tokens, and per-instance secrets.

- **Encrypted at rest, always.** Locker file = encrypted blobs (AEAD, e.g. AES-256-GCM or XChaCha20-Poly1305). The data-encryption key is wrapped by a master key that lives **only** in the OS keychain / platform secret store (macOS Keychain, Windows Credential Manager, Linux Secret Service / libsecret). **Never in a plaintext file the agent can read** (Pi #10291). The agent process holds *capabilities* (opaque handles) returned by the locker service, not key material.
- **Effect shape:** a `SecretLocker` Tag. Reads are `getSecret(key, scope)`; writes are `putSecret(key, value, scope)`; both are Effects that fail closed (keychain unavailable → error, never fallback-to-plaintext). The locker service is the *only* component with keychain access; nothing else in the process touches the OS store.
- **Profile-scoped, fail-closed reads (Hermes #93522 — confused-deputy discipline).** Every secret read carries the requesting profile/instance context. A secondary profile (or a paired instance's grant) **never inherits the default profile's opt-ins**: a secret stored under profile A is invisible to profile B unless an explicit grant exists. Ambient process state (env vars, cwd-inherited config) is *never* a credential source — env reads for secrets are profile-scoped or they don't happen. This is the single most important secret-handling rule in this document: the confused deputy is the default failure mode of multi-profile agents, and it is designed out here rather than patched later.
- **Locker manifest & export.** One-click export (MUST #16) includes a locker *manifest* (names, scopes, metadata — never values) plus an optional values export re-encrypted to a user-supplied passphrase, produced through an explicit, confirmed user action. The manifest format is versioned and documented so exit is real (sovereignty = control + exit).
- **Audit:** every locker read/write/grant/revoke appends to the local audit trail (who/what/when/which profile). The audit trail is user-inspectable — the trust mechanism for the trust anchor.

### 1.6 Instance-aware modules (MUST #8 seam)

MCP modules are instance-aware by design: at module initialization the host injects an `InstanceContext` — `{ installUuid, instanceLabel, modeGrants, pairingPeers }`. A module can branch on *which* AImy it runs on (the intimate-mode example), can refuse to load when a required mode grant is absent, and can declare in its manifest which modes it needs. Mode grants are user-set per instance (§1.4), stored in that instance's config, signed by the user action that set them. The module lifecycle machinery itself belongs to the adaptive part; this section defines the identity/context seam it hangs off.

**MUST #4 / #6 / #8 coverage:** install UUID (§1.1) · secret locker (§1.5) · instance-aware modules (§1.6). **Pitfalls addressed:** Pi #10291 (keychain-only secrets) · Pi #2870 (XDG) · Pi #10519 (installer hygiene) · Hermes #93522 (profile-scoped, fail-closed secret reads).

**Open design point (not a risk, a handoff):** headless-Linux keychain availability — the platform/runtime part must specify the fallback (e.g. file-backed vault sealed by a user passphrase when no secret service exists). Recorded as **OPEN RISK OR-1** below.

---
## 2. Safety architecture

### 2.1 Fail-closed permission system (MUST #10)

**Tiers, not binaries (Hermes #527).** Hermes's gateway auth was binary — authorized user equals full terminal — and it is the canonical example of what not to ship. AImy's permission system is per-tool **allow / ask / deny** with **tiered capabilities from day one**:

- **T0 — Observe:** read local files (within trust scope), web research reads, memory reads. Default: allow within the trusted project scope; ask outside it.
- **T1 — Bounded local writes:** writes to the instance's own data dirs, temp/scratch, project files under an explicitly trusted root. Default: ask on first use per project (trust decision, §2.4), then allow within the grant.
- **T2 — External effects:** network egress, messaging, calendar, any vendor-network call, secret-locker reads. Default: **deny unless an explicit opt-in or per-action approval exists.** This tier is where the sovereignty defaults bite.
- **T3 — Destructive / privileged:** deletes, config changes, permission-policy changes, credential use, code execution outside a sandbox, pairing/sync grants. Default: **ask every time** (no standing allow for T3), with the approval recorded in the audit trail.

Every tool — built-in, MCP-provided, or skill-installed — is classified into a tier at registration. **Unclassified tools default to deny.** Classification is part of the module/skill manifest contract (adaptive part); the safety part owns the enforcement.

**The gate lives at execution, never in the prompt (Pi #10426).** Pi's `codemode.mode: "only"` merely hid tools from the model while the dispatcher would still execute them. In AImy, the permission gate is a `beforeToolCall`-equivalent hook **in the execution backend** — the model-facing tool list is a courtesy; the dispatcher is the law. Hiding a tool from the prompt changes UX; removing it from the executable set changes security. The two are never confused.

**Effect shape:** a `PermissionGate` service consulted by the tool dispatcher as an Effect — `check(intent) => Effect<Decision>` where `Decision = Allow | Ask(prompt) | Deny(reason)`. The dispatcher cannot execute without a decision; there is no code path from "model emitted a tool call" to "tool ran" that bypasses the gate. Policy state (per-tool allow/ask/deny, tier assignments, trust grants) lives in a versioned **policy document** (§2.5) — not in the transcript, not in the prompt.

**Memory behind the permission system from day one (Hermes #34352; MUST #5 seam).** Memory reads/writes go through the same gate as tools: a memory write is a T1 action, a memory delete is T3 (destructive), cross-profile memory access is T2+. Retrofitting multi-tenancy around a memory layer that bypasses hooks required forking Hermes's core; AImy puts memory behind the gate on day one. The memory *schema* belongs to the continuity part; the *enforcement point* is defined here.

### 2.2 Denial semantics & code-execution gating (MUST #10)

**Denial kills the INTENT, not the tool call (Hermes #65592).** After a denial, the model must not retry the same intent via a different tool — Hermes's approval-dialog bypass (deny `terminal`, retry via `execute_code`) is the exact failure this rule exists to prevent. Mechanics:

1. The dispatcher works on **intents**, not raw tool calls: each tool call is bound to an intent node (the user's goal or the agent's sub-goal it serves).
2. A denial marks the intent node **terminal-denied** and returns a structured `IntentDenied` outcome — not a tool error the model can route around. The model is told *what was denied and why*, and the loop's intent tracker refuses to schedule any further tool call bound to that intent.
3. A dispatch-layer BLOCKED halt (Hermes #65592's own recommended defense) sits behind the gate: if a denied intent somehow reaches execution, the dispatcher halts the turn rather than executing.

**Every code-execution path passes through the same gate.** REPLs, script runners, model-written code (codemode-style), FFI, shell — all funnel through one `executeCode` entry point in the backend, which consults the permission gate and the sandbox selector (§2.3). There is no "direct Python call" equivalent that skips `terminal()` — the Hermes #65592 bypass class is closed by construction: one entry point, one gate.

**Resolve, don't string-match (Hermes #121573).** Dangerous-command detection by command-name string matching is evaded by env wrappers, aliases, and relative paths. AImy resolves the **effective executable and canonical target path in the actual execution backend** — the backend's own PATH resolution, then symlink canonicalization — and matches policy against the resolved absolute path plus file identity (device + inode, or content hash for scripts). Policy sees what will actually run.

**Language-level `readonly`/`private` is not a security boundary (Pi #9824).** TypeScript access modifiers are documentation. Real boundaries in this architecture are: process/memory isolation (sandbox), capability denial at the execution gate, and cryptographic sealing (locker). Nothing in the safety argument rests on a type modifier.

### 2.3 Sandboxing (MUST #10)

**Tiered sandboxes, matched to tiers.** T0/T1 local work may run in-process under the permission gate; any model-written or untrusted code (T3 code execution, codemode-style composition, skill `scripts/`) runs in a sandbox; network-capable execution runs sandboxed with the egress proxy (§2.3, iron-proxy). The sandbox backend matrix is per-OS (Linux namespaces/seccomp profiles, macOS seatbelt/sandbox-exec, Windows job objects / containers) — specified by the runtime part.

**Sandbox selection is fail-closed (Hermes #61882).** Hermes once cold-started with a stale env and silently ran on the host instead of the configured Docker container. AImy's rule: if the sandbox config is missing, stale, unverifiable, or the backend reports unhealthy — **refuse to run**. "Config not loaded" never means "run on host." The failure mode is a clear error to the user, not a silent privilege escalation.

**Membranes airtight (Pi #10444).** Pi's codemode let a script set `Array.prototype.toJSON` and crash the host — the prototype leak is the shape of this failure class. AImy's script sandbox gets a fresh context per run with frozen intrinsics; the membrane is tested by an adversarial test-suite (prototype pollution, host-object smuggling, resource exhaustion) that runs in CI. The sandbox is a security boundary; it is tested like one.

**Iron-proxy egress pattern (Hermes #30179) — off by default.** Inside the sandbox, secrets are **opaque handles**, never values. Real credentials are swapped in at the network boundary by a trusted egress proxy that the sandboxed code cannot reach or reconfigure. The pattern is elegant and AImy adopts it — with the posture Hermes itself used: off by default, enabled per explicitly-granted network capability (T2). Every swap is audit-logged.

### 2.4 Trust UX paired with real boundaries (Pi #5514 / #8384)

Pi's project-trust UX is worth copying — explicit per-project trust decision, a trust store, honest copy. Pi's honesty is also the lesson: its docs state plainly that project trust is **not a security boundary**. AImy copies the UX pattern and **adds the boundary Pi lacked**:

- First use of T1+ capabilities in a new project root triggers an explicit trust decision: *Trust this project?* with a plain statement of what the grant covers (read/write under this root, tier ceiling, revocable).
- The trust decision is recorded in the policy document and **enforced by the sandbox + permission gate** — an untrusted root runs at T0 (observe-only) with writes refused at execution, not merely hidden from the prompt.
- Trust copy never claims more than the boundary delivers. The prompt pattern to copy from Pi #5514 is the honesty; the boundary underneath is what makes AImy's version true.

### 2.5 Session-transform integrity & compaction discipline (MUST #18)

**Security-relevant prompt content must survive every session transform (Hermes #126167).** Hermes lost prompt pins across synthetic turns (P0). AImy's rule: the permission policy, trust decisions, network opt-ins, and mode grants live in a **versioned policy document outside the compactable transcript**, injected at a fixed system-prompt anchor at the start of *every* turn. Compaction, synthetic turns, model switches, and session restores may rewrite history — they may never rewrite policy. Property tests assert **byte-identical pin survival** across every transform: compact → restore → switch model → branch → merge. A transform that drops or mutates a pin fails the build.

**Compaction treated as adversarial (MUST #18).** Compaction was the buggiest subsystem in both repos (Pi #9602/#9512/#9051/#6879; Hermes #130909). AImy's compaction pipeline — whose full design belongs to the continuity part — is built under this part's test discipline:

- Property-test thresholds, summary caps, retry paths, and cross-provider behavior from day one.
- Compaction entries preserve originals (Pi's session-tree pattern); nothing is destructively summarized.
- Context accounting is **reasoning-token-aware from day one** (Pi #9409): the accounting layer sees reasoning tokens, or sessions wedge at the ceiling with compaction never firing.
- Compaction must be **cache-prefix-stable** where the provider supports it (Hermes #130909) — a cache break per compaction is a silent cost multiplier.
- Lifecycle state machines and outcome records are kept **separate** (Hermes #68499): the compaction *lifecycle* (triggered → summarizing → committed) and the compaction *outcome* (what was preserved/dropped, verification status) are different records. Conflating them caused 173 comments of cascading bugs in Hermes; AImy doesn't repeat it.

### 2.6 Executable judges — the honesty mechanism (MUST #11)

**ThinkingBox-style executable judges** are the mechanism inside the honesty/validation layer. A judge is a **deterministic, versioned program** (not a vibe check, not a second LLM call by default) that runs over the *final state* of a task:

- **Inputs:** the task's declared claim, the final filesystem/state diff, the side-effect ledger (what tools actually did), and the dialogue resolution (what was claimed to the user).
- **Output:** a PASS/FAIL verdict **plus evidence** — which checks ran, what they observed. Verdicts are stored as outcome records, separate from the task lifecycle state machine (Hermes #68499).
- **Versioning:** judges are `judge-id@semver`, pinned per task; a task's verdict names its judge version. Judge definitions live in the skill or task package so verification is reproducible and auditable.
- **Placement:** judges run **outside the agent process** (in the sandbox tier appropriate to what they inspect), after the agent declares the task complete. The agent cannot edit the judge, its inputs, or its verdict — it can only attach evidence the judge will check. This is what makes "verification evidence attached to claims" (MUST #11) structural rather than aspirational: a claim without judge-grade evidence is an *unverified* claim, labeled as such in the UI.

Judges compose with the learning loop's verification arm (§2.7): the arm *runs* judges (and generates them) as part of skill verification.

### 2.7 Independent verification arm for self-written skills (MUST #11)

**The single most important architectural lesson (Hermes #25833, #96704):** when the agent is simultaneously author, executor, and inspector of a skill, no prompt mitigation fixes the structural defect. AImy builds the **independent verification arm WITH the learning loop, not after** — the arm is a first-class subsystem, designed now, not a post-MVP retrofit.

**The pipeline (seam with the learning-loop part):**

```
skill written → QUARANTINE → verification arm → evidence gate → TRUSTED
```

1. **Quarantine.** A newly written or modified skill lands in quarantine: loadable only in sandboxed, T0-observed runs, never in live tasks, never auto-invoked by the model.
2. **The arm.** An independent verification service — owned by the safety part, invoked by the learning loop — composed of three sub-mechanisms:
   - **Generated tests:** the arm synthesizes task fixtures from the skill's declared contract and runs them in the sandbox; deterministic checks over final state and side effects (the judge pattern, §2.6).
   - **Evals:** task-outcome measurement — vary the skill and measure downstream task outcome (Hermes #96704's missing piece, built in from day one).
   - **Second-model critic:** an independent model pass (routed via the inference pool's auxiliary-model path — background cognition on a cheap/different model, per the decomposition's aux-routing harvest) reviews the skill for mechanism-level correctness the tests miss. *Independence caveat:* if only one local model exists, the critic degrades gracefully to deterministic-checks-only and labels its report accordingly — recorded as **OPEN RISK OR-5**.
3. **Evidence gate (LLM proposes, evidence disposes).** The skill leaves quarantine only when the arm produces a passing verification report. This same gate governs curator-style consolidation/absorption (Hermes #29912 — the curator archived 10 active skills on model assertion alone; in AImy, archive/absorb requires verified absorption, i.e. a passing arm report or explicit human approval). Deterministic lifecycle transitions (active → stale → archived, never delete) run automatically; anything the LLM *proposes* (consolidation, rewrite, absorption) goes through the arm before it *disposes*.
4. **Provenance.** Every skill carries provenance (author, verification report id, judge versions); the learning-timeline UI (MUST #13) surfaces verification status per skill. Unverified skills are visually distinct — the user sees the trust state, not just the skill.

**Fossilization guard (Hermes #6051)** — learned helplessness, where transient failures become permanent avoidance — is primarily the learning loop's prompt/eval discipline (loop owner's), but the arm contributes: env-dependent learned facts are time-bounded and versioned, and the arm's evals re-run against current environment state, so fossilized avoidance fails verification and gets flagged rather than silently persisting. Seam noted; primary ownership with the learning-loop part.

**MUST #10 / #11 coverage:** fail-closed permissions (§2.1) · execution-backend gates + denial-kills-intent (§2.2) · sandboxing (§2.3) · trust UX (§2.4) · session-transform integrity + compaction discipline (§2.5) · executable judges (§2.6) · verification arm (§2.7). **Pitfalls addressed:** Pi #10426 (gates at execution) · Pi #10444 (membrane) · Pi #9824 (readonly≠boundary) · Pi #5514/#8384 (trust UX + real boundary) · Pi #9409 (reasoning-token accounting) · Pi #9602/#9512/#9051/#6879 (compaction adversarial) · Pi #9930-adjacent (invariant property-testing, via §2.5) · Hermes #527 (tiered capabilities) · Hermes #65592 (denial kills intent; one code-execution entry point) · Hermes #121573 (canonical resolution) · Hermes #61882 (fail-closed sandbox selection) · Hermes #30179 (iron-proxy, off-by-default) · Hermes #126167 (pin survival) · Hermes #25833/#96704 (verification arm with the loop) · Hermes #29912 (evidence gate for curator actions) · Hermes #68499 (lifecycle vs outcome records) · Hermes #34352 (memory behind the gate) · Hermes #6051 (fossilization seam).

---
## 3. Vendor-network architecture

### 3.1 Two network classes, different trust profiles

The MoSCoW "Position" section defines the split; this section makes it architectural:

| | First-party network (§1.3–1.4, §3.2) | Vendor network (us) (§3.3–3.6) |
|---|---|---|
| **Who** | The user's own instances | AImy-the-project (vendor) |
| **Trust basis** | User owns both ends; mutual pairing consent | Explicit opt-in per item; revocable |
| **What's on it** | LAN discovery, pairing, selective memory/locker sync, instance-aware modes | Instance counting, error/plugin telemetry (OTel), trusted broadcast, suggestion engine, later community page |
| **Sovereignty reading** | Sovereignty *extended* across your devices | Sovereignty *exercised* — you choose what leaves |
| **Default** | Off until user enables discovery/pairing | **Off. Every item.** No exceptions. |

The classes are enforced in the permission system (§2.1): first-party sync is a user-granted capability between named instances; vendor-network egress is T2 (external effects) — **deny by default**, allowed only by explicit opt-in. The two classes never share a code path: a vendor endpoint can never receive data through the first-party sync channel and vice versa. This separation is what makes "the user is sovereign over their own sovereignty setting" checkable in code review.

### 3.2 First-party network policy (sovereignty extended)

Designed from day one (§1.3–1.4); the policy points that belong here:

- Full functionality offline is non-negotiable: no feature is held hostage to connectivity, and pairing/sync degrades to "not available" rather than "degraded mode with vendor fallback." There is no vendor fallback. Ever.
- Pairing and sync grants are per-instance, user-set, revocable, audit-logged. Sync never moves policy documents, trust decisions, or mode grants.
- The first-party network is **not** a telemetry channel: sync traffic carries user data between user devices only; nothing in it is observable by the vendor, and pairing with a vendor-operated relay is not offered in MVP (the Could-listed "cloud identity copy/move service" would be a separate, explicitly opt-in vendor service with its own stated data flow — not a silent extension of LAN sync).

### 3.3 Vendor-network items — mechanics per item (MUST #3, #15 seams)

Every vendor item follows the same **opt-in mechanics**, no exceptions:

1. **Off by default.** Shipped disabled. Enabling requires an explicit user action.
2. **Stated data flow + value exchange.** The opt-in screen names exactly what leaves the device, in what form, how often, where it goes, and what the user gets back. No "help improve our product" hand-waving.
3. **Dashboard-listed.** Every enabled item appears in the sovereignty dashboard's network section (toggles are MUST; the dashboard UI is Should — §3.5) with its current state and last-transmission summary.
4. **Revocable, with data deletion.** Turning an item off stops collection immediately and issues a deletion request for server-held data associated with the (unlinkable, rotated) client token, plus local purge of buffered payloads. Revocation is confirmed back to the user.

The items:

- **Instance counting.** Opt-in heartbeat answering "how many active instances exist" for project planning. Uses **rotated, unlinkable cohort tokens** — the raw install UUID never leaves the device (MoSCoW tension note). Payload: token, version, platform class. Nothing else. *This is the item the UUID tension note was written for; the design above resolves it.*
- **Error/plugin telemetry (OpenTelemetry, opt-in).** Crash/error reports and module-telemetry feeding reliability work. Redaction at the edge (paths, secrets, user content stripped before buffering); local buffer the user can inspect; sampled, not streaming. Off by default — Pi's `pi-telemetry` got the *contracts* idea right (OTel, vendor-neutral); AImy inverts the only thing that matters, the default.
- **Trusted broadcast (reuses the MUST #15 comms-banner channel).** The channel by which the system alerts the user — long-running job done, cron status — is also the product-owner broadcast channel, **under strict conditions**:
  - **Primary duty: security-flaw disclosure.** When the project finds a serious flaw affecting installations, it does its due diligence and notifies opted-in users. This is framed and operated as **duty of care, not marketing** — the channel earns its existence this way. Broadcast payloads are signed; the client verifies the signature before displaying; every broadcast is logged locally and user-inspectable.
  - **Secondary: critical product comms to verified cohorts** (version-critical notices, community/safety notices). Strictly opt-in per topic; topics are separate subscriptions (security-disclosure is its own topic, on by independent opt-in).
  - **Never:** marketing, engagement content, growth messaging. The moment the channel carries marketing, the duty-of-care framing is dead and user trust with it. This constraint is stated in the architecture so a future PM can't "just send one promo."
  - **Cohort verification (OPEN RISK OR-6):** "verified cohorts" needs a verification mechanism that doesn't itself become identity infrastructure. MVP scope: security disclosure goes to *all* users opted into the security topic; cohort targeting is deferred until a privacy-preserving cohort design exists.
- **Suggestion engine.** Feeds on opt-in plugin telemetry to suggest modules/skills ("users with the web-research module also installed X"). The engine's inputs are the telemetry the user already opted into — no separate collection. Suggestions appear in the dashboard, never as pushes, and the suggestion logic is documented.
- **Later: opt-in community page** (enthusiast connections, support center). Post-MVP; when built, it follows the same four mechanics. Noted here so the network-class table stays complete.

**Comms-banner infrastructure (MUST #15) — the channel contract.** The banner system is the delivery surface for both user alerts (job done, cron status — owned by the runtime/UI parts) and vendor broadcast (this part). The contract this part defines: topic subscriptions (`security-disclosure`, `product-critical`, `suggestions`), signed payloads, local audit log of received broadcasts, per-topic opt-in state in the policy document, and a user-visible "what was sent to me and why" view. The widget implementation belongs to the UI part; the trust properties belong here.

### 3.4 Inverting the defaults (MUST #3)

MUST #3 — *local default, cloud strictly opt-in; no keyless fallbacks, no telemetry, no default-on network calls* — is enforced by three concrete mechanisms:

1. **No default-on telemetry, ever.** Pi's default-on install ping (`pi.dev/api/report-install` on every upgrade, opt-out via `PI_OFFLINE`) is the anti-pattern, named and rejected. AImy has no install ping, no upgrade ping, no attribution headers injected into provider requests. Any "check for updates" is opt-in (§3.6).
2. **No default-on network fallbacks.** Hermes's default-on keyless MCP fallbacks sent user queries to third-party free tiers. AImy: local-only out of the box; a cloud provider is usable only after the user explicitly adds it with their own credentials (the inference-pool part owns the provider UX; this part owns the rule that no silent fallback path exists in the dispatch chain).
3. **`managed_*_enabled` gates, opposite default.** Hermes's `managed_nous_tools_enabled`-style gate pattern is structurally good — a single named boolean per managed capability, checked at the boundary. AImy adopts the pattern and ships every such gate **default-false**, user-flippable only through the sovereignty dashboard with the §3.3 mechanics. The pattern is borrowed; the default is inverted.

**Effect shape:** a `NetworkPolicy` service — the set of vendor-network gates as a typed record of booleans-with-provenance (each gate records *who/when* enabled it). The inference pool, telemetry client, and updater take `NetworkPolicy` as a dependency; a closed gate makes the corresponding Effect fail with `NetworkDisabled`, never silently degrade to an alternate route.

### 3.5 Sovereignty dashboard — the switches (toggles MUST, UI Should)

The MoSCoW marks the *toggles* as MUST and the *dashboard UI* as Should. This part defines the toggle inventory (the MUST); the UI part builds the surface:

- Per vendor-network item (§3.3): on/off, data-flow statement, last-transmission summary, revoke + deletion-request.
- Per first-party capability: LAN discoverability on/off, paired instances list, per-pair sync scopes, per-secret locker grants, per-instance mode grants.
- Global: **verifiable offline mode** — one switch that closes every network gate (both classes) and proves it: the dashboard shows a live "egress attempt log" (empty is the proof). Offline mode is testable — CI asserts zero socket creation with all gates closed.
- Every toggle change is a policy-document change: versioned, audit-logged, user-attributed.

### 3.6 Self-update as safety-critical (Hermes #128305)

Hermes's self-update threads (#128305, #132361) mark the updater as a reliability minefield. For a local-first agent with a trusted-broadcast channel, the updater is **safety-critical infrastructure** — a compromised or buggy updater bypasses every sandbox in this document. Design locked now:

- **Signed updates, reproducible builds.** Release artifacts + a manifest signed with the project's offline key (minisign/sigstore-style). The client verifies signature *and* reproducibility metadata before touching anything. An unverifiable update is refused, loudly.
- **Staged rollout.** Updates roll in waves; the client reports (only if telemetry opted in — otherwise it just waits its wave) and can pin to a wave.
- **MVP posture: no silent auto-update.** Initial ship: update *check* is opt-in and off by default; download + install is always an explicit, confirmed user action showing version, changelog, and signature status. Staged auto-update may come post-MVP behind its own opt-in — the mechanism above is designed now so the posture can change without redesigning trust.
- The updater runs with the *least* privilege that can replace the app bundle, verifies before replacing, keeps the previous version bootable (rollback), and never runs with the agent's full tool permissions.

**MUST #3 / #15 coverage:** local-default + no-default-on-network (§3.4) · comms-banner channel contract (§3.3). **Pitfalls addressed:** Pi default-on install ping (rejected by name) · Hermes default-on keyless fallbacks (rejected by name) · Hermes `managed_*_enabled` gate pattern, opposite default · Hermes #128305/#132361 (updater safety-critical).

---

## Cross-part seams (what this part needs from others)

| Need | Owner part | Contract defined here |
|---|---|---|
| Agent loop calls the permission gate at execution; intent tracking for denial-kills-intent | Runtime / agent loop | §2.1–2.2: gate interface, `IntentDenied` semantics, one `executeCode` entry point |
| Tool registration carries tier classification; unclassified = deny | Adaptive (module/skill system) | §2.1: tier taxonomy T0–T3, manifest contract requirement |
| Memory schema; compaction pipeline implementation | Continuity | §2.1/§2.5: memory behind the gate; pin-survival invariant; adversarial test discipline |
| Learning loop invokes the verification arm; skill quarantine UX | Learning loop | §2.7: quarantine → arm → evidence-gate pipeline; arm interface |
| Provider UX; auxiliary-model routing for the second-model critic | Inference pool | §2.7: critic independence requirement; §3.4: no silent fallbacks |
| Banner widget; sovereignty dashboard UI; trust-decision prompts | UI (Foldkit) | §2.4: trust UX pattern + honest copy; §3.3: channel contract; §3.5: toggle inventory |
| Per-OS sandbox backends; headless-Linux keychain fallback | Platform / runtime | §1.5: keychain-only rule; §2.3: fail-closed selection, membrane tests |
| Job runner honors permission tiers for unattended work | Runtime (job runner) | §2.8 below (unattended execution note) |

### 2.8 Unattended / background execution safety (Should-item seam)

Background/unattended execution (job runner, cron, learning forks) inherits the full permission system — there is no "background = trusted" mode. Additional rules: unattended work may **add**, never **replace/remove**, without human approval — destructive operations stage for approval and fail closed (borrowed from Hermes's `_background_delete_gate`, decomposition harvest #3). Forked/background agents run under a dispatch-side tool whitelist (narrower than foreground), and a foreground turn preempts an in-flight background task with a bounded handshake. The job runner part owns scheduling; this part owns the rule that background execution is *more* constrained than foreground, never less.

---

## MUST coverage matrix

| MUST | Home in this part | Notes / handoff |
|---|---|---|
| #3 Local default, cloud strictly opt-in | §3.4 (three inversion mechanisms) | Provider UX owned by inference part; the no-silent-fallback rule is here |
| #4 Install UUID + instance identity | §1.1 | Identity document format feeds one-click export (#16) |
| #5 Persistent memory, user-owned (behind permissions) | §2.1 (memory behind the gate from day one) | Schema + stores owned by continuity part |
| #6 Local secret locker | §1.5 | Manifest feeds one-click export (#16) |
| #8 MCP module system (instance-aware) | §1.6 (InstanceContext seam) | Lifecycle machinery owned by adaptive part |
| #10 Fail-closed permission/sandboxing | §2.1–2.3 | Per-OS sandbox backends owned by platform part |
| #11 Honesty/validation: executable judges + verification arm | §2.6–2.7 | Learning loop invokes the arm; judges attach to tasks |
| #15 Comms banner infrastructure | §3.3 (channel contract: topics, signed payloads, audit) | Widget + job/cron alerts owned by UI/runtime parts |
| #18 Compaction treated as adversarial | §2.5 (pin-survival invariant + adversarial test discipline) | Pipeline implementation owned by continuity part |

Every MUST touching safety/identity/network has an architectural home above. No MUST is left without one.

## Pitfall coverage checklist (decomposition numbers)

- [x] Pi #10426 — gates at execution, never in the prompt (§2.1)
- [x] Pi #10291 — secrets in OS keychain only, never agent-readable plaintext (§1.5)
- [x] Pi #10444 — airtight sandbox membranes, adversarial CI suite (§2.3)
- [x] Pi #9824 — `readonly`/`private` never a security boundary (§2.2)
- [x] Pi #5514 / #8384 — trust UX pattern + honest copy, atop real boundaries (§2.4)
- [x] Pi #9409 — reasoning-token-aware context accounting from day one (§2.5)
- [x] Pi #9602 / #9512 / #9051 / #6879 — compaction adversarial discipline (§2.5)
- [x] Pi #2870 — XDG base directories from day one (§1.2)
- [x] Pi #10519 — installers never mutate user environment (§1.2)
- [x] Pi default-on install ping — named anti-pattern, rejected (§3.4)
- [x] Hermes #527 — tiered capabilities (T0–T3), never binary auth (§2.1)
- [x] Hermes #65592 — denial kills the intent; one code-execution entry point (§2.2)
- [x] Hermes #121573 — canonical executable/path resolution in the backend (§2.2)
- [x] Hermes #61882 — sandbox selection fail-closed (§2.3)
- [x] Hermes #30179 — iron-proxy egress, opaque tokens in sandbox, off-by-default (§2.3)
- [x] Hermes #93522 — profile-scoped secret reads, fail-closed; no opt-in inheritance (§1.5)
- [x] Hermes #126167 — pins/policies survive every session transform; byte-identical property tests (§2.5)
- [x] Hermes #25833 / #96704 — independent verification arm built WITH the loop (§2.7)
- [x] Hermes #29912 — evidence gate: LLM proposes, evidence/human disposes (§2.7)
- [x] Hermes #6051 — fossilization: time-bounded env facts + arm re-verification (seam with loop, §2.7)
- [x] Hermes #68499 — lifecycle state machines vs outcome records kept separate (§2.5, §2.6)
- [x] Hermes #34352 — memory behind the permission/hook system from day one (§2.1)
- [x] Hermes #128305 / #132361 — self-update safety-critical: signed, staged, no silent auto-update at MVP (§3.6)
- [x] Hermes default-on keyless fallbacks — named anti-pattern, rejected (§3.4)
- [x] Hermes `managed_*_enabled` gate pattern — borrowed shape, opposite (default-false) default (§3.4)

## OPEN RISKS

- **OR-1 — Headless-Linux secret store fallback.** The keychain-only rule (§1.5) needs a fallback when no OS secret service exists (file-backed vault sealed by a user passphrase is the likely answer). Owned by the platform part; this part mandates *no plaintext fallback, ever*.
- **OR-2 — Second-model critic independence (weak local fleet).** If the only available model is the same local one, the critic arm degrades to deterministic-checks-only and labels its report accordingly. Acceptable for MVP, but the "independent" in *independent verification arm* is then partial. Mitigation path: inference part provides aux-model routing (§2.7 seam).
- **OR-3 — Per-OS sandbox backend matrix.** Fail-closed selection is specified (§2.3), but the actual backends (notably macOS, a primary target) are not designed here. The runtime part must specify; until it does, T3 code execution on unspecified platforms must refuse.
- **OR-4 — Iron-proxy enforcement for third-party MCP servers.** Opaque-token swap at the boundary requires network-capable MCP servers to route through the proxy; the enforcement story for servers the project doesn't control is unclear. Default-off posture bounds the blast radius; full story needed before enabling.
- **OR-5 — Cohort verification for broadcast targeting.** "Verified cohorts" (MoSCoW) has no privacy-preserving design yet. MVP: security disclosure goes to all security-topic opt-ins; cohort targeting deferred. (Noted in §3.3.)
- **OR-6 — Anonymous instance counting design.** Rotated unlinkable tokens are specified as the mechanism (§3.3) but the token scheme (e.g. privacy-pass style) is not designed. Small, but must be designed before the counting item ships — otherwise the UUID tension note resurfaces.
- **OR-7 — mDNS on hostile networks.** Corporate/restricted LANs often block mDNS; discovery degrades gracefully (manual pairing via QR/code is the primary trust path anyway — §1.3), but the UX for "discovery found nothing" must not push users toward insecure workarounds. UI part to note.
- **OR-8 — Compaction pipeline ownership.** The adversarial discipline and pin-survival invariant are specified here (§2.5); the pipeline itself belongs to the continuity part. If that part under-specifies the test discipline, MUST #18 is at risk — coordinator should cross-check.

## Decision log (this part)

1. **Identity = UUID + keypair + versioned identity document**, all generated locally, offline, at first launch. UUID never leaves the device un-opted-in. (§1.1)
2. **XDG from day one**; data dir namespaced by install UUID. (§1.2)
3. **LAN pairing = mDNS discovery (off by default) + mutual-consent QR/code pairing + X25519/TLS 1.3 pinned.** Pairwise, non-transitive, revocable. (§1.3)
4. **Sync is per-category, per-pair, pull-with-push-notify; policy/trust/mode grants never sync.** (§1.4)
5. **Locker: AEAD at rest, master key in OS keychain only, profile-scoped fail-closed reads, no opt-in inheritance, audit-logged.** (§1.5)
6. **Permissions: per-tool allow/ask/deny × tiers T0–T3, enforced at the execution backend; unclassified = deny.** (§2.1)
7. **Denial kills the intent** (terminal-denied intent node + dispatch-layer halt); **one code-execution entry point**; **canonical path resolution in the backend**. (§2.2)
8. **Sandbox selection fail-closed; membranes tested adversarially; iron-proxy off-by-default.** (§2.3)
9. **Trust UX copied from Pi's pattern, with the real boundary Pi lacked.** (§2.4)
10. **Policy pins live outside the transcript; byte-identical survival across all transforms, property-tested.** (§2.5)
11. **Executable judges: deterministic, versioned, out-of-process, PASS/FAIL + evidence; outcome records separate from lifecycle.** (§2.6)
12. **Verification arm built with the learning loop: quarantine → tests + evals + second-model critic → evidence gate → trusted.** (§2.7)
13. **Two network classes, separate code paths; every vendor item off-by-default with stated data flow, dashboard listing, revocability + deletion.** (§3.1–3.3)
14. **Defaults inverted by name:** no install ping, no keyless fallbacks, `managed_*_enabled`-pattern gates default-false. (§3.4)
15. **Trusted broadcast = security-disclosure duty first; never marketing.** (§3.3)
16. **Self-update safety-critical: signed + reproducible + staged; MVP has no silent auto-update.** (§3.6)

*End of Part 02.*
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

---

## 12. Build order — milestones M0–M9

Each milestone is independently demoable and ends with a named demo. MoSCoW MUSTs are claimed when their architectural home is *implemented*, not when designed. SHOULD items get extension points at the milestone where their seam is built (marked ↳). Post-MVP items follow.

### M0 — Substrate & skeleton
**Build:** TypeScript + Effect repo; one Effect program with `ManagedRuntime` entry; CI with property-test harness; XDG layout resolution; module size budgets in the contributing contract; zero-network-call boot assertion.
**Demo:** `aimy --version` boots offline; CI proves zero socket creation with all gates closed.
**Claims:** MUST 3 (partial — offline default structural).
**Extension points:** —

### M1 — Loop + inference pool
**Build:** `AgentLoop` with the hook taxonomy; `InferencePool` with local-endpoint provider module (llama.cpp/Ollama-shaped); powerhouse dispatch; typed errors end to end; read-only built-in tools.
**Demo:** streaming chat with a local model; tool calls execute through hooks; kill the network mid-turn and the typed error surfaces cleanly.
**Claims:** MUST 1, 2, 3.
**Extension points:** ↳ provider-as-module shape (SHOULD: additional providers); ↳ parallel-thread dispatch policy surface.

### M2 — Memory + safety kernel
**Build:** JSONL session tree + profile/environment stores behind `MemoryService`; permission gate T0–T3 at the execution backend; `SecretLocker` on OS keychain; versioned policy document + pins outside the transcript; basic (non-adversarial) compaction.
**Demo:** multi-turn conversation persists across restarts; attempt a destructive action → denied, intent killed, shown in UI; inspect the locker manifest (values never visible).
**Claims:** MUST 5, 6, 10.
**Extension points:** ↳ tiered-capability UI; ↳ per-project trust prompts.

### M3 — Honesty layer
**Build:** `HonestyService` (evidence ledger), ThinkingBox executable judges (deterministic, versioned, out-of-process), verification badges on transcript claims.
**Demo:** agent completes a task; judge verdict PASS/FAIL renders with evidence; a claim without evidence is labeled unverified.
**Claims:** MUST 11.
**Extension points:** ↳ the verification arm's full pipeline (built in M6); ↳ RF scoring surface (M5).

### M4 — Module seam + web-research reference module
**Build:** `ModuleHost` (lifecycle state machine, hook dispatch, capability manifests, out-of-process sandbox), SKILL.md packaging + validation, MCP fleet with newest-spec conformance + startup isolation; **web-research** reference module with declared egress, exercising the full seam.
**Demo:** "research X" → sourced answer with verification badges; disable the module mid-run → hooks stop firing, no residue.
**Claims:** MUST 8, 9, 14.
**Extension points:** ↳ module registry UI; ↳ Skill Garden distribution shape (Could); ↳ software-building module (post-MVP, reuses this seam + M3 judges).

### M5 — ASC core
**Build:** the 7 ASC services; per-turn pipeline wired into `prepareRequest`/`finishTurn`; dial computation via aux-model task; spillover; other-model guard; error term + L1 updates; anticipation loop with second-order calibration; L3 narrative; honesty-constraint scans; invariance properties as CI contracts; behavioral rubric harness with independent scorer.
**Demo:** the paper's T2 (debug → investigate before patching) and T3 (spillover noticed and corrected) as runnable scenarios with before/after scoring.
**Claims:** MUST 12.
**Extension points:** ↳ user affect-tuning controls (UI, M8); ↳ monthly diagnostic cadence (job, M7).

### M6 — Learning loop v1
**Build:** background-review forks (idle-gated, aux-model routed, bounded-cancel handshake); unattended-write safety (add-only, stage-for-approval); quarantine → **verification arm** → evidence gate → trusted pipeline; curator deterministic lifecycle; learning timeline data model.
**Demo:** agent learns a skill from experience; timeline shows it staged → verified → trusted with the evidence report attached.
**Claims:** MUST 13. **Gate:** does not ship until the verification arm exists even minimally (01#7) — prompt-only verification would repeat Hermes #25833 structurally.
**Extension points:** ↳ skill refinement + fossilization guard (Should); ↳ curator LLM-consolidation proposals (Should, always through the arm).

### M7 — Identity, jobs, banners, export
**Build:** install UUID + keypair + identity document; `JobRunner` (scheduling, supervision, permission-tier inheritance); `CommsBanner` core channel; `DataExport` composed capability (verify-before-package, locker manifest only).
**Demo:** schedule a cron job → banner fires on completion; one-click export → verified bundle with integrity receipt.
**Claims:** MUST 4, 7, 15, 16.
**Extension points:** ↳ LAN pairing + selective sync (Could — designed for in M7's identity work); ↳ trusted broadcast topics (Should, reuses banner channel); ↳ cloud identity move (Could).

### M8 — Foldkit desktop shell
**Build:** the full UI — Model/Message/update/Command; ASC panel (dials read-only, guard feed, error-term firings, capability map, tuning controls); sovereignty toggles panel; learning timeline view; permission-prompt surface; FACS engine + preview renderer; onboarding "it was there" flow; MCP-exposed DevTools (local-only until adversarial review); rendering discipline per pitfalls.
**Demo:** the desktop app — beautiful, with the ASC panel live during a conversation and the sovereignty panel showing every toggle off except local inference.
**Claims:** MUST 17. (UI work parallelizes from M1; *integration* lands here.)
**Extension points:** ↳ multi-channel sink promotion (v1.1); ↳ TTS voice selection UI (Should); ↳ rich sovereignty dashboard history (Should).

### M9 — Compaction hardening + adversarial suite
**Build:** reasoning-token-aware accounting; cache-prefix-stable compaction; property tests across the bug farm (thresholds, summaries, retries, cross-provider); pin-survival byte-identical tests across all transforms; lifecycle/outcome record separation audit.
**Demo:** 10k-turn session compacts repeatedly; pins byte-identical; cache-hit rate measured and reported.
**Claims:** MUST 18. (Basic compaction ships in M2; the *adversarial discipline* hardens here — the milestone exists so it can't be cut.)

### Post-MVP (in order)
1. **Multi-channel v1.1** — promote voice/expression sinks (seam already in M8); v1.1 coherence contract required before ship.
2. **Software-building reference module** — reuses M4 seam + M3 judges; blocked on sandbox backend decision (open risk #1).
3. **Messaging gateway** (Should) — studied Hermes adapter shape, own implementation.
4. **Background execution + multi-agent delegation** (Should).
5. **Trusted broadcast + suggestion engine** (Should) — both behind their opt-ins.
6. **Skill Garden registry** (Could); **LAN multi-instance sync** (Could); **cloud identity move** (Could).

---

## Appendix A — Consolidated MUST coverage matrix

| # | MUST | Primary home | Seam / notes |
|---|---|---|---|
| 1 | Sovereign agent runtime (TS+Effect) | I §1.1 `AgentLoop` | ASC pipeline plugs into loop hooks (III §1.3) |
| 2 | Inference pool / manager | I §4 `InferencePool` | UI read-only status view (III §3.1); dial compute as aux task |
| 3 | Local default, cloud opt-in | I §4.3 + II §3.4 (three inversion mechanisms) | Toggles MUST in III §3.6; no silent fallbacks anywhere |
| 4 | Install UUID + instance identity | I §1.1 `IdentityService`; II §1.1–1.2 | UUID namespaces all state; never leaves device un-opted-in |
| 5 | Persistent memory, user-owned | I §3 (`MemoryService`) | Behind permission hooks from day one (II §2.1) |
| 6 | Local secret locker | I §1.1 + II §1.5 | OS keychain only; `Redacted` end-to-end; manifest-only export |
| 7 | Internal job runner | I §1.1 `JobRunner` | UI jobs view + banners (III §3.1/3.5); idle-gated on local GPU |
| 8 | MCP module system | I §2 (`ModuleHost`) | InstanceContext seam (II §1.6); lifecycle-hook taxonomy |
| 9 | Reference domain module (web-research) | I §2.8 | Exercises full seam + honesty layer; software-building second |
| 10 | Fail-closed permission/sandboxing | I §1.1 `SafetyKernel`; II §2.1–2.3 | Gates at execution; denial kills intent; tiered T0–T3 |
| 11 | Honesty/validation + judges + verification arm | I §1.1 `HonestyService`; II §2.6–2.7 | RF ceiling + adversarial arm (III §1.15); badges in UI |
| 12 | ASC core (L1/L2/L3, dials, guard, error term) | III §1 (7 services) | Boundary/gates in I §1.1; dials read-only everywhere |
| 13 | Learning loop v1 + timeline | I §3.5–3.6 (loop); III §3.7 (timeline UI) | Verification arm gates trust (II §2.7) |
| 14 | Web research capability | I §2.8 (module) | Novelty-routed verification (III §2.5) |
| 15 | Comms banner infrastructure | I §1.1 `CommsBanner`; III §3.5 (queue/UI) | Channel contract in II §3.3; trusted broadcast reuses it |
| 16 | One-click full export | I §1.1 `DataExport`; III §3.8 (flow) | Verify-before-package; locker manifest only, never values |
| 17 | Desktop shell, polished | III §3 (Foldkit) | `AgentEvent` stream + `UserIntent` gate as the seam (I §1.3) |
| 18 | Compaction as adversarial | I §3.9 (pipeline); II §2.5 (test discipline) | Pin-survival invariant; events surface in timeline |

No MUST is without an architectural home.

## Appendix B — Consolidated open risks

1. **Sandbox backend undecided.** Fail-closed semantics specified; concrete OS mechanism (containers/microVM/WASM/Seatbelt) not chosen. Gates the IronProxy mechanism and the software-building module's code execution. *Pre-MVP decision.*
2. **Headless-Linux keychain fallback.** No OS secret service → fallback undecided (passphrase-sealed vault vs. fail-closed refusal). Never silent plaintext. *Pre-MVP.*
3. **Reasoning-token visibility is runtime-dependent.** Named-estimator fallback where runtimes don't expose counts; estimator calibration untested.
4. **ASCEngine interface must freeze early.** Part I owns the boundary, Part III the internals — drift risk mitigated by freezing the service interface before implementation.
5. **ModuleHost↔JobRunner fork-supervision policy.** One written policy needed for who parents whom; otherwise cancellation semantics diverge.
6. **Eval harness is load-bearing for the learning loop.** The loop must not ship on prompt-only verification — M6 gated on the arm existing even minimally.
7. **Second-model critic independence with a weak local fleet.** Degrades to deterministic-checks-only, labeled as such; acceptable for MVP, partial independence.
8. **Iron-proxy enforcement for third-party MCP servers.** Unclear for servers we don't control; default-off bounds the blast radius.
9. **Cohort verification for broadcast targeting.** No privacy-preserving design yet; MVP sends security disclosure to all security-topic opt-ins.
10. **Anonymous counting token scheme.** Rotated unlinkable tokens specified; scheme (e.g. privacy-pass style) not designed — must precede the counting item.
11. **mDNS-blocked networks UX.** Discovery degrades to manual QR pairing; "found nothing" UX must not push insecure workarounds.
12. **Dial-computation quality depends on the aux model.** The paper is honest that `f` is qualitative; needs a dial→output causality eval, not just plausibility.
13. **50% spillover dynamics at very long sessions.** Untested at AImy scale; timeline surfaces corrections for inspectability.
14. **FACS AU mapping validity.** Heuristic v1, stays behind preview until validated through the behavioral rubric.
15. **v1.1 voice/chat coherence.** Needs a coherence contract (voice derivable from settled chat output) before promotion.
16. **DevTools dispatch as attack surface.** Local-only until adversarial review of privileged-Message gating lands.

## Appendix C — Cross-part seam contracts (integration critical path)

- **S1 · ASCEngine interface.** Part I owns the service boundary and read/write gates; Part III owns the 7-service internals. Freeze the interface before implementation; Part III may not add cross-boundary writes.
- **S2 · AgentEvent stream + UserIntent gate.** The core↔UI contract. UI subscribes to events, submits intents through `SafetyKernel`; UI code never constructs `MemoryService`, `SecretLocker`, or other core layers.
- **S3 · CommsBanner core↔UI.** Part I's `CommsBanner` is the event source; Part III's banner queue is the renderer. Contract: topic subscriptions, signed payloads, per-topic opt-in state, local audit.
- **S4 · Verification arm invocation.** Learning loop (Part I) invokes the safety-owned arm (Part II): quarantine → arm → evidence gate. The arm's interface (submit skill, receive report) is the contract.
- **S5 · Fork supervision policy.** One written policy for ModuleHost/JobRunner/AgentLoop fork parenting, cancellation propagation, and the bounded-cancel handshake.
- **S6 · MemoryService read APIs.** Timeline, graph, and export read through the same permission-checked APIs as the loop — no backdoor readers.
- **S7 · DialState write exclusivity.** Only the L2 pipeline writes dials. The Foldkit update function rejects `DialsSetDirectly` from any source (UI, DevTools, MCP, modules).
- **S8 · NetworkPolicy gates.** InferencePool, telemetry client, and updater take `NetworkPolicy`; a closed gate fails with `NetworkDisabled` — never silent degradation to an alternate route.
- **S9 · HonestyService evidence ledger.** The RF/adversarial surface (Part III) reads/writes Part I's ledger; judges attach to tasks; badges read from the ledger.
- **S10 · Identity document format.** Versioned; feeds one-click export (Part I) and LAN pairing (Part II). No secrets in the document, ever.

---

*End of AImy System Architecture v1.0 — architecture phase complete. Next gate: core libs.*
