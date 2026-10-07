/**
 * identity/bytes.ts — small byte-encoding helpers shared by identity.ts and
 * locker.ts (kept separate to avoid a circular import between them).
 */

/** Encode bytes as base64url without padding (public key material only). */
export const encodeBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url")

/** Decode base64url into a strictly `ArrayBuffer`-backed view. */
export const decodeBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  strictBytes(new Uint8Array(Buffer.from(text, "base64url")))

/** Plain base64 encode (vault envelope fields). */
export const encodeBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64")

/** Plain base64 decode into a strictly `ArrayBuffer`-backed view. */
export const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  strictBytes(new Uint8Array(Buffer.from(text, "base64")))

/**
 * Copy into a strictly-`ArrayBuffer`-backed view. @types/node 26 types
 * WebCrypto `BufferSource` strictly, so views over shared/pooled buffers
 * (e.g. `Buffer.from(...)`) are normalized before crossing the boundary.
 */
export const strictBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  out.set(bytes)
  return out
}
