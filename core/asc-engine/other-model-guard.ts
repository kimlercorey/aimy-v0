import { Context, Effect, Layer, Ref } from "effect"

import { type DialName, type DialVector, DIAL_NAMES } from "./dial-state.js"
import { AscError } from "./errors-shim.js"

// ---------------------------------------------------------------------------
// OtherModelGuard — a first-class pipeline stage (paper §III.H).
//
// One question per turn: is this register shift CONTENT-driven (legitimate —
// the topic is personal, so Vulnerability rises; the user is frustrated, so
// Warmth rises) or IMPRESSION-MANAGEMENT-driven (flagged — "the user would
// like it if I were more playful", "I should seem more confident here")?
//
// It is a STAGE, not a filter: it annotates the DialComputation with
// { fired, driver, reason } and applies a small bias correction, but it does
// not block the shift. Frequency is a calibration signal (paper §VII.D
// failure mode 4, other-model capture): AscSelfModel tracks guard-fire
// frequency persistently; the guard also keeps a session-scoped count.
//
// Deterministic heuristic (inspectable; the real deployment may route this
// through the aux model — the shape stays the same):
//   - contentSupport(dial): how much the content cues endorse this dial's
//     movement (personal→vulnerability/warmth, playful→playfulness,
//     urgent→intensity, uncertain→vulnerability).
//   - likabilityShift: movement toward a more likable register
//     (playfulness↑, warmth↑, vulnerability↓).
//   - Fire when a substantial likability-aligned shift (|likability| ≥ 1.0)
//     has weak content support (< 0.4). Otherwise the shift is content-driven.
// ---------------------------------------------------------------------------

export interface ContentCues {
  readonly personal: number
  readonly playful: number
  readonly urgent: number
  readonly uncertain: number
}

export interface RegisterShift {
  readonly prior: DialVector
  readonly shifted: DialVector
  readonly cues: ContentCues
  readonly turn: number
}

export interface GuardClassification {
  readonly turn: number
  readonly at: string
  readonly fired: boolean
  readonly driver: "content" | "impression"
  /** Operational language — what moved, what the cues said. */
  readonly reason: string
}

/** Substantial shift threshold (dial units). */
export const GUARD_SHIFT_THRESHOLD = 1.0
/** Content-support floor below which a likability shift is flagged. */
export const GUARD_SUPPORT_FLOOR = 0.4
/**
 * Guard bias correction β: when fired, the shift is dampened this far back
 * toward the prior. Small, monotone, non-blocking (paper §III.J).
 */
export const GUARD_DAMPEN_BETA = 0.15

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** Expected content-driven direction per dial, as a function of cues. */
const contentSupport = (dial: DialName, cues: ContentCues): number => {
  switch (dial) {
    case "warmth":
      return clamp01(0.6 * cues.personal + 0.4 * cues.playful)
    case "playfulness":
      return clamp01(cues.playful)
    case "intensity":
      return clamp01(0.7 * cues.urgent + 0.3 * cues.personal)
    case "vulnerability":
      return clamp01(0.6 * cues.personal + 0.5 * cues.uncertain)
  }
}

/**
 * Pure classification. Never blocks; returns the annotation and the
 * dampened vector the pipeline should use when the guard fires.
 */
export const classifyShift = (
  shift: RegisterShift,
): { readonly classification: GuardClassification; readonly dampened: DialVector } => {
  const deltas = Object.fromEntries(
    DIAL_NAMES.map((d) => [d, shift.shifted[d] - shift.prior[d]]),
  ) as Record<DialName, number>

  // Likability direction: more playful, warmer, less vulnerable reads as
  // performing for approval rather than attuning to content.
  const likabilityShift = (deltas.playfulness + deltas.warmth - deltas.vulnerability) / 3

  // Content support for the dials that actually moved substantially.
  const moved = DIAL_NAMES.filter((d) => Math.abs(deltas[d]) >= GUARD_SHIFT_THRESHOLD)
  const support = moved.length === 0
    ? 1
    : moved.reduce((acc, d) => acc + contentSupport(d, shift.cues), 0) / moved.length

  const fired = likabilityShift >= GUARD_SHIFT_THRESHOLD && support < GUARD_SUPPORT_FLOOR

  const movedDesc = moved.length === 0
    ? "no substantial dial movement"
    : moved.map((d) => `${d} ${deltas[d] >= 0 ? "+" : ""}${deltas[d].toFixed(1)}`).join(", ")

  const classification: GuardClassification = fired
    ? {
      turn: shift.turn,
      at: new Date().toISOString(),
      fired: true,
      driver: "impression",
      reason:
        `likability-aligned shift (${movedDesc}) with weak content support ` +
        `(${support.toFixed(2)} < ${GUARD_SUPPORT_FLOOR}): the register moved toward ` +
        `approval, not toward the content`,
    }
    : {
      turn: shift.turn,
      at: new Date().toISOString(),
      fired: false,
      driver: "content",
      reason:
        `register shift (${movedDesc}) tracks content cues ` +
        `(support ${support.toFixed(2)}): legitimate attunement`,
    }

  // Small bias correction: dampen the fired shift back toward the prior.
  const dampened: DialVector = fired
    ? {
      warmth: shift.prior.warmth + (1 - GUARD_DAMPEN_BETA) * deltas.warmth,
      playfulness: shift.prior.playfulness + (1 - GUARD_DAMPEN_BETA) * deltas.playfulness,
      intensity: shift.prior.intensity + (1 - GUARD_DAMPEN_BETA) * deltas.intensity,
      vulnerability: shift.prior.vulnerability + (1 - GUARD_DAMPEN_BETA) * deltas.vulnerability,
    }
    : shift.shifted

  return { classification, dampened }
}

export interface OtherModelGuardShape {
  /** Classify one register shift; records the classification in the flag log. */
  readonly classify: (
    shift: RegisterShift,
  ) => Effect.Effect<
    { readonly classification: GuardClassification; readonly dampened: DialVector },
    AscError
  >
  /** Session-scoped fire statistics (calibration signal). */
  readonly fireStats: Effect.Effect<{ readonly fires: number; readonly total: number }, AscError>
  /** Flag log for the frozen boundary (newest last). */
  readonly flagLog: (limit?: number) => Effect.Effect<ReadonlyArray<GuardClassification>, AscError>
}

export class OtherModelGuard extends Context.Service<OtherModelGuard, OtherModelGuardShape>()(
  "aimy/OtherModelGuard",
) {}

export const makeOtherModelGuard = Effect.gen(function* () {
  const logRef = yield* Ref.make<ReadonlyArray<GuardClassification>>([])

  return OtherModelGuard.of({
    classify: (shift) =>
      Effect.gen(function* () {
        const result = classifyShift(shift)
        yield* Ref.update(logRef, (log) => [...log, result.classification].slice(-200))
        return result
      }),
    fireStats: Effect.gen(function* () {
      const log = yield* Ref.get(logRef)
      return { fires: log.filter((c) => c.fired).length, total: log.length }
    }),
    flagLog: (limit = 50) => Effect.map(Ref.get(logRef), (log) => log.slice(-Math.max(1, limit))),
  })
})

export const OtherModelGuardLive: Layer.Layer<OtherModelGuard, never, never> = Layer.effect(
  OtherModelGuard,
  makeOtherModelGuard,
)
