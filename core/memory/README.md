# @aimy/memory

The memory library for Project AImy — `MemoryService`, sole reader/writer of every memory store (trust boundary).

## Public interface

```ts
import { Effect, Layer } from "effect"
import {
  MemoryService, MemoryServiceLive, MemoryPathsLive,
  PermissionGate, AllowAllGate, DenyAllGate,
  compactBranch, accountUsage, estimateTokens,
} from "./index.js"

// production wiring (SafetyKernel provides the real gate later)
const Main = Layer.mergeAll(MemoryServiceLive, MemoryPathsLive, RealGateLayer)

const program = Effect.gen(function* () {
  const mem = yield* MemoryService
  const entry = yield* mem.append("session-1", {
    parentId: null, kind: "message", payload: { role: "user", text: "hello" },
  })
  yield* mem.set("profile", "name", "Kimler")
  const tree = yield* mem.read("session-1")
})
```

### `MemoryService` (service.ts)
| Method | Gate | Description |
|---|---|---|
| `append(sessionId, {parentId, kind, payload, ts?})` | write `session:<id>` | Append one entry; returns the entry (with content-fingerprinted id) |
| `read(sessionId)` | read `sessionId` | Load + invariant-check the whole session tree |
| `branch(sessionId, fromId)` | read `session:<id>` | Root→anchor path; append to the anchor to continue the branch |
| `fork(sessionId, newSessionId)` | read src + write dst | Clone history into a new session |
| `get(ns, key)` / `set(ns, key, value)` | read/write `kv:<ns>` | Namespaced KV stores: `profile`, `environment`, `skills` (append-only, versioned, last-write-wins) |

Errors: `MemoryStoreError { store, reason }` for store failures, `PermissionDenied { op, store }` for gate denials. Typed errors only — nothing throws.

### `PermissionGate` (service.ts)
Context.Tag dependency: `checkMemory(op: "read"|"write", store: string) => Effect<void, PermissionDenied>`.
Consulted on **every** read and write. Ships `AllowAllGate` and `DenyAllGate` test layers.

### Session tree (session-tree.ts)
Pure core, no I/O. Entries `{ id, parentId, kind, payload, ts }`; append-only JSONL.
`appendEntry`, `branch`, `fork`, `getBranch`, `leaves`, `checkInvariants`, `toJsonl`/`fromJsonl`, `makeEntryId`.

### Persistence (persistence.ts)
File-trio primitives used only by the service: `withFileLock` (cross-process lockfile + stale-lock detection), `atomicWrite` (temp + fsync + atomic rename + read-back verify, restore from `.bak` on drift), `readText`, `readJsonlLines`, `appendJsonlLine`, `writeWholeFile`, `removeFile`.

### Compaction (compaction.ts)
`stageCompaction` → `verifyStaged` → `commitCompaction`, or one-shot `compactBranch`.
Summaries are first-class `summary` entries that **reference, never delete** originals.
Token accounting (`accountUsage`) is reasoning-token-aware: `estimatedReasoning: true` when the runtime doesn't report reasoning tokens.

## Invariants

1. **Sole reader/writer** — all memory file I/O lives inside `MemoryService`. No direct file reads (Hermes #47349).
2. **Gate on every op** — every read/write consults `PermissionGate` first (Hermes #34352).
3. **Append-only history** — entries are never edited or deleted in place; branching is implicit (append to a non-leaf parent).
4. **Content-fingerprinted ids** — `id = sha256(parentId ‖ payload ‖ ts)`; list shifts can't hit the wrong entry (Hermes #119668).
5. **Tree invariants (property-tested)** — acyclic parentId chains, every parent exists, every chain reaches a root, ids match fingerprints (Pi #9930).
6. **File trio** — cross-process lock + drift guard (refuse + restore from `.bak`) + fingerprinted ids (Hermes #119668).
7. **Compaction quarantine** — staged output is verified (entry count + invariants + reference preservation + summary-is-leaf) before the session pointer advances; originals are always preserved (§3.9).
8. **Reasoning-token-aware accounting** — budgets count reasoning tokens; unmeasured reasoning is estimated *and labeled* (Pi #9409).

## Integration notes

- `errors-shim.ts` / `paths-shim.ts` stand in for the parallel substrate build (`../substrate/errors.ts`, `../substrate/config.ts`). Names and fields are identical to the shared contract; see the header comments for the 3-step swap.
- The production `PermissionGate` implementation comes from the SafetyKernel (later milestone).
- The compaction summarizer passed to `compactBranch` is caller-provided today; the InferencePool summarizer plugs into the same `summarize` slot.
