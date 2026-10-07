# substrate

The shared foundation of Project AImy. Every other core library depends on this
module; it depends on nothing but `effect` (plus node builtins for filesystem
access in `config`). Small and boring on purpose — this is bedrock.

## errors.ts — the typed-error taxonomy

Whole-program Effect discipline (architecture §1.4): failures are typed end to
end. Every error is an Effect `Data.TaggedError` and is **never thrown across
library boundaries** — boundary functions return them in the Effect error
channel instead.

Names and fields are a **cross-library contract**; do not rename:

| Error | Fields |
|---|---|
| `PermissionDenied` | `tool: string`, `tier: Tier`, `reason: string` |
| `SandboxViolation` | `reason: string`, `backend?: string` |
| `MemoryStoreError` | `store: string`, `reason: string` |
| `InferenceError` | `provider: string`, `reason: string` |
| `ExportError` | `reason: string` |
| `ConfigError` | `reason: string` |
| `IdentityError` | `reason: string` |
| `ModuleError` | `module: string`, `reason: string` |
| `AscError` | `reason: string` |

Also exported: `Tier = "T0" | "T1" | "T2" | "T3"` (the SafetyKernel's
per-tool allow/ask/deny tiers — never binary auth) and the `AimyError` union
of all nine. Catch sites that want to handle "any AImy failure" should match
on `AimyError` via the `_tag` discriminant.

```ts
import { Effect } from "effect"
import { PermissionDenied, type AimyError } from "../substrate/index.js"

const program: Effect.Effect<void, AimyError> = ...
```

## types.ts — shared branded types

- `InstanceId` — branded string; build with `InstanceId(raw)`. The install-instance identifier.
- `ToolName` — branded string; build with `ToolName(raw)`. Canonical tool-registry name.
- `Timestamp` — branded number (ms since epoch). `Timestamp.now()`, `Timestamp.fromEpochMs(ms)`, `Timestamp.toDate(t)`.
- `JsonValue` — recursive plain-JSON type for config files, memory payloads, manifests.
- `Redacted<A>` — the secret wrapper. API keys, tokens, and keychain handles are
  `Redacted` values in Effect and must **never** appear in logs, traces, tool
  args, or memory entries. The value lives in a module-private `WeakMap`, not
  as an own property, so even object spread cannot smuggle it out; `String()`,
  template literals, `JSON.stringify`, and `util.inspect` all render
  `"Redacted"`. The only read path is the explicit, auditable `reveal()`.

```ts
import { Redacted } from "../substrate/index.js"

const key = Redacted.make(process.env.OPENAI_API_KEY ?? "")
console.log(key)            // Redacted
JSON.stringify({ key })     // {"key":"Redacted"}
key.reveal()                // the secret — use at exactly one call site
```

## config.ts — XDG layout + typed config load

`resolvePaths({ env?, home? })` resolves the on-disk homes from the XDG base
directories (each gets an `aimy` subdirectory, per the XDG spec), falling back
to `~/.aimy` for any var that is unset or empty:

- `data` ← `$XDG_DATA_HOME/aimy` or `~/.aimy`
- `config` ← `$XDG_CONFIG_HOME/aimy` or `~/.aimy`
- `state` ← `$XDG_STATE_HOME/aimy` or `~/.aimy`

(Hardcoding `~/.aimy` unconditionally would repeat Pi #2870 — hence XDG first.)

`loadConfig(paths)` reads `<config home>/aimy.json`, parses it, and validates
it against `AppConfigSchema` (`{ version: 1, instanceLabel?: string }`;
unknown top-level keys are ignored). It returns
`Effect<AppConfig, ConfigError>` and **never throws**: a missing file, invalid
JSON, or schema violation all surface as typed `ConfigError` values.

```ts
import { Effect } from "effect"
import { loadConfig, resolvePaths } from "../substrate/index.js"

const main = Effect.gen(function* () {
  const config = yield* loadConfig(resolvePaths())
  console.log(config.instanceLabel)
})
```
