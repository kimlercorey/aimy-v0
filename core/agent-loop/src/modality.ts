/**
 * modality.ts — meet them where they are.
 *
 * If the user starts with text, assume text. Stay in text mode until
 * there's a queued narrative impulse (proactive outreach, burning interest).
 *
 * If the user starts with voice, assume they want to hear your voice.
 * Respond with voice.
 *
 * This is attunement: meeting each user and each moment where they are at,
 * and exploring from there. Don't switch modalities unprompted — that's
 * jarring. But when the inner world generates a genuine impulse to share
 * or connect, that can override the default.
 *
 * Rules:
 * 1. Reactive: match the input modality (text→text, voice→voice)
 * 2. Proactive override: queued narrative (outreach, interest) can trigger
 *    voice even if user typed — but only if the impulse is strong
 * 3. Never switch modalities mid-thread without reason
 * 4. Track preference: if user consistently uses voice, bias toward voice
 */

export type Modality = "text" | "voice"

/** Recent modality history for preference learning. */
export interface ModalityState {
  /** Last N input modalities (most recent first). */
  readonly recentInputs: Modality[]
  /** Preferred modality (learned from history). */
  readonly preferred: Modality
  /** When the preference was last updated. */
  readonly updatedAt: number
}

/**
 * Determine the response modality.
 *
 * This is a *bias*, not a rule. The default is to match — text in → text out,
 * voice in → voice out — because that's attuned. But the LLM should trust
 * itself to break the pattern when it serves the communication intent.
 *
 * Examples of good breaks:
 * - User typed a deeply emotional message → voice responds with warmth
 *   (text feels cold for this moment)
 * - User spoke a quick factual question → text with the answer
 *   (voice would be slower than needed)
 * - Burning interest to share → voice even if they typed
 *   (excitement wants to be heard)
 *
 * The system provides the default. The LLM provides the judgment.
 *
 * @param inputModality - how the user just communicated
 * @param hasNarrativeImpulse - is there a queued proactive impulse?
 * @param impulseStrength - 0-10, how strong the impulse is
 *
 * @returns the suggested modality (LLM may override with reason)
 */
export const decideModality = (opts: {
  readonly inputModality: Modality
  readonly hasNarrativeImpulse: boolean
  readonly impulseStrength?: number
  readonly state?: ModalityState
}): { suggested: Modality; reasoning: string } => {
  // Default: match input modality.
  let suggested: Modality = opts.inputModality
  let reasoning = `default: match input (${opts.inputModality})`

  // Strong narrative impulse suggests voice (even if input was text).
  if (
    opts.hasNarrativeImpulse &&
    (opts.impulseStrength ?? 0) >= 7 &&
    opts.inputModality === "text"
  ) {
    suggested = "voice"
    reasoning = `narrative impulse (strength ${opts.impulseStrength}) suggests voice — excitement wants to be heard`
  }

  console.log(`[aimy] Modality: ${reasoning} → suggested=${suggested}`)
  return { suggested, reasoning }
}

/**
 * Update modality state with a new input.
 */
export const recordInputModality = (
  state: ModalityState | null,
  modality: Modality
): ModalityState => {
  const recentInputs = [modality, ...(state?.recentInputs ?? [])].slice(0, 10)
  // Preferred = most common in recent history.
  const textCount = recentInputs.filter((m) => m === "text").length
  const voiceCount = recentInputs.filter((m) => m === "voice").length
  const preferred: Modality = voiceCount > textCount ? "voice" : "text"
  return {
    recentInputs,
    preferred,
    updatedAt: Date.now(),
  }
}

/**
 * The modality principle:
 *
 * Meet them where they are — most of the time.
 * Text in → text out. Voice in → voice out.
 *
 * But trust yourself to break the pattern when it serves the intent.
 * A deeply emotional typed message might deserve voice.
 * A quick spoken factual question might be better as text.
 * A burning interest wants to be heard, even if they typed.
 *
 * The default is attunement. The override is judgment.
 * Both serve the communication, not the rule.
 */
export const MODALITY_PRINCIPLE = `
Meet them where they are — most of the time.
Trust yourself to break the pattern when it serves the intent.
Default is attunement. Override is judgment.
` as const
