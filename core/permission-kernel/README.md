# permission-kernel — SafetyKernel

Fail-closed permission system for Project AImy (architecture §1.1 item 7,
Part 02 §2). One Effect `Context.Tag` service, provided as a `Layer`.
TypeScript + Effect, no network, no UI. The only filesystem access in this
library is reading `<configDir>/policy.json`.

## Public interface

```ts
import { Effect } from "effect"
import { SafetyKernel, SafetyKernelConfig, type ToolIntent } from "./index.js"
import { ToolName } from "../substrate/types.js"

const intent: ToolIntent = {
  tool: ToolName("read_file"),   // branded tool name from the registry
  tier: "T0",                    // caller's claim; the policy is the authority
  args: { path: "/tmp/notes.md" },
  provenance: "agent-loop:turn-42",
}

const program = Effect.gen(function* () {
  const kernel = yield* SafetyKernel
  const decision = yield* kernel.check(intent) // "allow" | "ask" — deny fails typed
  if (decision === "ask") {
    yield* kernel.approve(intent)              // one-shot approval
  }
  return yield* kernel.execute(intent, () => doTheRead())
})

Effect.runPromise(program.pipe(Effect.provide(SafetyKernel.layer)))
```

### `SafetyKernel` service

| Method | Shape |
|---|---|
| `check(intent)` | `Effect<Decision, PermissionDenied>` — decide without executing. Succeeds `"allow"` / `"ask"`; deny **fails** with typed `PermissionDenied` |
| `execute(intent, run)` | `Effect<A, E \| PermissionDenied \| SandboxViolation>` — the ONE code-execution entry point. Gates enforced here, at execution |
| `approve(intent)` | `Effect<void, PermissionDenied>` — one-shot approval for an `"ask"` intent, consumed by the next `execute` |

### Layers

- `SafetyKernel.layer` — loads `<configDir>/policy.json` (`SafetyKernelConfig`
  reference; defaults to the AImy XDG config home). Fails with substrate
  `ConfigError` when the policy is missing or invalid — the kernel cannot be
  built without a valid policy, so there is no fail-open path.
- `SafetyKernel.layerFromPolicy(policy, { sandboxBackend? })` — in-memory
  policy for tests and dev. Denied-intent registry and approvals are fresh
  per layer build (session-scoped, in-memory).

### Policy document (`policy.ts`)

```json
{
  "version": 1,
  "rules": [
    { "tool": "read_file", "tier": "T0", "decision": "allow" },
    { "tool": "*", "tier": "T0", "decision": "allow", "reason": "tier default" },
    { "tool": "shell_exec", "tier": "T3", "decision": "deny", "reason": "no exec yet" }
  ]
}
```

- `loadPolicyDocument(configDir)` — Schema-validated load; `ConfigError` on
  missing file, bad JSON, unsupported `version`, or schema violation.
  Excess properties are rejected (`onExcessProperty: "error"`): a misspelled
  rule key fails loudly instead of silently weakening the policy.
- `defaultPolicy()` — builds a document with exactly the tier-default
  wildcard rules (T0 allow / T1 ask / T2 ask / T3 deny).

## The fail-closed rules

1. **Default-deny.** A tool with no matching rule — no exact `tool+tier`
   rule and no tier-wildcard rule — is denied. The policy is a whitelist.
2. **No policy, no kernel.** Missing/invalid policy → `ConfigError` at
   layer build. Nothing executes without a loaded policy. Never fail-open.
3. **Denial kills the intent** (Hermes #65592). A denied intent is recorded
   under a tool-agnostic fingerprint of its canonicalized args (object keys
   sorted recursively). Retrying the same args via a renamed tool or a
   different path is denied. Denied intents are terminal for the session:
   `approve()` cannot resurrect them, and approval can never override a deny.
4. **Gates at execution, never in the prompt** (Pi #10426). `execute()` is
   the single entry point; it consults the gate at the moment of execution.
   `check()` results are not cached across calls — each `execute()` re-decides.
5. **Tier-spoofing fails closed.** The policy classifies tools into tiers.
   An intent whose claimed tier does not match the tool's classified tier is
   denied, even if a wildcard rule would have allowed the claimed tier.
6. **Sandbox selection fails closed** (Hermes #61882). T3 (code execution,
   destructive) requires a configured `sandboxBackend`; without one,
   `execute()` fails with `SandboxViolation` instead of running on the host.
7. **Tiered capabilities, never binary auth** (Hermes #527). T0 read-only
   local, T1 local writes, T2 network/identity-affecting, T3 code
   execution/destructive — each tier gated independently per tool.
8. **Types are not the boundary** (Pi #9824). Enforcement lives in the
   denied-intent registry and the execution gate, not in TS modifiers.
9. **`ask` never executes silently.** Without a live one-shot approval,
   `execute()` on an `"ask"` decision fails with `PermissionDenied`.
   Approvals are consumed on use and never persist.

## Integration notes

- Errors (`PermissionDenied`, `SandboxViolation`, `ConfigError`, `Tier`)
  and branded types (`ToolName`, `JsonValue`) come from `../substrate` —
  no local redefinitions (the parallel substrate build landed first, so no
  shim was needed).
- Canonical path/executable resolution (Hermes #121573) belongs to the
  execution backend behind `execute()`, not to the fingerprint: near-miss
  path variants (`/tmp/x` vs `/tmp/./x`) are the backend's job to resolve
  before presenting the intent.
- The denied-intent registry is in-memory and session-scoped by design.
  Cross-session denial persistence (if ever wanted) belongs to the
  `HonestyService` evidence ledger, not to this kernel.
