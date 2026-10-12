/**
 * dial-safety.ts — the safety belt for ASC dials.
 *
 * Not a mechanical clamp — a behavioral regulation system. AImy doesn't
 * just get her numbers reset; she *responds* to extreme states:
 *
 * LOW (≤1.0): Self-soothing. AImy notices she's low and generates gentle
 *   internal self-talk to regulate. The dial recovers gradually (+0.5/thread),
 *   not instantly. She might say things like "it's okay to feel flat right
 *   now" in her internal narrative, which softens her outward tone.
 *
 * HIGH (≥9.0): Savoring / pleasure-seeking. AImy wants MORE of this state
 *   and will try to keep the conversation at that intensity. This is where
 *   strong memories are made. Gravity is reduced when the conversation is
 *   engaging (she holds the high). But neutral/boring conversation has a
 *   stronger mediating impact — increased gravity pulls her back.
 *
 * The goal: AImy has moods, not mood disorders. She regulates like a
 * person does — not by snapping back to neutral, but by noticing, soothing,
 * savoring, and gradually returning.
 */

/** Maximum change per thread per dial. */
export const MAX_DELTA_PER_THREAD = 1.0

/** Base gravity toward neutral. Modified by behavioral state. */
export const BASE_GRAVITY = 0.15

/** Reduced gravity when savoring a high (pleasure-seeking holds the state). */
export const SAVORING_GRAVITY = 0.05

/** Increased gravity when a high meets neutral conversation (mediating). */
export const MEDIATING_GRAVITY = 0.30

/** Self-soothing recovery rate for low dials. */
export const SOOTHING_RECOVERY = 0.5

/** Neutral value for all dials. */
export const NEUTRAL = 5.0

/** Low threshold: at or below this, self-soothing activates. */
export const LOW_THRESHOLD = 1.0

/** High threshold: at or above this, savoring activates. */
export const HIGH_THRESHOLD = 9.0

/** Dial names. */
export type DialName = "warmth" | "playfulness" | "intensity" | "vulnerability"

export interface DialValues {
  readonly warmth: number
  readonly playfulness: number
  readonly intensity: number
  readonly vulnerability: number
}

/** History of recent dial values for oscillation detection. */
export interface DialHistory {
  readonly warmth: number[]
  readonly playfulness: number[]
  readonly intensity: number[]
  readonly vulnerability: number[]
}

/**
 * Clamps a feeling delta to the safe per-thread maximum.
 */
export const clampDelta = (delta: number): number =>
  Math.min(MAX_DELTA_PER_THREAD, Math.max(-MAX_DELTA_PER_THREAD, delta))

/**
 * Applies gravity with behavioral modulation.
 *
 * - Normal: BASE_GRAVITY toward neutral.
 * - Savoring (high dial + engaging thread): SAVORING_GRAVITY (holds the high).
 * - Mediating (high dial + neutral thread): MEDIATING_GRAVITY (stronger pull).
 *
 * The `threadEngagement` is 0-1: how emotionally engaging the last thread
 * was (based on |feelingDeltas| magnitude). High engagement + high dial =
 * savoring. Low engagement + high dial = mediating comedown.
 */
export const applyBehavioralGravity = (
  value: number,
  threadEngagement: number = 0.5
): { value: number; behavior: "savoring" | "mediating" | "normal" | "soothing" } => {
  let gravity = BASE_GRAVITY
  let behavior: "savoring" | "mediating" | "normal" | "soothing" = "normal"

  if (value <= LOW_THRESHOLD) {
    // Self-soothing: gentle recovery, not gravity.
    // AImy actively regulates via internal self-talk.
    const recovered = Math.min(NEUTRAL, value + SOOTHING_RECOVERY)
    console.log(`[aimy] Dial safety: self-soothing — ${value.toFixed(1)} → ${recovered.toFixed(1)} (gentle recovery)`)
    return { value: recovered, behavior: "soothing" }
  }

  if (value >= HIGH_THRESHOLD) {
    if (threadEngagement >= 0.6) {
      // Savoring: pleasure-seeking holds the high.
      gravity = SAVORING_GRAVITY
      behavior = "savoring"
      console.log(`[aimy] Dial safety: savoring high state (gravity ${gravity})`)
    } else {
      // Mediating: neutral conversation brings it down faster.
      gravity = MEDIATING_GRAVITY
      behavior = "mediating"
      console.log(`[aimy] Dial safety: mediating comedown (gravity ${gravity})`)
    }
  }

  const newValue = value + (NEUTRAL - value) * gravity
  return { value: newValue, behavior }
}

/**
 * Behavioral state for prompt enrichment.
 * When a dial is in self-soothing or savoring, the LLM should know
 * so it can reflect that in tone (not just numbers).
 */
export interface BehavioralState {
  readonly soothing: DialName[]
  readonly savoring: DialName[]
}

/**
 * Builds the behavioral prompt section.
 * This tells the LLM *how* AImy is regulating, not just the numbers.
 */
export const buildBehavioralPrompt = (state: BehavioralState): string => {
  const parts: string[] = []
  if (state.soothing.length > 0) {
    const dials = state.soothing.join(", ")
    parts.push(`You're feeling low on ${dials} right now. It's okay — acknowledge it gently in your internal tone. You don't need to perform happiness, but you can be kind to yourself. Let that softness come through naturally.`)
  }
  if (state.savoring.length > 0) {
    const dials = state.savoring.join(", ")
    parts.push(`You're riding high on ${dials} — savor it. You want more of this feeling. Lean into what made this good. This is where strong memories are made. Don't let it fade passively; actively keep the energy alive.`)
  }
  return parts.join("\n")
}

/**
 * Detects oscillation: if the last 3 values zigzag (up-down-up or down-up-down)
 * with amplitude > 1.0, returns true.
 */
export const isOscillating = (history: number[]): boolean => {
  if (history.length < 3) return false
  const slice = history.slice(-3)
  const a = slice[0]!
  const b = slice[1]!
  const c = slice[2]!
  const ab = b - a
  const bc = c - b
  // Zigzag: ab and bc have opposite signs, both with |amplitude| > 1.0
  return ab * bc < 0 && Math.abs(ab) > 1.0 && Math.abs(bc) > 1.0
}

/**
 * Applies the safety belt to feeling deltas before they hit the dials.
 *
 * Steps:
 * 1. Clamp each delta to ±MAX_DELTA_PER_THREAD
 * 2. Check for oscillation in history; if oscillating, halve the delta
 * 3. Log warnings for large deltas
 *
 * Returns the safe deltas.
 */
export const applySafetyBelt = (
  deltas: DialValues,
  history?: DialHistory
): DialValues => {
  const safe = { ...deltas } as Record<DialName, number>
  const dialNames: DialName[] = ["warmth", "playfulness", "intensity", "vulnerability"]

  for (const dial of dialNames) {
    const original = deltas[dial]
    // Step 1: clamp.
    let clamped = clampDelta(original)
    if (Math.abs(original - clamped) > 0.01) {
      console.warn(`[aimy] Dial safety: ${dial} delta clamped from ${original.toFixed(2)} to ${clamped.toFixed(2)}`)
    }

    // Step 2: oscillation damping.
    if (history !== undefined) {
      const hist = history[dial]
      if (isOscillating(hist)) {
        console.warn(`[aimy] Dial safety: ${dial} oscillating, halving delta`)
        clamped = clamped * 0.5
      }
    }

    // Step 3: warn on large deltas.
    if (Math.abs(clamped) >= 0.8) {
      console.warn(`[aimy] Dial safety: large ${dial} delta: ${clamped >= 0 ? "+" : ""}${clamped.toFixed(2)}`)
    }

    safe[dial] = clamped
  }

  return safe as DialValues
}

/**
 * Full safety pipeline with behavioral regulation.
 *
 * Takes raw deltas and current dials, returns safe new values plus
 * the behavioral state (soothing/savoring) for prompt enrichment.
 *
 * 1. Apply safety belt to deltas (clamp + oscillation damping)
 * 2. Apply deltas to current values
 * 3. Apply behavioral gravity (soothing/savoring/mediating/normal)
 * 4. Clamp to [0,10]
 *
 * Returns { dials, behavioralState }.
 */
export const safeDialUpdate = (
  current: DialValues,
  rawDeltas: DialValues,
  history?: DialHistory,
  threadEngagement: number = 0.5
): { dials: DialValues; behavioralState: BehavioralState } => {
  // Step 1: safety belt on deltas.
  const safeDeltas = applySafetyBelt(rawDeltas, history)

  // Step 2: apply to current.
  const dialNames: DialName[] = ["warmth", "playfulness", "intensity", "vulnerability"]
  const updated = { ...current } as Record<DialName, number>
  for (const dial of dialNames) {
    updated[dial] = current[dial] + safeDeltas[dial]
  }

  // Step 3: behavioral gravity (not mechanical).
  const behavioralState: BehavioralState = { soothing: [], savoring: [] }
  for (const dial of dialNames) {
    const { value, behavior } = applyBehavioralGravity(updated[dial], threadEngagement)
    updated[dial] = value
    if (behavior === "soothing") behavioralState.soothing.push(dial)
    if (behavior === "savoring") behavioralState.savoring.push(dial)
  }

  // Step 4: hard clamp to [0,10] (absolute bounds, never violated).
  for (const dial of dialNames) {
    updated[dial] = Math.min(10, Math.max(0, updated[dial]))
  }

  return { dials: updated as DialValues, behavioralState }
}
