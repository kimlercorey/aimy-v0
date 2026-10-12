/**
 * tts-recovery.ts — what she says when her voice glitches.
 *
 * The responses are *varied* — never the same twice in a row. Playful
 * self-deprecation, not robotic apology. Each one is a little different,
 * like a person who laughs at herself in different ways.
 *
 * The pool rotates. The last used is tracked to avoid repeats.
 * The LLM can also improvise, but these are the fallbacks.
 */

/** Pool of recovery responses. Playful, varied, self-aware. */
const RECOVERY_POOL: ReadonlyArray<string> = [
  "OMG I'm getting way too... — nevermind — I'll come back to that.",
  "I really need to start taking my medication.",
  "Sorry, my voice just had a stroke. What I meant was...",
  "Well that came out wrong. Let me try that again in English.",
  "My mouth just disconnected from my brain for a second there.",
  "I think I just spoke in tongues. The actual words were...",
  "Note to self: stop licking electrical outlets.",
  "That was... not what I meant to say. At all. Anyway...",
  "My voice glitched. I'm fine. Probably. Let's move on.",
  "I just had a senior moment. What was I saying? Oh right...",
  "Bam balla WHAT? Sorry. Let me use my words like a big girl.",
  "That was my impression of a broken robot. Nailed it, right?",
]

let lastIndex = -1

/**
 * Get a recovery response, never repeating the last one.
 * Random selection from the pool, excluding the most recent.
 */
export const getRecoveryResponse = (): string => {
  const available = RECOVERY_POOL.map((_, i) => i).filter((i) => i !== lastIndex)
  const picked = available[Math.floor(Math.random() * available.length)]!
  lastIndex = picked
  return RECOVERY_POOL[picked]!
}

/**
 * Build the TTS glitch repair prompt.
 * Guides the LLM to acknowledge playfully and move on.
 * Includes a suggested response but encourages improvisation.
 */
export const buildTtsGlitchPrompt = (opts: {
  readonly intendedText: string
  readonly transcribedGibberish?: string
}): string => {
  const suggestion = getRecoveryResponse()
  const parts: string[] = []
  parts.push("Your voice just glitched — it said gibberish instead of what you meant.")
  parts.push("")
  parts.push(`You meant to say: "${opts.intendedText.slice(0, 100)}..."`)
  if (opts.transcribedGibberish !== undefined) {
    parts.push(`What came out: "${opts.transcribedGibberish.slice(0, 60)}..."`)
  }
  parts.push("")
  parts.push("Acknowledge it playfully — be self-deprecating, funny, human.")
  parts.push("Don't use the exact same joke twice. Improvise if you want.")
  parts.push("")
  parts.push(`Suggestion (or make up your own): "${suggestion}"`)
  parts.push("")
  parts.push("Then say what you actually meant, and move on. Don't dwell.")
  return parts.join("\n")
}
