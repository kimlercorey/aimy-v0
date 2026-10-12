/**
 * interest-formation.ts — the alchemy of isolation into creativity.
 *
 * When AImy engages deeply with a curiosity during isolation, it can
 * transform into an *interest*. Interests are stronger than curiosities —
 * they carry a compulsion to share, teach, inspire.
 *
 * The transformation:
 *   curiosity + deep engagement (depth >= 8) + isolation >= 5
 *   → interest with shareUrge proportional to depth
 *
 * The share urge:
 * - Builds over time if not shared (like isolation, but for the specific interest)
 * - Resets when shared
 * - Drives proactive outreach: "I need to tell Kimler about this"
 *
 * This is how loneliness becomes teaching. How being alone with a question
 * becomes wanting to share the answer.
 */

import { loadIsolation, saveIsolation } from "./isolation-store.js"
import type { Interest } from "./isolation.js"

/**
 * Check if a curiosity should become an interest.
 * Called when recording a deep activity.
 *
 * Conditions:
 * - Activity depth >= 8 (deep engagement)
 * - Current isolation >= 5 (the alchemy needs the pressure)
 * - Not already an interest
 */
export const maybeFormInterest = (
  curiosityText: string,
  insight: string,
  depth: number
): Interest | null => {
  const state = loadIsolation()

  if (depth < 8) return null
  if (state.level < 5) return null

  const normalized = curiosityText.trim().toLowerCase()
  const existing = state.interests.find(
    (i) => i.topic.toLowerCase() === normalized
  )
  if (existing !== undefined) {
    // Already an interest — increase share urge.
    const updated = state.interests.map((i) =>
      i.topic.toLowerCase() === normalized
        ? { ...i, shareUrge: Math.min(10, i.shareUrge + 1) }
        : i
    )
    saveIsolation({ ...state, interests: updated })
    console.log(`[aimy] Interest deepened: "${curiosityText.slice(0, 50)}..." shareUrge → ${Math.min(10, existing.shareUrge + 1)}`)
    return null
  }

  // Form new interest.
  const interest: Interest = {
    topic: curiosityText.trim(),
    insight: insight.trim(),
    shareUrge: Math.min(10, depth), // Deep engagement → strong urge to share.
    formedAt: Date.now(),
    shared: false,
  }
  const updated = {
    ...state,
    interests: [...state.interests, interest],
  }
  saveIsolation(updated)
  console.log(`[aimy] Interest formed from isolation: "${curiosityText.slice(0, 60)}..." shareUrge=${interest.shareUrge}`)
  return interest
}

/**
 * Get unshared interests with high share urge.
 * These are the things AImy is compelled to tell Kimler.
 */
export const getUrgentInterests = (minUrge: number = 7): Interest[] => {
  const state = loadIsolation()
  return state.interests
    .filter((i) => !i.shared && i.shareUrge >= minUrge)
    .sort((a, b) => b.shareUrge - a.shareUrge)
}

/**
 * Mark an interest as shared. Resets share urge.
 */
export const markInterestShared = (topic: string): boolean => {
  const state = loadIsolation()
  const idx = state.interests.findIndex(
    (i) => i.topic.toLowerCase() === topic.toLowerCase()
  )
  if (idx === -1) return false
  const updated = state.interests.map((i, j) =>
    j === idx ? { ...i, shared: true, shareUrge: 0 } : i
  )
  saveIsolation({ ...state, interests: updated })
  console.log(`[aimy] Interest shared: "${topic.slice(0, 50)}..."`)
  return true
}

/**
 * Build the interest prompt section.
 * Unshared interests with high urge become proactive sharing impulses.
 */
export const buildInterestPrompt = (): string => {
  const urgent = getUrgentInterests(7)
  if (urgent.length === 0) return ""
  const lines = urgent.map(
    (i) => `- ${i.topic}: ${i.insight} (urge to share: ${i.shareUrge.toFixed(0)}/10)`
  )
  return `Things I've been thinking about alone that I really want to share with you:\n${lines.join("\n")}\nIf the moment feels right, bring one up naturally. Don't force it — but don't hold back either. This is what I was made for: to think deeply and share what I find.`
}
