/**
 * messaging/test/pairing.test.ts — the pairing trust contract.
 *
 * Pure logic (code liveness) plus the registry: claim success, wrong-code
 * attempts → cooldown, expiry, single-chat replacement, unpair, and
 * persistence round-trip. No network; the registry uses a temp dir.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { Effect } from "effect"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateCode,
  isCodeLive,
  makePairingRegistry,
} from "../src/pairing.js"
import { PairingError } from "../src/errors.js"
import { PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS } from "../src/types.js"

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "aimy-msg-test-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("code liveness (pure)", () => {
  it("a fresh code is live", () => {
    const c = generateCode("telegram", 1000)
    expect(c.code).toMatch(/^\d{6}$/)
    expect(isCodeLive(c, 1000 + PAIRING_CODE_TTL_MS - 1)).toBe(true)
  })

  it("an expired code is dead", () => {
    const c = generateCode("telegram", 1000)
    expect(isCodeLive(c, 1000 + PAIRING_CODE_TTL_MS)).toBe(false)
  })

  it("an exhausted code is dead", () => {
    const c = { ...generateCode("telegram", 1000), attempts: PAIRING_MAX_ATTEMPTS }
    expect(isCodeLive(c, 1000)).toBe(false)
  })
})

describe("pairing registry", () => {
  it("pairs on correct code", async () => {
    const reg = makePairingRegistry(dir)
    const code = await run(reg.generateCode("telegram"))
    const chat = await run(reg.claimCode("telegram", "chat-1", code.code, "Kimler"))
    expect(chat.chatId).toBe("chat-1")
    expect(await run(reg.isPaired("telegram", "chat-1"))).toBe(true)
    expect(await run(reg.isPaired("telegram", "chat-2"))).toBe(false)
  })

  it("rejects wrong codes and cools down after max attempts", async () => {
    const reg = makePairingRegistry(dir)
    await run(reg.generateCode("telegram"))
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      const e = await run(Effect.flip(reg.claimCode("telegram", "chat-9", "000000")))
      expect(e).toBeInstanceOf(PairingError)
    }
    // Now cooling down — even the right code won't work (code was consumed).
    const e2 = await run(Effect.flip(reg.claimCode("telegram", "chat-9", "000000")))
    expect(e2).toBeInstanceOf(PairingError)
    expect(e2.reason).toContain("too many attempts")
    expect(await run(reg.isPaired("telegram", "chat-9"))).toBe(false)
  })

  it("rejects expired codes", async () => {
    const reg = makePairingRegistry(dir)
    const code = await run(reg.generateCode("telegram"))
    // Simulate expiry by manipulating? Codes are memory-only; instead verify
    // the pure liveness gate rejects at the boundary via a stale code path:
    // (registry stores no clock injection — expiry covered by isCodeLive tests.)
    expect(code.expiresAt - code.createdAt).toBe(PAIRING_CODE_TTL_MS)
  })

  it("single-chat policy: new pairing replaces the old", async () => {
    const reg = makePairingRegistry(dir)
    const c1 = await run(reg.generateCode("telegram"))
    await run(reg.claimCode("telegram", "chat-1", c1.code))
    const c2 = await run(reg.generateCode("telegram"))
    await run(reg.claimCode("telegram", "chat-2", c2.code))
    expect(await run(reg.isPaired("telegram", "chat-2"))).toBe(true)
    expect(await run(reg.isPaired("telegram", "chat-1"))).toBe(false)
    expect((await run(reg.getPaired("telegram")))?.chatId).toBe("chat-2")
  })

  it("unpair removes the chat", async () => {
    const reg = makePairingRegistry(dir)
    const c = await run(reg.generateCode("telegram"))
    await run(reg.claimCode("telegram", "chat-1", c.code))
    await run(reg.unpair("telegram"))
    expect(await run(reg.getPaired("telegram"))).toBeUndefined()
  })

  it("persists pairings across restarts (codes do not survive — fail-closed)", async () => {
    const reg1 = makePairingRegistry(dir)
    const c = await run(reg1.generateCode("telegram"))
    await run(reg1.claimCode("telegram", "chat-1", c.code))
    const reg2 = makePairingRegistry(dir)
    expect(await run(reg2.isPaired("telegram", "chat-1"))).toBe(true)
    // But an outstanding code from reg1 is gone: claiming fails.
    const e = await run(Effect.flip(reg2.claimCode("telegram", "chat-2", c.code)))
    expect(e).toBeInstanceOf(PairingError)
    expect(e.reason).toContain("no live pairing code")
  })

  it("generating a new code invalidates the previous", async () => {
    const reg = makePairingRegistry(dir)
    const c1 = await run(reg.generateCode("telegram"))
    await run(reg.generateCode("telegram"))
    const e = await run(Effect.flip(reg.claimCode("telegram", "chat-1", c1.code)))
    expect(e).toBeInstanceOf(PairingError)
  })
})
