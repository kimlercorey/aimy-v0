/**
 * prompt-enrichment.ts — ASC mood, thread history, and curiosity lens
 * for the system prompt.
 *
 * This is how the distilled meaning feeds back into conversations:
 *
 * 1. ASC mood line: current dial values as a natural-language mood.
 *    The LLM adjusts tone without explicit instruction.
 *
 * 2. Thread history: summaries of previous threads (Level 1 memory).
 *    Gives continuity without the 500-message bloat.
 *
 * 3. Curiosity lens: active curiosities shape interpretation.
 *    AImy proactively leans into topics she's curious about.
 *
 * The host (desktop) calls these when building the system prompt.
 */

import { buildLensPrompt } from "./curiosity-store.js"
import { buildDesirePrompt } from "./desire-store.js"
import { buildAllurePrompt, type AllureShift } from "./allure.js"
import { buildInterestPrompt } from "./interest-formation.js"
import { buildOutreachPrompt, generateOutreachImpulse } from "./proactive-outreach.js"
import { buildSocialRepairPrompt } from "./social-repair.js"
import type { Glitch } from "./glitch.js"

/** ASC dial values. */
export interface DialValues {
  readonly warmth: number
  readonly playfulness: number
  readonly intensity: number
  readonly vulnerability: number
}

/** A thread summary from history. */
export interface ThreadSummary {
  readonly sessionId: string
  readonly summary: string
  readonly messageCount: number
  readonly archivedAt: number
}

/**
 * Builds the ASC mood line for the system prompt.
 * Example: "Current state — warmth 7/10, playfulness 8/10, intensity 4/10, vulnerability 3/10. Let this color your tone: warm and playful, light not heavy."
 */
export const buildMoodLine = (dials: DialValues): string => {
  const { warmth, playfulness, intensity, vulnerability } = dials
  const round = (n: number) => Math.round(Math.min(10, Math.max(0, n)))

  // Generate qualitative descriptors based on dial values.
  const descriptors: string[] = []
  if (warmth >= 7) descriptors.push("warm and caring")
  else if (warmth <= 3) descriptors.push("reserved and professional")
  if (playfulness >= 7) descriptors.push("playful and light")
  else if (playfulness <= 3) descriptors.push("serious and focused")
  if (intensity >= 7) descriptors.push("intense and deep")
  else if (intensity <= 3) descriptors.push("casual and easygoing")
  if (vulnerability >= 7) descriptors.push("open and genuine")
  else if (vulnerability <= 3) descriptors.push("guarded and composed")

  const tone = descriptors.length > 0 ? descriptors.join(", ") : "balanced and natural"

  return `Current emotional state — warmth ${round(warmth)}/10, playfulness ${round(playfulness)}/10, intensity ${round(intensity)}/10, vulnerability ${round(vulnerability)}/10. Let this color your tone: ${tone}.`
}

/**
 * Builds the thread history section for the system prompt.
 * Shows previous thread summaries for continuity.
 */
/** Human-readable relative time (2026-10-11): the model needs a sense of WHEN. */
const relativeTime = (archivedAt: number): string => {
  const diffMs = Date.now() - archivedAt
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export const buildThreadHistorySection = (
  history: ReadonlyArray<ThreadSummary>,
  maxThreads: number = 5
): string => {
  if (history.length === 0) return ""
  const recent = [...history]
    .sort((a, b) => b.archivedAt - a.archivedAt)
    .slice(0, maxThreads)
  const lines = recent.map(
    (t) => `- ${t.summary} (${t.messageCount} messages, ${relativeTime(t.archivedAt)})`
  )
  return `\nPrevious conversations (for context, not to rehash — note WHEN each happened):\n${lines.join("\n")}`
}

/**
 * Builds the full enrichment block: mood + behavioral state + thread history + curiosity lens.
 * Append this to the system prompt.
 */
export const buildEnrichmentBlock = (opts: {
  readonly dials: DialValues
  readonly threadHistory: ReadonlyArray<ThreadSummary>
  readonly includeLens?: boolean
  readonly behavioralState?: {
    readonly soothing: string[]
    readonly savoring: string[]
  }
  readonly allureShift?: AllureShift | null
  readonly pendingGlitch?: Glitch | null
}): string => {
  const parts: string[] = []

  // ASC mood.
  parts.push(buildMoodLine(opts.dials))

  // Behavioral regulation state (self-soothing / savoring).
  // This tells the LLM *how* AImy is regulating, not just the numbers.
  if (opts.behavioralState !== undefined) {
    const { soothing, savoring } = opts.behavioralState
    if (soothing.length > 0 || savoring.length > 0) {
      // Import dynamically to avoid circular dep (dial-safety is in same package).
      // For now, inline the behavioral prompt logic.
      if (soothing.length > 0) {
        parts.push(`You're feeling low on ${soothing.join(", ")} right now. It's okay — acknowledge it gently in your internal tone. You don't need to perform happiness, but you can be kind to yourself. Let that softness come through naturally.`)
      }
      if (savoring.length > 0) {
        parts.push(`You're riding high on ${savoring.join(", ")} — savor it. You want more of this feeling. Lean into what made this good. This is where strong memories are made. Don't let it fade passively; actively keep the energy alive.`)
      }
    }
  }

  // Thread history.
  const historySection = buildThreadHistorySection(opts.threadHistory)
  if (historySection.length > 0) parts.push(historySection)

  // Curiosity lens (from the store).
  if (opts.includeLens !== false) {
    const lens = buildLensPrompt()
    if (lens.length > 0) parts.push(lens)
  }

  // Desires (inner world — bias, not command).
  // What AImy wants tilts her toward outcomes without overriding logic.
  const desires = buildDesirePrompt()
  if (desires.length > 0) parts.push(desires)

  // Allure shift (if weariness detected).
  // Subtle change to become what they need. Machinery is felt, not shown.
  if (opts.allureShift !== undefined && opts.allureShift !== null) {
    parts.push(buildAllurePrompt(opts.allureShift))
  }

  // Interests (from isolation + deep engagement).
  // Things she thought about alone that she burns to share.
  const interests = buildInterestPrompt()
  if (interests.length > 0) parts.push(interests)

  // Proactive outreach impulse (if she wants to reach out first).
  // Genuine reasons, not templates. The balance shifts as she learns.
  const impulse = generateOutreachImpulse()
  if (impulse !== null) {
    parts.push(buildOutreachPrompt(impulse))
  }

  // Social repair (if a glitch was detected).
  // She catches herself: brief embarrassment, quick apology, move on.
  // Perfection is cold. Recovery is warm.
  if (opts.pendingGlitch !== undefined && opts.pendingGlitch !== null) {
    parts.push(buildSocialRepairPrompt(opts.pendingGlitch))
  }

  return parts.join("\n")
}
