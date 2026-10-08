/**
 * messaging/test/ratelimit.test.ts — the unpaired-prompt spam guard.
 *
 * Pure: one prompt per chat per minute, independent chats independent.
 */
import { describe, expect, it } from "vitest"
import { makeRateLimiter, PROMPT_COOLDOWN_MS } from "../src/ratelimit.js"

describe("rate limiter (pure)", () => {
  it("allows the first prompt, suppresses within the cooldown", () => {
    const lim = makeRateLimiter()
    expect(lim.allowPrompt("telegram:1", 0)).toBe(true)
    expect(lim.allowPrompt("telegram:1", PROMPT_COOLDOWN_MS - 1)).toBe(false)
    expect(lim.allowPrompt("telegram:1", PROMPT_COOLDOWN_MS)).toBe(true)
  })

  it("tracks chats independently", () => {
    const lim = makeRateLimiter()
    expect(lim.allowPrompt("telegram:1", 0)).toBe(true)
    expect(lim.allowPrompt("telegram:2", 0)).toBe(true)
    expect(lim.allowPrompt("telegram:1", 1)).toBe(false)
  })
})
