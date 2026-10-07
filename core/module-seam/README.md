# module-seam — the ModuleHost adaptive seam

The out-of-process module system (MCP-style) for Project AImy: lifecycle-hook
taxonomy, deterministic module lifecycle, SKILL.md capability manifests, hybrid
sandbox posture, instance awareness, and the budget-capped skill index.

TypeScript + Effect 4. Typed errors only. No network, no UI.

## Layout

| File | Contents |
|---|---|
| `src/errors.ts` | Typed errors. **Shim note:** `ModuleError`, `SandboxViolation`, `PermissionDenied` are specified to live in `../substrate/errors.ts` (not landed yet) — defined here with exactly the contracted shapes; replace with a re-export at integration. |
| `src/kernel-seam.ts` | Structural `SafetyKernelSeam` (`check` / `execute`) + `GateVerdict` (allow/ask/deny, deny carries block+terminate) + stub kernels for tests. The real SafetyKernel wires at integration. |
| `src/hooks.ts` | `ModuleHooks` service: the lifecycle-hook taxonomy (`prepareNextTurn`, `prepareRequest`, `finishTurn`, `transformContext`, `beforeToolCall`, `afterToolCall`, `getSteeringMessages`, `getFollowUpMessages`) + canonical `runTurn` dispatch. Hardened invariants: truncated messages fail ALL tool calls; hook boundaries never throw (defects → `HookError`); tool I/O errors caught at the boundary. |
| `src/lifecycle.ts` | Deterministic state machine (`installed → enabled → running`, `disabled`, `updating`, `removed`) + pure `transition` + `diffCapabilities`. Staged side-by-side updates, explicit activation, one-click rollback; manifest widening requires a fresh `TrustDecision`, narrowing is free; removal archives module-created entries. Lifecycle state and outcome records are separate types. |
| `src/manifest.ts` | SKILL.md frontmatter parsing (YAML subset) + `CapabilityManifest` schema validation + fail-closed capability predicates (`declaresTool`, `canReadPath`, `canEgress`, …). Anything undeclared is denied. |
| `src/sandbox.ts` | `SandboxBackend` interface + OS-native **stubs** (Seatbelt/macOS, namespaces+seccomp/Linux) reporting unhealthy-by-default → fail-closed refusal; working `DirectGate` for T0/T1 via the kernel seam; `WasmRunner` interface + stub. Real OS backends are a later milestone — the interface is the deliverable. |
| `src/instance.ts` | `InstanceContext { instanceId, config }` + structural `IdentitySeam` (real IdentityService wires at integration). |
| `src/skill-index.ts` | Budget-capped skill index (name + one line) + `skill_view`: hook-visible, permission-checked (module must declare the `skill_view` tool). |
| `src/host.ts` | `ModuleHost` service composing lifecycle + hook dispatch + manifest enforcement + sandbox selection. |
| `src/index.ts` | Re-exports. |

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

`npx vitest run module-seam` from `~/workspace/aimy/core` — 52 tests:
hook dispatch order, truncation fails-all, boundary never throws, I/O errors
at the boundary, deny blocks + terminates via the seam stub, undeclared
capability denied, widening re-prompts / narrowing free, rollback, removal
archives, stub-unhealthy refuses with `SandboxViolation`, index capped,
`skill_view` permission-checked and hook-visible.
