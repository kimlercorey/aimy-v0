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

- **T0 — Observe:** read local files (within trust scope), web retrieval reads, memory reads. Default: allow within the trusted project scope; ask outside it.
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
- **Suggestion engine.** Feeds on opt-in plugin telemetry to suggest modules/skills ("users with the web-retrieval module also installed X"). The engine's inputs are the telemetry the user already opted into — no separate collection. Suggestions appear in the dashboard, never as pushes, and the suggestion logic is documented.
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
