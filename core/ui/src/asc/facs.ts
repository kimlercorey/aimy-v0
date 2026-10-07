/**
 * FACS expression engine — dials → Action Units.
 *
 * A deterministic, PURE function from the ASC dial vector to an AU frame.
 * The AU set:
 * - brow: `browRaise` (AU1+2), `browLower` (AU4)
 * - eyes: `eyeOpen` (AU5), `lidTighten` (AU7)
 * - mouth: `smile` (AU12), `mouthCornerDepress` (AU15), `lipPress` (AU24),
 *   `jawDrop` (AU26)
 * - head: `headTiltDeg` (roll, degrees)
 *
 * Mapping rules (n_d = dial/10 ∈ [0,1]):
 * - Intensity is the global gain: `gain = 0.35 + 0.65·n_intensity`. A flat
 *   register barely moves the face; a hot one moves it fully.
 * - Warmth drives the mouth valence: smile rises with warmth, corner-depress
 *   with its absence.
 * - Playfulness lifts the brow and unlocks the smile; its absence presses
 *   the lips.
 * - Vulnerability drops the jaw (openness) and rolls the head.
 *
 * All outputs are clamped to [0,1] (degrees to [−12,12]) and rounded to 3
 * decimals, so frames are stable, comparable, and testable.
 */

export interface DialInput {
  readonly warmth: number
  readonly playfulness: number
  readonly intensity: number
  readonly vulnerability: number
}

export interface AUFrame {
  /** AU1+2 inner/outer brow raise, [0,1]. */
  readonly browRaise: number
  /** AU4 brow lower/furrow, [0,1]. */
  readonly browLower: number
  /** AU5 upper-lid raise, [0,1]. */
  readonly eyeOpen: number
  /** AU7 lid tighten, [0,1]. */
  readonly lidTighten: number
  /** AU12 lip-corner pull (smile), [0,1]. */
  readonly smile: number
  /** AU15 lip-corner depress, [0,1]. */
  readonly mouthCornerDepress: number
  /** AU24 lip press, [0,1]. */
  readonly lipPress: number
  /** AU26 jaw drop, [0,1]. */
  readonly jawDrop: number
  /** Head roll, degrees, [−12,12]. */
  readonly headTiltDeg: number
}

/** The AU channels in a fixed order (rendering + tests). */
export const AU_NAMES = [
  "browRaise",
  "browLower",
  "eyeOpen",
  "lidTighten",
  "smile",
  "mouthCornerDepress",
  "lipPress",
  "jawDrop",
] as const
export type AUName = (typeof AU_NAMES)[number]

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))
const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** Pure: dial vector → AU frame. Deterministic; no I/O, no state. */
export const dialsToAUFrame = (dials: DialInput): AUFrame => {
  const nw = clamp01(dials.warmth / 10)
  const np = clamp01(dials.playfulness / 10)
  const ni = clamp01(dials.intensity / 10)
  const nv = clamp01(dials.vulnerability / 10)

  const gain = 0.35 + 0.65 * ni

  return {
    browRaise: round3(np * gain),
    browLower: round3((1 - nw) * ni * 0.8),
    eyeOpen: round3(ni * gain),
    lidTighten: round3(ni * ni * 0.5),
    smile: round3(nw * (0.6 + 0.4 * np) * gain),
    mouthCornerDepress: round3((1 - nw) * (1 - np) * 0.7),
    lipPress: round3((1 - np) * ni * 0.6),
    jawDrop: round3(nv * 0.5 * gain),
    headTiltDeg: round3((nv - 0.5) * 24),
  }
}

/** Mean activation of the [0,1] AU channels — the frame's overall energy. */
export const frameActivation = (frame: AUFrame): number => {
  const sum =
    frame.browRaise +
    frame.browLower +
    frame.eyeOpen +
    frame.lidTighten +
    frame.smile +
    frame.mouthCornerDepress +
    frame.lipPress +
    frame.jawDrop
  return round3(sum / AU_NAMES.length)
}
