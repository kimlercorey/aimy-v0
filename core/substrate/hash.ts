/**
 * substrate/hash.ts — platform-agnostic SHA-256.
 *
 * Pure TypeScript, zero dependencies, synchronous. Produces byte-identical
 * digests to `node:crypto`'s `createHash("sha256")` for the same UTF-8 input.
 *
 * Exists because `node:crypto` cannot be imported in the Electron renderer
 * (vite externalizes it and the named import throws at module evaluation),
 * while content-addressed ids (narrative entries, memory pins, honesty
 * receipts) are computed in modules shared between the main process and
 * the renderer. Import this instead of `node:crypto` anywhere the code may
 * run in the browser context.
 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** SHA-256 of a UTF-8 string, returned as 64 lowercase hex chars. */
export const sha256Hex = (input: string): string => sha256HexBytes(new TextEncoder().encode(input))

/** SHA-256 of raw bytes, returned as 64 lowercase hex chars. */
export const sha256HexBytes = (bytes: Uint8Array): string => {
  const bitLen = bytes.length * 8
  // Padded length: message + 0x80 + zeros + 64-bit length, multiple of 64.
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(paddedLen)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  // 64-bit big-endian bit length (high 32 bits are zero for realistic inputs).
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Array<number>(64)

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const x15 = w[i - 15] as number, x2 = w[i - 2] as number
      const x16 = w[i - 16] as number, x7 = w[i - 7] as number
      const s0 = rotr(x15, 7) ^ rotr(x15, 18) ^ (x15 >>> 3)
      const s1 = rotr(x2, 17) ^ rotr(x2, 19) ^ (x2 >>> 10)
      w[i] = (x16 + s0 + x7 + s1) | 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i]! + (w[i] as number)) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0
      d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("")
}
