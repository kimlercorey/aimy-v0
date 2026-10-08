import { describe, expect, it } from "vitest"

import { sha256Hex, sha256HexBytes } from "./hash.js"

// NIST FIPS 180-4 test vectors — the implementation must match node's
// createHash("sha256") byte-for-byte, since content-addressed ids computed
// before this module existed must remain stable.
describe("substrate/hash", () => {
  it("matches known SHA-256 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  })

  it("handles multi-block and unicode input", () => {
    // 1000 chars forces multiple 64-byte blocks.
    expect(sha256Hex("x".repeat(1000))).toBe(
      "44f8354494a5ba03ba1792a8d3e9c534c47a9181980fde7a3f44b06ef2ae7c7f",
    )
    // Exact 55-byte boundary (fits padding in one block) and 56-byte (spills).
    expect(sha256Hex("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    )
    expect(sha256Hex("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    )
    expect(sha256Hex("héllo wörld 🌍")).toBe(
      "701aea0197ece166311a45663e52d5d580e3b5ff116dfda2724ad928e51a834a",
    )
  })

  it("hashes raw bytes identically to the string form for ASCII", () => {
    const bytes = new TextEncoder().encode("hello")
    expect(sha256HexBytes(bytes)).toBe(sha256Hex("hello"))
    expect(sha256HexBytes(new Uint8Array(0))).toBe(sha256Hex(""))
  })
})
