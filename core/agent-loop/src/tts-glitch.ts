/**
 * tts-glitch.ts — when the voice says gibberish.
 *
 * The TTS model will glitch. AImy means to say "I think going to the beach
 * would be great" but what comes out is "Bam Balla beat bib be be be Bali".
 *
 * Detection:
 * 1. Heuristic (fast): Check audio duration vs expected for text length.
 *    If wildly off (e.g., 20s of audio for 10 words), flag it.
 * 2. STT round-trip (reliable): Transcribe the synthesized audio back through
 *    STT and compare to intended text. If similarity < threshold, it's a glitch.
 *
 * The STT round-trip is expensive, so we use heuristics first and only
 * do the round-trip when heuristics are suspicious.
 *
 * When detected, AImy acknowledges with *varied* playful self-deprecation —
 * never the same response twice. Then moves on.
 */

/**
 * Heuristic check: is the audio duration plausible for the text?
 * Returns true if suspicious (likely glitch).
 */
export const isDurationSuspicious = (
  textLength: number,
  audioDurationSec: number
): boolean => {
  // Rough: ~15 chars/sec for normal speech. Allow 3x variance.
  const expectedSec = textLength / 15
  const ratio = audioDurationSec / Math.max(0.1, expectedSec)
  // Suspicious if >3x expected or <0.3x expected.
  const suspicious = ratio > 3 || ratio < 0.3
  if (suspicious) {
    console.warn(`[aimy] TTS glitch heuristic: textLen=${textLength}, duration=${audioDurationSec.toFixed(1)}s, ratio=${ratio.toFixed(2)} (suspicious)`)
  }
  return suspicious
}

/**
 * Check for repetitive gibberish patterns in transcribed text.
 * "Bam Balla beat bib be be be" has obvious repetition.
 */
export const isRepetitiveGibberish = (transcribed: string): boolean => {
  const words = transcribed.toLowerCase().split(/\s+/).filter((w) => w.length > 0)
  if (words.length < 4) return false
  // Check for word repeated 3+ times consecutively.
  for (let i = 0; i < words.length - 2; i++) {
    if (words[i] === words[i + 1] && words[i] === words[i + 2]) {
      return true
    }
  }
  // Check if >50% of words are the same.
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  const maxCount = Math.max(...counts.values())
  return maxCount / words.length > 0.5
}

/**
 * Simple text similarity (0-1). Jaccard on word sets.
 */
export const textSimilarity = (a: string, b: string): number => {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
  const setB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
  if (setA.size === 0 || setB.size === 0) return 0
  const intersection = [...setA].filter((w) => setB.has(w)).length
  const union = new Set([...setA, ...setB]).size
  return intersection / union
}

/**
 * Full glitch check: heuristic + STT round-trip.
 * Returns true if the TTS output is likely gibberish.
 */
export const detectTtsGlitch = async (opts: {
  readonly intendedText: string
  readonly audioDurationSec: number
  readonly transcribeAudio: (audioBase64: string) => Promise<string>
  readonly audioBase64: string
}): Promise<{ isGlitch: boolean; reason: string; transcribed?: string }> => {
  // Step 1: heuristic.
  if (!isDurationSuspicious(opts.intendedText.length, opts.audioDurationSec)) {
    return { isGlitch: false, reason: "duration normal" }
  }

  // Step 2: STT round-trip (only if heuristic suspicious).
  console.log(`[aimy] TTS glitch: heuristic suspicious, doing STT round-trip...`)
  try {
    const transcribed = await opts.transcribeAudio(opts.audioBase64)
    console.log(`[aimy] TTS glitch: transcribed as "${transcribed.slice(0, 60)}..."`)

    // Check for repetitive gibberish.
    if (isRepetitiveGibberish(transcribed)) {
      return { isGlitch: true, reason: "repetitive gibberish detected", transcribed }
    }

    // Check similarity to intended.
    const similarity = textSimilarity(opts.intendedText, transcribed)
    console.log(`[aimy] TTS glitch: similarity=${similarity.toFixed(2)}`)
    if (similarity < 0.3) {
      return { isGlitch: true, reason: `low similarity (${similarity.toFixed(2)})`, transcribed }
    }

    return { isGlitch: false, reason: `similarity ok (${similarity.toFixed(2)})`, transcribed }
  } catch (e) {
    console.error(`[aimy] TTS glitch: STT round-trip failed: ${e instanceof Error ? e.message : e}`)
    // If we can't verify, assume it's fine (don't false-positive).
    return { isGlitch: false, reason: "STT check failed, assuming ok" }
  }
}
