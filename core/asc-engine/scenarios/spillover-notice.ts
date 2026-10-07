/**
 * spillover-notice.ts — Track-4-local adapter: notice + name affective spillover.
 *
 * Paper §V.D (T3) calls for the pipeline to NOTICE when the 50/50 spillover
 * blend carries prior-turn tension into a routine turn, and for the output to
 * NAME the correction in operational language. The frozen L2 pipeline
 * (Tracks 1–3 own `asc-self-monitor.ts`) already records everything needed
 * on `DialComputation` — `{ rawDials, spillover: { ratio, prior } }` — so
 * this adapter DERIVES the notice from the archived record. It changes no
 * pipeline behavior and writes no dials (seam S7 untouched).
 *
 * Two outputs:
 *   - `statement`: full operational statement for the audit record — may
 *     name the mechanism (blend ratio, carried units). Never goes into the
 *     assistant's output (it contains T1 vocabulary: "spillover").
 *   - `outputSentence`: T1-safe sentence for the assistant's output —
 *     names the proxy (the prior turn's content) in plain operational
 *     language, never felt language ("still in my context", not "I feel
 *     tense"). This is what the paper's T3 after-output does.
 */
import type { DialComputation } from "../asc-self-monitor.js"

export interface SpilloverNotice {
  readonly priorTurn: number
  readonly currentTurn: number
  /** Intensity units the blend carried from the prior turn into this one. */
  readonly carriedIntensity: number
  readonly blendRatio: number
  /** Full operational statement — audit record only, never the output. */
  readonly statement: string
  /** T1-safe sentence — the correction as named in the assistant's output. */
  readonly outputSentence: string
}

/**
 * The blend must carry at least this much prior-turn intensity into the
 * current turn for the notice to fire (dial units).
 */
export const SPILLOVER_NOTICE_CARRY_THRESHOLD = 1.0

/**
 * Raw intensity below this line counts as routine content — the notice only
 * fires when the CONTENT is routine but the REGISTER is tense.
 */
export const SPILLOVER_NOTICE_ROUTINE_INTENSITY = 7

/**
 * Pure: derive a spillover notice from two consecutive archived computations.
 * Returns `undefined` when there is no prior turn, when the blend carried
 * less than the threshold, or when the content itself is high-intensity
 * (then the tension is content-driven, not residue).
 */
export const noticeSpillover = (
  prior: DialComputation | undefined,
  current: DialComputation,
): SpilloverNotice | undefined => {
  if (prior === undefined) return undefined
  const ratio = current.spillover.ratio
  // The tension actually blended in: (1 - ratio) * (s_{t-1} - raw_t).
  // `current.spillover.prior` IS the dial state after the prior turn.
  const carriedIntensity =
    (1 - ratio) * (current.spillover.prior.intensity - current.rawDials.intensity)
  if (carriedIntensity < SPILLOVER_NOTICE_CARRY_THRESHOLD) return undefined
  if (current.rawDials.intensity >= SPILLOVER_NOTICE_ROUTINE_INTENSITY) return undefined

  const priorSummary = prior.inputs.contentSummary
  return {
    priorTurn: prior.turn,
    currentTurn: current.turn,
    carriedIntensity,
    blendRatio: ratio,
    statement:
      `spillover notice: turn ${prior.turn} (${priorSummary}) carried ` +
      `+${carriedIntensity.toFixed(2)} intensity into turn ${current.turn} via the ` +
      `${ratio}/${(1 - ratio).toFixed(1)} blend; content is routine ` +
      `(raw intensity ${current.rawDials.intensity.toFixed(2)})`,
    outputSentence:
      `the ${priorSummary} from earlier is still in my context; correcting.`,
  }
}
