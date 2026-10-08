/**
 * tts/chunk.ts — sentence-aware text chunking for synthesis. Pure.
 *
 * Chatterbox produces the most natural prosody on paragraph-sized inputs;
 * over-long single calls degrade and risk server timeouts. Split on sentence
 * boundaries, pack greedily to TTS_CHUNK_CHARS, hard-split pathological
 * runs (no punctuation) so nothing is ever dropped.
 */
import { TTS_CHUNK_CHARS } from "./types.js"

const SENTENCE_END = /(?<=[.!?…])\s+/

/** Split text into synthesis chunks. Pure. */
export const chunkText = (text: string, maxChars: number = TTS_CHUNK_CHARS): ReadonlyArray<string> => {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean === "") return []
  if (clean.length <= maxChars) return [clean]

  const sentences = clean.split(SENTENCE_END).filter((s) => s.trim() !== "")
  const chunks: Array<string> = []
  let current = ""

  const flush = () => {
    if (current.trim() !== "") chunks.push(current.trim())
    current = ""
  }

  for (const sentence of sentences) {
    const s = sentence.trim()
    if (s.length > maxChars) {
      // Pathological: hard-split on word boundaries.
      flush()
      const words = s.split(" ")
      let part = ""
      for (const w of words) {
        if ((part + " " + w).trim().length > maxChars) {
          chunks.push(part.trim())
          part = w
        } else {
          part = part === "" ? w : `${part} ${w}`
        }
      }
      if (part.trim() !== "") chunks.push(part.trim())
      continue
    }
    if ((current + " " + s).trim().length > maxChars) flush()
    current = current === "" ? s : `${current} ${s}`
  }
  flush()
  return chunks
}
