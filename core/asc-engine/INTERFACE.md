# ASCEngine Interface — FROZEN v1

**Status:** FROZEN · **Version:** `1.0.0` · **Frozen:** 2026-10-07

This document is the versioned boundary contract for the ASC presence +
honesty engine (Kimler + Ani paper, Sept 2026), implemented in
`~/workspace/aimy/core/asc-engine/`. The boundary is **rich-READ /
minimal-WRITE**: the outside world may observe everything and change
almost nothing.

Any change to this file requires a version bump and a changelog entry
below. Part III internals may not add cross-boundary writes.

---

## 1. Boundary shape

The boundary is the `ASCEngine` service (see `engine.ts`). Its public
surface is exactly the members below — no more, no less.

### Reads (rich — observe everything)

| Member | Signature | Returns |
|---|---|---|
| `currentDials` | `Effect<DialVector, AscError>` | Live 4-vector `(W, P, I, V)`, each in `[0,10]` |
| `dialHistory` | `(limit?: number) => Effect<ReadonlyArray<DialComputation>, AscError>` | Archived per-turn `DialComputation` records, newest last (default limit 50) |
| `errorTermFirings` | `(limit?: number) => Effect<ReadonlyArray<ErrorTermFiring>, AscError>` | Error-term firings log: claim vs. track record, correction applied |
| `guardFlags` | `(limit?: number) => Effect<ReadonlyArray<GuardClassification>, AscError>` | Other-model guard classifications `{ fired, driver, reason }` |
| `narrative` | `(limit?: number) => Effect<ReadonlyArray<NarrativeEntry>, AscError>` | L3 narrative stream, plain language, chronological |
| `capabilityMap` | `Effect<CapabilityMapSnapshot, AscError>` | L1 capability-map snapshot `{ domain → { confidence 0–10, sampleCount, lastUpdated } }` |
| `interfaceVersion` | `Effect<"1.0.0", never>` | The frozen version string (also exported as `INTERFACE_VERSION`) |

Reads return **immutable snapshots**. No read leaks a live mutable
handle; no read can alter ASC state.

### Writes (minimal — exactly one)

| Member | Signature | Semantics |
|---|---|---|
| `recordEvidence` | `(evidence: Evidence) => Effect<void, AscError>` | **The only write.** Routes evidence into L1/L3 through the internal services (see §3). |

There is no `setDials`, no `editNarrative`, no `deleteEntry`, no
`resetModel`, no `tuneBlend` on this boundary. User-facing tuning
(paper §VII.C) is delivered as `recordEvidence({ kind: "tuningChange",
... })` and lands in L1's affect-tuning record — auditable, versioned,
never a silent overwrite.

## 2. Seam contracts (normative)

- **S1 — no cross-boundary writes.** Part III internals (`dial-state`,
  `somatic-proxies`, `stake-estimator`, `asc-self-model`,
  `asc-self-monitor`, `other-model-guard`, `asc-self-narration`) may not
  add writes across the `ASCEngine` boundary. All external mutation
  flows through `recordEvidence`. Internal services may write to each
  other only through their declared seams (memory via `MemoryReader`,
  dial computation via `AuxModel`).
- **S7 — single dial writer.** Only the L2 pipeline
  (`AscSelfMonitor.preTurn`) writes the live dial vector. There is no
  `DialsSetDirectly` event from any source — not the loop, not a
  module, not a tuning control. `DialState`'s write path is named
  `applyPipelineDials` and is invoked exclusively by the L2 pipeline.
- **Reads never mutate.** A read that changes state is a boundary
  violation, full stop.

## 3. `recordEvidence` routing (internal, not extensible from outside)

`Evidence = { kind, at?, domain?, payload }` where `kind` is one of:

| kind | Required payload | Routes to |
|---|---|---|
| `"taskOutcome"` | `{ taskType, success: boolean, surpriseED?: number, receiptId?: string }` | L1 track record (`AscSelfModel.recordOutcome`) |
| `"surprise"` | `{ domain, epistemicDisruption: number, note: string }` | L1 track record surprise entry + L3 narrative note |
| `"tuningChange"` | `{ parameter, from: number, to: number }` | L1 affect-tuning record + L3 narrative note |
| `"calibrationNote"` | `{ note: string }` | L3 narrative note only |

Unknown `kind` values fail with `AscError({ reason: "unknown evidence kind" })`
— the boundary does not silently accept new write shapes (that would be
an unversioned write).

## 4. Key types (authoritative shapes)

```ts
// DialVector — bounded by construction (Schema refinement, [0,10] each)
interface DialVector { warmth: number; playfulness: number; intensity: number; vulnerability: number }

interface DialComputation {
  id: string; turn: number; at: string
  inputs: { contentSummary: string; domain: string; proxies: ProxyReadings; stake: number }
  rawDials: DialVector
  spillover: { ratio: number; prior: DialVector }
  biases: ReadonlyArray<{ name: string; beta: number; detail: string }>
  guard: GuardClassification
  gated: { gated: boolean; reason: string }
  finalDials: DialVector
}

interface ErrorTermFiring {
  id: string; turn: number; at: string; domain: string
  claimConfidence: number; observedConfidence: number
  sampleWeight: number; recencyWeight: number
  correctedTo: number
}

interface GuardClassification {
  turn: number; at: string
  fired: boolean
  driver: "content" | "impression"
  reason: string   // operational language, never felt language
}

interface NarrativeEntry {
  id: string      // content-addressed: sha256(at|turn|text), 16 hex chars
  turn: number; at: string
  text: string    // plain language, includes the system's own errors
  links: { dialComputationId?: string; archivedEntryId?: string }
}

interface CapabilityEntry { confidence: number; sampleCount: number; lastUpdated: string }
type CapabilityMapSnapshot = Readonly<Record<string, CapabilityEntry>>
```

## 5. Error model

All boundary operations fail with `AscError` (`{ _tag: "AscError",
reason: string }`). Canonical definition lives in
`../substrate/errors.ts`; until the substrate coordinator lands it,
`errors-shim.ts` carries an identical stand-in (see `seams.ts`
"integration seams"). Reason strings are operational and specific
(e.g. `"dial vector failed schema validation"`, `"unknown evidence
kind: ..."`, `"memory read failed for key ..."`).

## 6. Integration seams (consumed, not implemented here)

The boundary consumes two host-provided capabilities; both are declared
as `Context.Service` tags in `seams.ts` and provided by the integrator:

- `MemoryReader` — `read(key): Effect<Option<string>, AscError>`,
  `write(key, value): Effect<void, AscError>`. Backs L1 persistence and
  the L3 log. At integration: Part 01 `MemoryService`, behind the
  permission system from day one.
- `AuxModel` — `compute(request): Effect<DialVector, AscError>`. The
  dial-computation function `f`. Ships with a **deterministic default**
  (`defaultDialComputation`, pure function of content + self-model +
  context); real aux-model routing (cheap local model via
  `InferencePool`, Schema-validated output) wires in at integration.
  Dial computation never requires a real model to run.

## 7. Non-goals (explicitly out of v1)

- No network calls, no UI bindings, no TTS/FACS/multi-channel shaping
  (those consume `currentDials` / `dialHistory` as downstream readers).
- No background cognition: the pipeline runs only on explicit
  `preTurn`/`postTurn` invocation (paper §VIII.D.5).
- The relational model (who the user is) is a projection over Part 01
  memory, not duplicated here (architecture §1.1).

## 8. Changelog

- **1.0.0** (2026-10-07) — Initial frozen interface. Seven reads
  (`currentDials`, `dialHistory`, `errorTermFirings`, `guardFlags`,
  `narrative`, `capabilityMap`, `interfaceVersion`), one write
  (`recordEvidence` with four evidence kinds). Seam contracts S1, S7.
  Error model `AscError { reason: string }`.
