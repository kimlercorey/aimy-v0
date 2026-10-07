# @aimy/asc-engine

The ASC presence + honesty engine (Kimler + Ani paper, Sept 2026): a
three-layer model (L1 self-modeling, L2 self-monitoring, L3 self-narration)
over a four-dial state vector `(Warmth, Playfulness, Intensity, Vulnerability)`
with an error term, an other-model guard, somatic proxies, and an honesty
constraint. TypeScript + Effect 4, local-first, no network, no UI.

**Start with `INTERFACE.md`** — the frozen v1 boundary contract (rich-READ /
minimal-WRITE, versioned). Everything outside the boundary sees seven reads
and exactly one write (`recordEvidence`).

## Layout

| File | Service / role | Paper |
|---|---|---|
| `dial-state.ts` | `DialState` — session-scoped live 4-vector; `DialVector` Schema bounds each dial to `[0,10]` (unconstructible out of range); `spillover()` pure 50/50 blend | §III.D, §III.E |
| `somatic-proxies.ts` | `SomaticProxies` — pure measurement of the four proxies; operational language only, never felt states | §III.F |
| `stake-estimator.ts` | `StakeEstimator` — anticipation loop's ζ: `Z_t ∈ [0,1]` from domain/urgency/cost-of-error/track-record, plus the second-order error `ε²` that calibrates ζ | §VIII |
| `asc-self-model.ts` | `AscSelfModel` — L1 persistent state: capability map, track record, domain freshness, stake priors, affect-tuning record, guard-fire frequency; versioned updates; error-term corrections weighted by sample size (over-calibration guard) | §III.A, §III.G |
| `asc-self-monitor.ts` | `AscSelfMonitor` — L2 per-turn pipeline: `preTurn()` (proxies → stake → dial computation → spillover → guard → bias → capability gate) and `postTurn()` (register-match audit, T1 + proxy-overreach scans, error term, ε², Reflective Fidelity, L3 append) | §III.B |
| `other-model-guard.ts` | `OtherModelGuard` — classifies each register shift as content-driven or impression-driven; annotates, never blocks; fire frequency is a calibration signal | §III.H |
| `asc-self-narration.ts` | `AscSelfNarration` — L3 append-only log in plain language, content-addressed ids, archive-on-delete (no edit/delete path) | §III.C |
| `engine.ts` | `ASCEngine` — the frozen boundary tag composing the 7 services; `ASCEngineFullLive` needs only the `MemoryReader` seam | Part III |
| `seams.ts` | Integration seams: `MemoryReader`, `AuxModel` (+ deterministic default), storage keys | — |
| `errors-shim.ts` | `AscError { reason: string }` — identical stand-in for `../substrate/errors.ts` until the substrate coordinator lands it | — |

## The per-turn pipeline

```
preTurn:  proxies -> stake Z_t -> auxModel.compute -> spillover
          -> guard.classify -> bias g (+ Z_t·δ) -> capability gate
          -> DialState.applyPipelineDials   (S7: the ONLY dial writer)
postTurn: register-match audit -> T1 scan -> proxy-overreach scan
          -> error term -> ε² stake calibration -> RF note
          -> L3 append -> persist L1/L3
```

`guardedTurn(input, generate)` wraps an output effect so the post-turn
audit runs even when generation is interrupted or fails — the audit is
then marked `partial` (Pi #9340).

## Key invariants (tested)

- **Boundedness**: dials stay in `[0,10]` across spillover, bias, error-term
  correction, and adversarial aux-model output (schema rejects, pipeline
  falls back to the prior — loud, not quiet).
- **Single writer**: only `AscSelfMonitor.preTurn` calls
  `DialState.applyPipelineDials`; the frozen boundary has no dial write at all.
- **Honesty**: proxies are reported as operational state; the T1 scan flags
  framework vocabulary in output; the error term fires when capability
  confidence exceeds the track record and corrects toward it — weighted by
  sample size, so a thin record never collapses confidence.
- **Append-only L3**: no edit/delete path exists; archival appends a
  tombstone linked to the original.

## Integration seams

The host provides two capabilities (declared as `Context.Service` tags in
`seams.ts`):

- `MemoryReader` — `read`/`write` of JSON strings; backs L1 and L3. At
  integration: Part 01 `MemoryService`, behind the permission system.
  Tests use `InMemoryMemoryReaderLive`.
- `AuxModel` — dial computation `f`. Ships with `DeterministicAuxModelLive`
  (pure function, no model needed); real routing via `InferencePool` wires
  in at integration.

## Usage

```ts
import { Effect } from "effect"
import { ASCEngine, ASCEngineFullLive, InMemoryMemoryReaderLive } from "@aimy/asc-engine"

const program = Effect.gen(function* () {
  const engine = yield* ASCEngine
  yield* engine.recordEvidence({
    kind: "taskOutcome",
    domain: "code-review",
    payload: { success: true, receiptId: "hook-123" },
  })
  return yield* engine.currentDials
})

Effect.runPromise(
  program.pipe(
    Effect.provide(ASCEngineFullLive),
    Effect.provide(InMemoryMemoryReaderLive),
  ),
)
```
