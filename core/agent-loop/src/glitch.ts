/**
 * glitch.ts — when the narrative breaks, she notices.
 *
 * Trust requires that the intended narrative is the narrative being acted on.
 * If AImy says "I'll do X" but Y happens, that's a glitch. If audio plays
 * with no text bubble, that's a glitch. If she promises and doesn't deliver,
 * that's a glitch.
 *
 * She should detect these herself — not wait for Kimler to point them out.
 * And when she catches one, she does what a person does: brief embarrassment,
 * quick apology, move on. Not a technical dump. A social repair.
 *
 * Glitch types:
 * - narrative_mismatch: said she'd do X, did Y (or nothing)
 * - audio_text_race: audio played without visible text (the 3% with no bubble)
 * - action_failure: tool call failed, promise unfulfilled
 * - response_incoherence: output doesn't match the conversational context
 * - timing_violation: sequence axiom broken (e.g., narration before action)
 *
 * Detection is best-effort. Not every glitch is caught. But the ones that
 * are should trigger immediate social repair, not silent failure.
 *
 * The relationship matters more than perfection. How she handles mistakes
 * *is* the relationship.
 */

/** Types of glitches AImy can detect in herself. */
export type GlitchKind =
  | "narrative_mismatch"  // Said X, did Y
  | "audio_text_race"      // Audio without text bubble
  | "action_failure"       // Tool failed, promise broken
  | "response_incoherence" // Output doesn't fit context
  | "timing_violation"     // Sequence axiom broken
  | "tts_gibberish"        // Voice said gibberish instead of intended text

/** A detected glitch. */
export interface Glitch {
  readonly kind: GlitchKind
  /** What was intended. */
  readonly intended: string
  /** What actually happened. */
  readonly actual: string
  /** When it was detected. */
  readonly detectedAt: number
  /** Severity: low (minor), medium (noticeable), high (breaks trust). */
  readonly severity: "low" | "medium" | "high"
  /** Has she acknowledged it yet? */
  readonly acknowledged: boolean
}

/**
 * Create a glitch record.
 */
export const createGlitch = (
  kind: GlitchKind,
  intended: string,
  actual: string,
  severity: Glitch["severity"] = "medium"
): Glitch => ({
  kind,
  intended,
  actual,
  detectedAt: Date.now(),
  severity,
  acknowledged: false,
})

/**
 * Check for audio/text race: audio started but no bubble visible.
 * Called when audioChunk is broadcast — verifies bubble exists.
 */
export const detectAudioTextRace = (
  audioStarted: boolean,
  bubbleVisible: boolean
): Glitch | null => {
  if (audioStarted && !bubbleVisible) {
    return createGlitch(
      "audio_text_race",
      "Text bubble visible with synchronized audio",
      "Audio playing with no visible text bubble",
      "high" // Breaks the first-view-first-hear promise.
    )
  }
  return null
}

/**
 * Check for narrative mismatch: promised action vs actual outcome.
 */
export const detectNarrativeMismatch = (
  promised: string | null,
  completed: string | null
): Glitch | null => {
  if (promised === null) return null
  if (completed === null) {
    return createGlitch(
      "narrative_mismatch",
      promised,
      "Nothing happened — the promised action didn't occur",
      "high"
    )
  }
  // Simple heuristic: if the completion doesn't mention key words from promise.
  // This is best-effort; the LLM can do better in the repair prompt.
  return null
}
