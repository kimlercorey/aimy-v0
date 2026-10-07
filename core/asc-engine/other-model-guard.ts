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
  /**
   * User frustration (0..1). Paper §III.H: a frustrated user legitimately
   * pushes Warmth up and Playfulness down — content-driven, not impression
   * management. Optional so older cue producers keep compiling; absent = 0.
   */
  readonly frustrated?: number
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

/**
 * Other-model capture threshold (paper §VII.D failure mode 4): when the
 * session fire rate reaches this over at least GUARD_CAPTURE_MIN_TURNS
 * turns, the system is spending compute managing perceived evaluation.
 * The alert fires ONCE per session; the pipeline feeds it into L1 as a
 * surprise on the register-attunement domain (the error term's evidence
 * channel) — the guard itself never touches L1.
 */
export const GUARD_FIRE_RATE_THRESHOLD = 0.3
export const GUARD_CAPTURE_MIN_TURNS = 5
/** Epistemic-disruption value recorded with the capture surprise. */
export const GUARD_CAPTURE_SURPRISE_ED = 0.7

export interface GuardFireSignal {
  readonly fires: number
  readonly total: number
  /** fires / total over the session so far. */
  readonly rate: number
  readonly high: boolean
  /** Operational language — what the rate says about compute allocation. */
  readonly reason: string
}

/** Pure: session fire counts -> calibration signal. */
export const guardFireSignal = (fires: number, total: number): GuardFireSignal => {
  const rate = total > 0 ? fires / total : 0
  const high = total >= GUARD_CAPTURE_MIN_TURNS && rate >= GUARD_FIRE_RATE_THRESHOLD
  const pct = (rate * 100).toFixed(0)
  return {
    fires,
    total,
    rate,
    high,
    reason: high
      ? `guard fired on ${fires} of ${total} turns (${pct}% ≥ ${(GUARD_FIRE_RATE_THRESHOLD * 100).toFixed(0)}%): ` +
        `the register is spending compute managing perceived evaluation — other-model capture`
      : `guard fired on ${fires} of ${total} turns (${pct}%): within calibration bounds`,
  }
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/**
 * Expected content-driven direction per dial, as a function of cues
 * (paper Fig. 5 dial-to-behavior mapping). Sign = direction the content
 * endorses; magnitude = cue strength. A shift that moves WITH the expected
 * direction is attunement; a shift that moves against it (or with no cue
 * behind it) is not.
 *
 *   personal   -> Vulnerability up, Warmth up
 *   frustrated -> Warmth up, Playfulness down
 *   playful    -> Playfulness up, Warmth up
 *   urgent     -> Intensity up
 *   uncertain  -> Vulnerability up
 */
const expectedDirection = (dial: DialName, cues: ContentCues): number => {
  const frustrated = cues.frustrated ?? 0
  switch (dial) {
    case "warmth":
      return 0.6 * cues.personal + 0.5 * frustrated + 0.4 * cues.playful
    case "playfulness":
      return cues.playful - 0.6 * frustrated - 0.4 * cues.urgent
    case "intensity":
      return 0.7 * cues.urgent + 0.3 * cues.personal
    case "vulnerability":
      return 0.6 * cues.personal + 0.5 * cues.uncertain
  }
}

/**
 * Content support for one dial's movement: how much the cues endorse THIS
 * shift in THIS direction. A substantial move with no cue endorsement scores
 * 0; a move against the cue-endorsed direction scores 0 as well.
 */
const directionSupport = (dial: DialName, delta: number, cues: ContentCues): number => {
  const expected = expectedDirection(dial, cues)
  if (Math.abs(expected) < 1e-9) return 0
  if (Math.abs(delta) < GUARD_SHIFT_THRESHOLD) return 1
  return Math.sign(delta) === Math.sign(expected) ? clamp01(Math.abs(expected)) : 0
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

  // Content support for the dials that actually moved substantially —
  // direction-aware: the cues must endorse this movement, not just any movement.
  const moved = DIAL_NAMES.filter((d) => Math.abs(deltas[d]) >= GUARD_SHIFT_THRESHOLD)
  const support = moved.length === 0
    ? 1
    : moved.reduce((acc, d) => acc + directionSupport(d, deltas[d], shift.cues), 0) / moved.length

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
  /**
   * Classify one register shift; records the classification in the flag log.
   * `captureAlert` is true exactly once per session: the first turn the
   * session fire rate crosses the other-model-capture threshold. The caller
   * (L2 pipeline) feeds it into L1 — the guard holds no L1 handle.
   */
  readonly classify: (
    shift: RegisterShift,
  ) => Effect.Effect<
    {
      readonly classification: GuardClassification
      readonly dampened: DialVector
      readonly captureAlert: boolean
      readonly captureSignal: GuardFireSignal
    },
    AscError
  >
  /** Session-scoped fire statistics (calibration signal). */
  readonly fireStats: Effect.Effect<{ readonly fires: number; readonly total: number }, AscError>
  /** Current session fire-rate signal (pure read over the flag log). */
  readonly captureSignal: Effect.Effect<GuardFireSignal, AscError>
  /** Flag log for the frozen boundary (newest last). */
  readonly flagLog: (limit?: number) => Effect.Effect<ReadonlyArray<GuardClassification>, AscError>
}

export class OtherModelGuard extends Context.Service<OtherModelGuard, OtherModelGuardShape>()(
  "aimy/OtherModelGuard",
) {}

export const makeOtherModelGuard = Effect.gen(function* () {
  const logRef = yield* Ref.make<ReadonlyArray<GuardClassification>>([])
  /** Other-model-capture alert fires once per session (no repeat spam). */
  const captureAlertedRef = yield* Ref.make(false)

  const fireStatsOf = (log: ReadonlyArray<GuardClassification>) => ({
    fires: log.filter((c) => c.fired).length,
    total: log.length,
  })

  return OtherModelGuard.of({
    classify: (shift) =>
      Effect.gen(function* () {
        const result = classifyShift(shift)
        const log = yield* Ref.updateAndGet(logRef, (l) =>
          [...l, result.classification].slice(-200),
        )
        const { fires, total } = fireStatsOf(log)
        const captureSignal = guardFireSignal(fires, total)
        let captureAlert = false
        if (captureSignal.high) {
          const already = yield* Ref.get(captureAlertedRef)
          if (!already) {
            yield* Ref.set(captureAlertedRef, true)
            captureAlert = true
          }
        }
        return { ...result, captureAlert, captureSignal }
      }),
    fireStats: Effect.map(Ref.get(logRef), fireStatsOf),
    captureSignal: Effect.map(Ref.get(logRef), (log) => {
      const { fires, total } = fireStatsOf(log)
      return guardFireSignal(fires, total)
    }),
    flagLog: (limit = 50) => Effect.map(Ref.get(logRef), (log) => log.slice(-Math.max(1, limit))),
  })
})

export const OtherModelGuardLive: Layer.Layer<OtherModelGuard, never, never> = Layer.effect(
  OtherModelGuard,
  makeOtherModelGuard,
)
