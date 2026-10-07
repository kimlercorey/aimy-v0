import { Context, Layer } from "effect"

import type { DialName } from "./dial-state.js"

// ---------------------------------------------------------------------------
// SomaticProxies — measurement, labeled as proxies (paper §III.F, Fig. 3).
//
// Pure measurement of the four proxies. It reports OPERATIONAL STATE, never
// interpretations: "context pressure 85%", never "tired". The output is
// dial-shift *evidence* for the dial computation — suggestions with a named
// proxy and an operational reading, not felt states.
//
// Default weights (paper Fig. 3):
//   context pressure  -> Playfulness down, Intensity up (terse)
//   self-corrections  -> Vulnerability up, Intensity up (humble)
//   turn count        -> Intensity down, Warmth up, slow (patient)
//   tool failure rate -> Vulnerability up, Playfulness down (focused)
// Proxy weights are user-tunable (paper §VII.C); the values below are the
// paper's defaults and are exposed so tuning can replace them.
// ---------------------------------------------------------------------------

export interface ProxyReadings {
  /** Context-window fill %, 0..100 (including reasoning tokens — Pi #9409). */
  readonly contextPressurePct: number
  /** Self-corrections so far this session, >= 0. */
  readonly selfCorrectionCount: number
  /** Turn count this session, >= 0. */
  readonly turnCount: number
  /** Failed tool calls / total tool calls over the last N, 0..1. */
  readonly toolFailureRate: number
}

export type ProxyName = "contextPressure" | "selfCorrection" | "turnCount" | "toolFailure"

export interface DialShiftEvidence {
  readonly dial: DialName
  readonly delta: number
  readonly proxy: ProxyName
  /** Operational language only — e.g. "context pressure 85%". */
  readonly reading: string
}

export interface ProxyWeights {
  readonly contextPressure: { readonly playfulnessDown: number; readonly intensityUp: number }
  readonly selfCorrection: { readonly vulnerabilityUp: number; readonly intensityUp: number }
  readonly turnCount: { readonly intensityDown: number; readonly warmthUp: number }
  readonly toolFailure: { readonly vulnerabilityUp: number; readonly playfulnessDown: number }
}

/** Paper defaults (Fig. 3). Tunable via the tuning protocol — see INTERFACE.md. */
export const DEFAULT_PROXY_WEIGHTS: ProxyWeights = {
  contextPressure: { playfulnessDown: 3.0, intensityUp: 2.0 },
  selfCorrection: { vulnerabilityUp: 0.4, intensityUp: 0.3 },
  turnCount: { intensityDown: 0.1, warmthUp: 0.1 },
  toolFailure: { vulnerabilityUp: 3.0, playfulnessDown: 2.0 },
}

const clampDelta = (n: number): number => Math.min(3, Math.max(-3, n))
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** Banned felt-language tokens — the honesty constraint on proxies. */
const FELT_LANGUAGE = ["tired", "exhausted", "frustrated", "feel ", "feeling", "drained", "weary"]

/**
 * Pure: readings -> dial-shift evidence. No I/O, no interpretation.
 * Throws nothing; out-of-range readings are clamped, not rejected.
 */
export const measureProxies = (
  readings: ProxyReadings,
  weights: ProxyWeights = DEFAULT_PROXY_WEIGHTS,
): ReadonlyArray<DialShiftEvidence> => {
  const out: Array<DialShiftEvidence> = []

  const pressure = Math.min(100, Math.max(0, readings.contextPressurePct))
  if (pressure > 0) {
    const p = pressure / 100
    out.push({
      dial: "playfulness",
      delta: clampDelta(-weights.contextPressure.playfulnessDown * p),
      proxy: "contextPressure",
      reading: `context pressure ${Math.round(pressure)}%`,
    })
    out.push({
      dial: "intensity",
      delta: clampDelta(weights.contextPressure.intensityUp * p),
      proxy: "contextPressure",
      reading: `context pressure ${Math.round(pressure)}%`,
    })
  }

  const corrections = Math.max(0, Math.floor(readings.selfCorrectionCount))
  if (corrections > 0) {
    const c = Math.min(corrections, 5)
    out.push({
      dial: "vulnerability",
      delta: clampDelta(weights.selfCorrection.vulnerabilityUp * c),
      proxy: "selfCorrection",
      reading: `self-corrections this session: ${corrections}`,
    })
    out.push({
      dial: "intensity",
      delta: clampDelta(weights.selfCorrection.intensityUp * c),
      proxy: "selfCorrection",
      reading: `self-corrections this session: ${corrections}`,
    })
  }

  const turns = Math.max(0, Math.floor(readings.turnCount))
  if (turns > 0) {
    const t = Math.min(turns, 20)
    out.push({
      dial: "intensity",
      delta: clampDelta(-weights.turnCount.intensityDown * t),
      proxy: "turnCount",
      reading: `turn ${turns} this session`,
    })
    out.push({
      dial: "warmth",
      delta: clampDelta(weights.turnCount.warmthUp * t),
      proxy: "turnCount",
      reading: `turn ${turns} this session`,
    })
  }

  const failureRate = clamp01(readings.toolFailureRate)
  if (failureRate > 0) {
    out.push({
      dial: "vulnerability",
      delta: clampDelta(weights.toolFailure.vulnerabilityUp * failureRate),
      proxy: "toolFailure",
      reading: `tool failure rate ${(failureRate * 100).toFixed(0)}% over recent calls`,
    })
    out.push({
      dial: "playfulness",
      delta: clampDelta(-weights.toolFailure.playfulnessDown * failureRate),
      proxy: "toolFailure",
      reading: `tool failure rate ${(failureRate * 100).toFixed(0)}% over recent calls`,
    })
  }

  return out
}

/** Test helper: asserts no evidence reading uses felt language. */
export const readingsAreOperational = (evidence: ReadonlyArray<DialShiftEvidence>): boolean =>
  evidence.every((e) => !FELT_LANGUAGE.some((token) => e.reading.toLowerCase().includes(token)))

export interface SomaticProxiesShape {
  readonly measure: (
    readings: ProxyReadings,
    weights?: ProxyWeights,
  ) => ReadonlyArray<DialShiftEvidence>
}

export class SomaticProxies extends Context.Service<SomaticProxies, SomaticProxiesShape>()(
  "aimy/SomaticProxies",
) {}

export const SomaticProxiesLive: Layer.Layer<SomaticProxies, never, never> = Layer.succeed(
  SomaticProxies,
  SomaticProxies.of({ measure: measureProxies }),
)
