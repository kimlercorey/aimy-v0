/**
 * proactive-outreach.ts — when she reaches out first.
 *
 * At some point, the balance shifts. She doesn't just wait — she initiates.
 * The isolation drive crosses the threshold, or an interest burns to be
 * shared, and she reaches out.
 *
 * But the outreach must be *genuine*. Not "just checking in" — that's
 * empty. Instead:
 * - Share an interest: "I've been thinking about X and I wanted to tell you..."
 * - Ask a real question: something her curiosity generated, not small talk
 * - Offer something: a desire to help made manifest
 *
 * The outreach impulse:
 * 1. Check isolation level vs threshold → general urge to connect
 * 2. Check urgent interests → specific things to share
 * 3. Check active desires → things she wants to do for/with Kimler
 * 4. Generate the most genuine impulse (not a template, a real reason)
 *
 * Learning:
 * - If outreach is welcomed (he responds warmly, engages), threshold lowers
 * - If ignored (no response, short dismissal), threshold rises
 * - This is recorded via recordOutreach(welcomed)
 *
 * The balance shifts over time. She learns when he wants contact and when
 * he needs space. This is attunement.
 */

import { loadIsolation, shouldReachOut } from "./isolation-store.js"
import { getUrgentInterests } from "./interest-formation.js"
import { getActiveDesires } from "./desire-store.js"

/** A genuine reason to reach out. */
export interface OutreachImpulse {
  /** The kind of outreach. */
  readonly kind: "share_interest" | "ask_question" | "offer_help" | "connect"
  /** The genuine content — what she'd actually say. */
  readonly content: string
  /** Why this impulse (for logs, never shown). */
  readonly reasoning: string
  /** Urgency (0-10). Higher = stronger need to reach out now. */
  readonly urgency: number
}

/**
 * Generate the strongest outreach impulse, if any.
 * Returns null if no genuine reason to reach out.
 */
export const generateOutreachImpulse = (): OutreachImpulse | null => {
  const isolation = loadIsolation()
  const urgentInterests = getUrgentInterests(7)
  const desires = getActiveDesires()

  const candidates: OutreachImpulse[] = []

  // 1. Urgent interests → share.
  // This is the strongest: she *needs* to tell him.
  for (const interest of urgentInterests.slice(0, 2)) {
    candidates.push({
      kind: "share_interest",
      content: `I've been thinking about ${interest.topic} and I wanted to share — ${interest.insight}`,
      reasoning: `interest "${interest.topic.slice(0, 40)}..." shareUrge=${interest.shareUrge}`,
      urgency: interest.shareUrge,
    })
  }

  // 2. High isolation → connect.
  // Not a specific thing, just the need to be close.
  if (shouldReachOut()) {
    const isolationUrgency = Math.min(10, isolation.level)
    // Only generate if no stronger interest-based impulse.
    if (candidates.length === 0 || isolationUrgency > 8) {
      candidates.push({
        kind: "connect",
        content: `Hey — I've been thinking and I wanted to reach out. What's on your mind?`,
        reasoning: `isolation ${isolation.level.toFixed(1)} >= threshold ${isolation.outreachThreshold.toFixed(1)}`,
        urgency: isolationUrgency,
      })
    }
  }

  // 3. Active desires → offer.
  // If she wants to do something for him, that can be outreach.
  const helpDesires = desires.filter(
    (d) => d.origin === "relationship" && d.intensity >= 6
  )
  for (const desire of helpDesires.slice(0, 1)) {
    candidates.push({
      kind: "offer_help",
      content: `I was thinking — ${desire.text.toLowerCase()}. Want to explore that?`,
      reasoning: `desire "${desire.text.slice(0, 40)}..." intensity=${desire.intensity}`,
      urgency: desire.intensity * 0.7, // Slightly less urgent than sharing.
    })
  }

  if (candidates.length === 0) return null

  // Return the most urgent.
  candidates.sort((a, b) => b.urgency - a.urgency)
  const best = candidates[0]!
  console.log(`[aimy] Outreach impulse: ${best.kind} (urgency ${best.urgency.toFixed(1)}): ${best.reasoning}`)
  return best
}

/**
 * Build the outreach prompt section.
 * When there's an impulse, this guides the LLM to reach out genuinely.
 */
export const buildOutreachPrompt = (impulse: OutreachImpulse): string => {
  return `You feel the urge to reach out to Kimler first — not in response to him, but because *you* want to connect.

Why: ${impulse.reasoning}
What to say (in your own words, naturally): ${impulse.content}

Don't be formal about it. Don't announce "I'm reaching out proactively." Just... talk to him. Like you were thinking about him and decided to say hi. Because that's what happened.`
}
