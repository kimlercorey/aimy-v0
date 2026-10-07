import { Context, Effect, Layer } from "effect"

import { AscSelfModel } from "./asc-self-model.js"
import { type DialVector, DialState } from "./dial-state.js"
import { AscError } from "./errors-shim.js"
import { AscSelfMonitor, type DialComputation } from "./asc-self-monitor.js"
import { AscSelfNarration, type NarrativeEntry } from "./asc-self-narration.js"
import { OtherModelGuard, type GuardClassification } from "./other-model-guard.js"
import { DeterministicAuxModelLive, MemoryReader } from "./seams.js"
import { DialStateLive } from "./dial-state.js"
import { SomaticProxiesLive } from "./somatic-proxies.js"
import { StakeEstimatorLive, StakeEstimator } from "./stake-estimator.js"
import { AscSelfModelLive } from "./asc-self-model.js"
import { AscSelfNarrationLive } from "./asc-self-narration.js"
import { OtherModelGuardLive } from "./other-model-guard.js"
import { AscSelfMonitorLive } from "./asc-self-monitor.js"
import type { ErrorTermFiring } from "./asc-self-model.js"

// ---------------------------------------------------------------------------
// ASCEngine — the frozen v1 boundary (see INTERFACE.md).
//
// Rich-READ / minimal-WRITE. The public surface is EXACTLY:
//   reads:  currentDials, dialHistory, errorTermFirings, guardFlags,
//           narrative, capabilityMap, interfaceVersion
//   writes: recordEvidence  (the ONLY write — seam contract S1)
//
// Seam contract S7: only the L2 pipeline (AscSelfMonitor.preTurn) writes the
// live dial vector, via DialState.applyPipelineDials. Nothing on this
// boundary can set dials directly — there is no DialsSetDirectly event.
// ---------------------------------------------------------------------------

/** Frozen interface version. Bumped only with a changelog entry in INTERFACE.md. */
export const INTERFACE_VERSION = "1.0.0" as const

export type EvidenceKind = "taskOutcome" | "surprise" | "tuningChange" | "calibrationNote"

const EVIDENCE_KINDS: ReadonlyArray<string> = [
  "taskOutcome",
  "surprise",
  "tuningChange",
  "calibrationNote",
]

export interface Evidence {
  readonly kind: EvidenceKind
  readonly at?: string
  readonly domain?: string
  readonly payload: Record<string, unknown>
}

export interface CapabilityMapSnapshot {
  readonly [domain: string]: {
    readonly confidence: number
    readonly sampleCount: number
    readonly lastUpdated: string
  }
}

export interface ASCEngineShape {
  // -- reads (rich) ---------------------------------------------------------
  readonly currentDials: Effect.Effect<DialVector, AscError>
  readonly dialHistory: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<DialComputation>, AscError>
  readonly errorTermFirings: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ErrorTermFiring>, AscError>
  readonly guardFlags: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<GuardClassification>, AscError>
  readonly narrative: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<NarrativeEntry>, AscError>
  readonly capabilityMap: Effect.Effect<CapabilityMapSnapshot, AscError>
  readonly interfaceVersion: Effect.Effect<typeof INTERFACE_VERSION, never>
  // -- writes (minimal: exactly one) ----------------------------------------
  /**
   * THE ONLY WRITE on this boundary. Routes evidence into L1/L3 through the
   * internal services:
   *   taskOutcome    -> L1 track record; the error term is then evaluated and
   *                     any firing is applied + narrated in plain language
   *                     (the correction belongs in L3 — paper §III.G)
   *   surprise       -> L1 track record (surprise entry, no fabricated outcome) + L3 note
   *   tuningChange   -> L1 affect-tuning record + live targets + L3 note
   *                     (+ live spillover ratio when applicable)
   *   calibrationNote -> L3 note
   */
  readonly recordEvidence: (evidence: Evidence) => Effect.Effect<void, AscError>
}

export class ASCEngine extends Context.Service<ASCEngine, ASCEngineShape>()("aimy/ASCEngine") {}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined

export const makeASCEngine = Effect.gen(function* () {
  const dialState = yield* DialState
  const monitor = yield* AscSelfMonitor
  const selfModel = yield* AscSelfModel
  const guard = yield* OtherModelGuard
  const narration = yield* AscSelfNarration
  const stakeEstimator = yield* StakeEstimator

  // Session bootstrap: load L1 + L3 from the memory seam, seed ζ from L1.
  yield* selfModel.load
  yield* narration.load
  const priors = yield* selfModel.getStakePriors
  yield* stakeEstimator.load({ priors: { ...priors } })

  const recordEvidence = (evidence: Evidence): Effect.Effect<void, AscError> =>
    Effect.gen(function* () {
      if (!EVIDENCE_KINDS.includes(evidence.kind)) {
        return yield* Effect.fail(
          new AscError({ reason: `unknown evidence kind: ${String(evidence.kind)}` }),
        )
      }
      const domain = evidence.domain ?? "general"
      switch (evidence.kind) {
        case "taskOutcome": {
          const success = asBoolean(evidence.payload["success"]) ?? false
          const surpriseED = asNumber(evidence.payload["surpriseED"])
          const receiptId = asString(evidence.payload["receiptId"])
          yield* selfModel.recordOutcome(domain, { success, surpriseED, receiptId })
          // Calibrate immediately: evidence that exposes a miscalibration
          // must not wait for the turn loop. A firing is narrated in PLAIN
          // LANGUAGE (the T1 rule applies to L3 too — no framework
          // vocabulary: no "error term", no "dials", no "spillover").
          const firing = yield* selfModel.applyErrorTermCorrection(domain, 0)
          if (firing) {
            yield* narration.append({
              turn: 0,
              text:
                `Correction in ${domain}: I had my confidence at ` +
                `${firing.claimConfidence.toFixed(1)}, but the track record supports ` +
                `${firing.observedConfidence.toFixed(1)}. Adjusted to ${firing.correctedTo.toFixed(1)}.`,
            })
          }
          break
        }
        case "surprise": {
          const ed = asNumber(evidence.payload["epistemicDisruption"]) ?? 0.5
          const note = asString(evidence.payload["note"]) ?? "surprise recorded without note"
          yield* selfModel.recordSurprise(domain, ed)
          yield* narration.append({
            turn: 0,
            text: `Surprise in ${domain} (epistemic disruption ${ed}): ${note}.`,
          })
          break
        }
        case "tuningChange": {
          const parameter = asString(evidence.payload["parameter"]) ?? "unknown"
          const from = asNumber(evidence.payload["from"]) ?? 0
          const to = asNumber(evidence.payload["to"]) ?? 0
          // Lands in the affect-tuning record AND the live tuning targets —
          // auditable, versioned, never a silent overwrite (unattended-write
          // discipline). Live application split:
          //   spilloverRatio  -> the L2 pipeline, immediately (below)
          //   errorTermLambda -> read live by the error term from the targets
          //   proxy weights / dial-range normalization -> recorded here;
          //   applied by the dial pipeline (its services own the live values)
          yield* selfModel.recordTuningChange(parameter, from, to)
          if (parameter === "spilloverRatio") {
            yield* monitor.setSpilloverRatio(to)
          }
          yield* narration.append({
            turn: 0,
            text: `Tuning changed: ${parameter} moved from ${from} to ${to}.`,
          })
          break
        }
        case "calibrationNote": {
          const note = asString(evidence.payload["note"]) ?? ""
          yield* narration.append({ turn: 0, text: `Calibration note: ${note}` })
          break
        }
      }
      yield* selfModel.persist
      yield* narration.persist
    })

  return ASCEngine.of({
    currentDials: dialState.current,
    dialHistory: (limit) => monitor.history(limit),
    errorTermFirings: (limit) => selfModel.errorTermFirings(limit),
    guardFlags: (limit) => guard.flagLog(limit),
    narrative: (limit) => narration.stream(limit),
    capabilityMap: selfModel.capabilityMap,
    interfaceVersion: Effect.succeed(INTERFACE_VERSION),
    recordEvidence,
  })
})

type EngineDeps =
  | DialState
  | AscSelfMonitor
  | AscSelfModel
  | OtherModelGuard
  | AscSelfNarration
  | StakeEstimator

/** Engine layer; still requires the internal services (wired by ASCEngineFullLive). */
export const ASCEngineLive: Layer.Layer<ASCEngine, AscError, EngineDeps> = Layer.effect(
  ASCEngine,
  makeASCEngine,
)

// --- full session stack --------------------------------------------------------
// One layer needing ONLY the MemoryReader integration seam. Build one per
// session: DialState is session-scoped (fresh NEUTRAL_DIALS each session).

const SessionInternalsLive = Layer.mergeAll(
  DialStateLive,
  SomaticProxiesLive,
  StakeEstimatorLive,
  DeterministicAuxModelLive,
  AscSelfModelLive,
  AscSelfNarrationLive,
  OtherModelGuardLive,
)

const MonitorProvidedLive = Layer.provide(AscSelfMonitorLive, SessionInternalsLive)

const AllInternalsLive = Layer.mergeAll(SessionInternalsLive, MonitorProvidedLive)

/**
 * The integration point: provide a MemoryReader (Part 01 MemoryService,
 * permission-gated) and get the frozen ASCEngine boundary.
 *
 *   const engine = yield* ASCEngine
 *   // .pipe(Effect.provide(ASCEngineFullLive), Effect.provide(HostMemoryReaderLive))
 */
export const ASCEngineFullLive: Layer.Layer<ASCEngine, AscError, MemoryReader> =
  Layer.provide(ASCEngineLive, AllInternalsLive)
