/**
 * tts/wav.ts — minimal WAV utilities for chunk concatenation. Pure.
 *
 * The server returns one WAV per chunk (16-bit PCM, mono). Concatenation
 * keeps the first file's fmt chunk and appends every file's PCM data,
 * rewriting the RIFF/data sizes. Defensive chunk scanning — we only trust
 * "fmt " and "data", everything else is skipped.
 */

const readU32LE = (b: Uint8Array, o: number): number =>
  b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)

const writeU32LE = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 0xff
  b[o + 1] = (v >>> 8) & 0xff
  b[o + 2] = (v >>> 16) & 0xff
  b[o + 3] = (v >>> 24) & 0xff
}

const tag = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!)

interface ParsedWav {
  /** Everything up to and including the "fmt " chunk (the format header). */
  readonly header: Uint8Array
  /** Raw PCM bytes. */
  readonly pcm: Uint8Array
}

/** Parse a WAV file into its format header + PCM. Throws on malformed input. */
export const parseWav = (wav: Uint8Array): ParsedWav => {
  if (wav.length < 44 || tag(wav, 0) !== "RIFF" || tag(wav, 8) !== "WAVE") {
    throw new Error("not a WAV file")
  }
  let o = 12
  let fmtEnd = -1
  let pcm: Uint8Array | undefined
  while (o + 8 <= wav.length) {
    const id = tag(wav, o)
    const size = readU32LE(wav, o + 4)
    if (id === "fmt ") fmtEnd = o + 8 + size
    if (id === "data") {
      pcm = wav.slice(o + 8, o + 8 + size)
      break
    }
    o += 8 + size + (size % 2) // word-aligned
  }
  if (fmtEnd === -1 || pcm === undefined) throw new Error("WAV missing fmt or data chunk")
  return { header: wav.slice(0, fmtEnd), pcm }
}

/**
 * Concatenate WAV files (same format) into one. Pure. Throws on malformed
 * input or empty list.
 */
export const concatWav = (wavs: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (wavs.length === 0) throw new Error("nothing to concatenate")
  const first = parseWav(wavs[0]!)
  const pcms: Array<Uint8Array> = [first.pcm]
  for (let i = 1; i < wavs.length; i++) pcms.push(parseWav(wavs[i]!).pcm)
  const totalPcm = pcms.reduce((n, p) => n + p.length, 0)

  const out = new Uint8Array(12 + (first.header.length - 12) + 8 + totalPcm)
  // RIFF header
  out.set([0x52, 0x49, 0x46, 0x46]) // "RIFF"
  writeU32LE(out, 4, out.length - 8)
  out.set([0x57, 0x41, 0x56, 0x45], 8) // "WAVE"
  // fmt chunk (copied from the first file)
  out.set(first.header.slice(12), 12)
  // data chunk
  const dataAt = first.header.length
  out.set([0x64, 0x61, 0x74, 0x61], dataAt) // "data"
  writeU32LE(out, dataAt + 4, totalPcm)
  let o = dataAt + 8
  for (const p of pcms) {
    out.set(p, o)
    o += p.length
  }
  return out
}
