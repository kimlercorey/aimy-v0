# module-seam — the ModuleHost adaptive seam

The out-of-process module system (MCP-style) for Project AImy: lifecycle-hook
taxonomy, deterministic module lifecycle, SKILL.md capability manifests, hybrid
sandbox posture, instance awareness, and the budget-capped skill index.

TypeScript + Effect 4. Typed errors only. No network, no UI.

## Layout

| File | Contents |
|---|---|
| `src/errors.ts` | Typed errors: `ModuleError`, `SandboxViolation`, `PermissionDenied` (canonical, re-exported from `../substrate/errors.ts`), plus seam-local `HookError`, `TurnTerminated`, `TrustDecisionRequired`, and `CapabilityDenied` (fail-closed capability denial at the seam). |
| `src/kernel-seam.ts` | Structural `SafetyKernelSeam` (`check` / `execute`) + `GateVerdict` (allow/ask/deny, deny carries block+terminate) + stub kernels for tests. The real SafetyKernel wires at integration. |
| `src/hooks.ts` | `ModuleHooks` service: the lifecycle-hook taxonomy (`prepareNextTurn`, `prepareRequest`, `finishTurn`, `transformContext`, `beforeToolCall`, `afterToolCall`, `getSteeringMessages`, `getFollowUpMessages`) + canonical `runTurn` dispatch. **Dispatch is per-module, never broadcast** (see Dispatch rule). Hardened invariants: truncated messages fail ALL tool calls; hook boundaries never throw (defects → `HookError`); tool I/O errors caught at the boundary. `withActiveCheck` wraps the dispatcher with a live active check so a mid-run disable stops hook dispatch immediately. |
| `src/lifecycle.ts` | Deterministic state machine (`installed → enabled → running`, `disabled`, `updating`, `removed`) + pure `transition` + `diffCapabilities`. Staged side-by-side updates, explicit activation, one-click rollback; manifest widening requires a fresh `TrustDecision`, narrowing is free; removal archives module-created entries. Lifecycle state and outcome records are separate types. |
| `src/manifest.ts` | SKILL.md frontmatter parsing (YAML subset) + `CapabilityManifest` schema validation + fail-closed capability predicates (`declaresTool`, `canReadPath`, `canEgress`, …). Anything undeclared is denied. |
| `src/egress.ts` | `EgressGate`: `checkEgress(manifest, request, ctx)` allows/denies one network request. `declared-vendor-hosts` means exactly those hosts; hostname normalization (case, trailing dot, port) can only narrow matching, never widen it. Denials are typed `CapabilityDenied`. |
| `src/enforce.ts` | Capability enforcement helpers for the ModuleHost broker: `enforceToolContribution`, `enforceFsRead`/`enforceFsWrite`, `enforceMemoryStore`/`enforceMemoryWrite`, `enforceSubprocess`, `enforceEgress`. All fail-closed with typed `CapabilityDenied`. |
| `src/packager.ts` | SKILL.md packaging: `packageModule(dir)` reads `<dir>/SKILL.md` and returns a validated `ModulePackage`; `validateModulePackage(pkg)` re-validates a built package. Malformed packages are typed `ModuleError`s — never partial installs. |
| `src/sandbox.ts` | `SandboxBackend` interface + OS-native **stubs** (Seatbelt/macOS, namespaces+seccomp/Linux) reporting unhealthy-by-default → fail-closed refusal; working `DirectGate` for T0/T1 via the kernel seam; `WasmRunner` interface + stub. Real OS backends are a later milestone — the interface is the deliverable. |
| `src/instance.ts` | `InstanceContext { instanceId, config }` + structural `IdentitySeam` (real IdentityService wires at integration). |
| `src/skill-index.ts` | Budget-capped skill index (name + one line) + `skill_view`: hook-visible, permission-checked (module must declare the `skill_view` tool). |
| `src/host.ts` | `ModuleHost` service composing lifecycle + hook dispatch + manifest enforcement + sandbox selection + runtime registry (teardown on stop/disable/remove). Install is atomic: full package validation before the lifecycle record is created. |
| `src/index.ts` | Re-exports. |

## Dispatch rule

**A hook fires only for the module whose turn or tool call it is.** The host
never broadcasts one module's hooks to other modules — there is no fan-out to
"all modules" anywhere in the dispatcher. A turn for module `m` invokes only
`m`'s hooks; steering/follow-up messages are collected only from `m`;
`beforeToolCall`/`afterToolCall` already addressed `m` by name. Cross-module
effects travel through the SafetyKernel seam and the shared outcome log, never
through another module's hooks.

Rationale: a broadcast dispatcher lets a compromised or buggy module observe
or steer turns that are not its own. Per-module dispatch keeps each module's
observation surface exactly its own execution.

## Disable-mid-run

Disabling a running module is a three-part stop, all immediate:

1. **Lifecycle transition** (`enabled`/`running` → `disabled`) — new turns,
   tool calls, and skill views are refused with a typed `ModuleError`
   (`requireActive`).
2. **Hook dispatch guard** (`withActiveCheck`, wired to the live lifecycle
   state) — hooks for the disabled module stop firing immediately, even
   inside an in-flight turn: void hooks are skipped, `beforeToolCall`
   returns a fail-closed `Deny`, steering/follow-up go empty.
3. **Runtime teardown** — the module's entry in the host's runtime registry
   is removed (and any out-of-process spawn handle killed when real sandbox
   backends land). No residue.

## Out-of-process execution boundary — honest scoping

What the boundary guarantees **today**:

- **Manifest enforcement at the seam.** Every capability a module exercises
  is checked against its declared manifest first: tool-contribution
  allowlist (`callTool` → `PermissionDenied`), filesystem scopes, memory
  scopes, subprocess rights, and network egress classes (`EgressGate` →
  typed `CapabilityDenied`). Anything undeclared is denied, fail-closed.
- **DirectGate for T0/T1.** The working execution path for low-tier modules
  is in-process execution through the SafetyKernel seam — every tool call
  passes `beforeToolCall` (module hook + kernel check) at execution time.
- **Fail-closed refusal for T2+.** Tier T2/T3 modules require a healthy OS
  sandbox backend. The OS backends ship as **stubs that report
  unhealthy-by-default**, so `start` refuses with a typed
  `SandboxViolation` and the module never leaves its prior state. There is
  no host fallback, ever (Hermes #61882).
- **No faked sandboxing.** The stubs do not pretend to isolate anything:
  `healthCheck` reports unhealthy with an honest reason, and any `spawn`
  attempt fails closed. The `WasmRunner` stub likewise refuses to run skill
  scripts.

What the OS backends will add **later** (not this milestone):

- Real Seatbelt profiles on macOS and namespaces+seccomp on Linux, selected
  per platform by `resolveBackend`.
- Out-of-process module execution: the host will spawn modules through the
  backend, hold the `SpawnHandle` in the module's runtime-registry entry,
  and kill it on stop/disable/remove.
- Canonical effective-executable resolution in the backend (Hermes #121573)
  and WASI capability wiring for the WASM skill-script runner.

Until then, "sandboxed" means *manifest-enforced + kernel-gated*, and the
trust UX must say exactly that (Pi #5514, #8384) — never imply OS isolation
that does not exist yet.

## Enforcement model

1. `callTool`: module must be active → tool must be **declared** in the manifest
   (undeclared = `PermissionDenied`, fail-closed) → sandbox backend must resolve
   for the tier (unhealthy/absent = `SandboxViolation`, fail-closed) →
   `beforeToolCall` gate (module hook + kernel seam) → execute via `DirectGate`
   (T0/T1) → I/O errors normalized at the boundary → `afterToolCall`.
2. Gates sit at **execution**, never in the prompt. A deny always blocks the
   call; deny with `terminate` also ends the turn (`TurnTerminated`).
3. After a deny the intent is dead — the seam is the single choke point, so no
   tool path can bypass it.

## Key invariants (pitfalls addressed)

- Pi #9824 / #10444 — enforcement lives in the host process and the OS
  backend, never in TypeScript types alone.
- Pi #10426 — hiding a tool ≠ enforcement; every gate is at execution.
- Hermes #65592 — denial kills the intent.
- Hermes #61882 — sandbox selection is fail-closed; stubs refuse to run.
- Hermes #121573 — `SpawnSpec` carries entrypoint/argv for canonical
  executable resolution in the backend (no string-matching in the seam).
- Hermes #527 — tiered capabilities (`T0`–`T3`); `DirectGate` serves T0/T1 only.
- Hermes #2045 / #49967 — skill index is budget-capped; bodies load on demand.
- Hermes #68499 — lifecycle state and outcome records are separate types.
- Hermes #34352 — memory operations route through the same tool-call hooks.

## Tests

`npx vitest run module-seam` from `~/workspace/aimy/core` — 81 tests:
hook dispatch order, truncation fails-all, boundary never throws, I/O errors
at the boundary, deny blocks + terminates via the seam stub, undeclared
capability denied, widening re-prompts / narrowing free, rollback, removal
archives, stub-unhealthy refuses with `SandboxViolation`, index capped,
`skill_view` permission-checked and hook-visible; **plus** per-module
dispatch (never broadcast), `withActiveCheck` in-flight guard,
disable-mid-run hook cessation + runtime cleanup, invalid lifecycle
transitions, staged update / one-click rollback, EgressGate (exact-match
vendor hosts, normalization), capability enforcement helpers
(fs/memory/subprocess/tool allowlist), and SKILL.md packaging + validation
(good + 9 malformed-package rejections).
