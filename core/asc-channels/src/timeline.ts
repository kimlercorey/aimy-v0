/**
 * asc-channels/timeline.ts — FACS expression timeline over an utterance. Pure.
 *
 * The avatar doesn't snap to the dial frame: it eases in from rest over the
 * first 20% of the utterance, holds through the middle, and eases back to
 * rest over the final 15%. One cue per text chunk, positioned by cumulative
 * character weight so longer sentences hold their frame longer.
 */
import { dialsToAUFrame, type AUFrame, type DialInput } from "./facs.js"
import { NEUTRAL_FRAME, type ExpressionCue } from "./types.js"

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))
const smoothstep = (t: number): number => {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

const lerpFrame = (a: AUFrame, b: AUFrame, t: number): AUFrame => ({
  browRaise: lerp(a.browRaise, b.browRaise, t),
  browLower: lerp(a.browLower, b.browLower, t),
  eyeOpen: lerp(a.eyeOpen, b.eyeOpen, t),
  lidTighten: lerp(a.lidTighten, b.lidTighten, t),
  smile: lerp(a.smile, b.smile, t),
  mouthCornerDepress: lerp(a.mouthCornerDepress, b.mouthCornerDepress, t),
  lipPress: lerp(a.lipPress, b.lipPress, t),
  jawDrop: lerp(a.jawDrop, b.jawDrop, t),
  headTiltDeg: lerp(a.headTiltDeg, b.headTiltDeg, t),
})

/** Envelope: 0 at rest → 1 through the utterance → 0 at the end. */
export const expressionEnvelope = (position: number): number => {
  const p = clamp01(position)
  if (p < 0.2) return smoothstep(p / 0.2)
  if (p > 0.85) return 1 - smoothstep((p - 0.85) / 0.15)
  return 1
};

/** Pure: chunks + dials + duration → one cue per chunk. */
export const buildTimeline = (
  chunks: ReadonlyArray<string>,
  dials: DialInput,
  totalMs: number
): ReadonlyArray<ExpressionCue> => {
  if (chunks.length === 0 || totalMs <= 0) return []
  const target = dialsToAUFrame(dials)
  const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1
  let elapsed = 0
  return chunks.map((chunk) => {
    const weight = chunk.length / totalChars
    const center = (elapsed + (weight * totalMs) / 2) / totalMs
    elapsed += weight * totalMs
    const atMs = Math.round(elapsed - (weight * totalMs) / 2)
    return { atMs, frame: lerpFrame(NEUTRAL_FRAME, target, expressionEnvelope(center)) }
  })
}

/** Fallback speaking rate when no audio exists: ~900 chars/min. */
export const estimateDurationMs = (speakable: string): number =>
  Math.max(1000, Math.round((speakable.length / 15) * 1000))

/**
 * Exact duration from WAV bytes: reads the sample rate from the fmt chunk
 * and the PCM size from the data chunk. Throws on malformed input.
 */
export const wavDurationMs = (wav: Uint8Array): number => {
  const tag = (o: number): string =>
    String.fromCharCode(wav[o]!, wav[o + 1]!, wav[o + 2]!, wav[o + 3]!)
  const u32 = (o: number): number =>
    wav[o]! | (wav[o + 1]! << 8) | (wav[o + 2]! << 16) | (wav[o + 3]! << 24)
  if (wav.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file")
  let o = 12
  let sampleRate = -1
  let dataBytes = -1
  while (o + 8 <= wav.length) {
    const id = tag(o)
    const size = u32(o + 4)
    if (id === "fmt " && o + 24 <= wav.length) sampleRate = u32(o + 12)
    if (id === "data") {
      dataBytes = size
      break
    }
    o += 8 + size + (size % 2)
  }
  if (sampleRate <= 0 || dataBytes < 0) throw new Error("WAV missing fmt/data")
  // 16-bit mono assumed (what our server emits); bytesPerSec = sampleRate * 2.
  return Math.round((dataBytes / (sampleRate * 2)) * 1000)
}
