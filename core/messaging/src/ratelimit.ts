/**
 * messaging/ratelimit.ts — Phase 5: per-chat rate limiting for unpaired prompts.
 *
 * An unpaired chat spamming the bot must not get a reply per message —
 * that's a spam amplifier and a log flooder. One pairing prompt per chat
 * per minute; everything else is silently dropped (the sender already has
 * the instructions).
 *
 * Pure token-bucket-ish logic over an injected clock for testability; the
 * dispatch layer holds the instance.
 */
export interface RateLimiter {
  /** True if a prompt may be sent to this chat now (records the send). */
  readonly allowPrompt: (chatKey: string, now: number) => boolean
}

export const PROMPT_COOLDOWN_MS = 60_000

/** Pure constructor: `now` injected, no clock dependency. */
export const makeRateLimiter = (): RateLimiter & { _state: Map<string, number> } => {
  const lastSent = new Map<string, number>()
  return {
    _state: lastSent,
    allowPrompt: (chatKey, now) => {
      const last = lastSent.get(chatKey) ?? -Infinity
      if (now - last < PROMPT_COOLDOWN_MS) return false
      lastSent.set(chatKey, now)
      return true
    },
  }
}
