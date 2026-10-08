/**
 * messaging/pairing.ts — the pairing registry: which chats may talk to this instance.
 *
 * Single-chat policy (spec §9.1, resolved 2026-10-07): at most one paired chat
 * per channel. Pairing codes are 6 random digits, 5-minute expiry, single-use,
 * 5 attempts max then a 1-hour cooldown per chat.
 *
 * Two layers:
 * - Pure logic (`generateCode`, `validateCodeAttempt`, cooldown checks) —
 *   fully unit-tested, no clock/network.
 * - `PairingRegistry` Effect service — file-backed (0600), in-memory cache.
 *   The file holds the paired chat + cooldowns; codes live in memory only
 *   (a restart invalidates outstanding codes — fail-closed).
 */
import { Effect } from "effect"
import { randomInt } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname } from "node:path"
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_COOLDOWN_MS,
  PAIRING_MAX_ATTEMPTS,
  type ChannelName,
  type PairedChat,
  type PairingCode,
} from "./types.js"
import { PairingError, RegistryError } from "./errors.js"

export interface PairingRegistryShape {
  /** Generate a fresh pairing code for a channel (invalidates any previous). */
  readonly generateCode: (channel: ChannelName) => Effect.Effect<PairingCode, never>
  /**
   * Attempt pairing: correct + unexpired + within attempts → pairs the chat.
   * Wrong/expired/exhausted → typed PairingError; the chat is NOT paired.
   */
  readonly claimCode: (
    channel: ChannelName,
    chatId: string,
    code: string,
    displayName?: string
  ) => Effect.Effect<PairedChat, PairingError | RegistryError>
  readonly isPaired: (channel: ChannelName, chatId: string) => Effect.Effect<boolean, never>
  readonly getPaired: (channel: ChannelName) => Effect.Effect<PairedChat | undefined, never>
  readonly unpair: (channel: ChannelName) => Effect.Effect<void, RegistryError>
}

/** Pure: mint a code. `now` injected for testability. */
export const generateCode = (channel: ChannelName, now: number): PairingCode => {
  const digits = Array.from({ length: 6 }, () => randomInt(0, 10)).join("")
  return {
    code: digits,
    channel,
    createdAt: now,
    expiresAt: now + PAIRING_CODE_TTL_MS,
    attempts: 0,
  }
}

/** Pure: is this code still usable at `now`? */
export const isCodeLive = (code: PairingCode, now: number): boolean =>
  now < code.expiresAt && code.attempts < PAIRING_MAX_ATTEMPTS

interface RegistryFile {
  readonly paired: Record<string, PairedChat>
  /** chatKey → cooldown expiry epoch ms */
  readonly cooldowns: Record<string, number>
}

const chatKey = (channel: ChannelName, chatId: string): string => `${channel}:${chatId}`
const emptyFile = (): RegistryFile => ({ paired: {}, cooldowns: {} })

/**
 * File-backed registry. `dir` is the instance state dir; the file is created
 * 0600. Codes are memory-only (restart invalidates them — fail-closed).
 */
export const makePairingRegistry = (dir: string): PairingRegistryShape => {
  const file = `${dir}/messaging-pairing.json`
  let paired = new Map<string, PairedChat>()
  let cooldowns = new Map<string, number>()
  let codes = new Map<string, PairingCode>()
  let loaded = false

  const load = Effect.gen(function* () {
    if (loaded) return
    const raw = yield* Effect.tryPromise({
      try: () => fs.readFile(file, "utf-8"),
      catch: (e) =>
        new RegistryError({
          reason: (e as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : `read failed: ${String(e)}`,
        }),
    }).pipe(
      Effect.catchTag("RegistryError", (e) =>
        e.reason === "not-found" ? Effect.succeed(JSON.stringify(emptyFile())) : Effect.fail(e)
      )
    )
    try {
      const parsed = JSON.parse(raw) as Partial<RegistryFile>
      paired = new Map(Object.entries(parsed.paired ?? {}))
      cooldowns = new Map(Object.entries(parsed.cooldowns ?? {}))
    } catch {
      paired = new Map()
      cooldowns = new Map()
    }
    loaded = true
  })

  const save = Effect.gen(function* () {
    const data: RegistryFile = {
      paired: Object.fromEntries(paired),
      cooldowns: Object.fromEntries(cooldowns),
    }
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 })
      },
      catch: (e) => new RegistryError({ reason: `write failed: ${String(e)}` }),
    })
  })

  const withLoad = <A, E>(eff: Effect.Effect<A, E>): Effect.Effect<A, E | RegistryError> =>
    load.pipe(Effect.andThen(() => eff))

  return {
    generateCode: (channel) =>
      Effect.sync(() => {
        const code = generateCode(channel, Date.now())
        codes.set(channel, code)
        return code
      }),

    claimCode: (channel, chatId, code, displayName) =>
      withLoad(
        Effect.gen(function* () {
          const key = chatKey(channel, chatId)
          const now = Date.now()
          const cooldownUntil = cooldowns.get(key) ?? 0
          if (now < cooldownUntil) {
            return yield* Effect.fail(
              new PairingError({ reason: `too many attempts — try again after ${new Date(cooldownUntil).toISOString()}` })
            )
          }
          const outstanding = codes.get(channel)
          if (outstanding === undefined || !isCodeLive(outstanding, now)) {
            codes.delete(channel)
            return yield* Effect.fail(new PairingError({ reason: "no live pairing code — generate a new one" }))
          }
          if (outstanding.code !== code.trim()) {
            const next = { ...outstanding, attempts: outstanding.attempts + 1 }
            codes.set(channel, next)
            if (next.attempts >= PAIRING_MAX_ATTEMPTS) {
              codes.delete(channel)
              cooldowns.set(key, now + PAIRING_COOLDOWN_MS)
              yield* save
              return yield* Effect.fail(
                new PairingError({ reason: "too many wrong attempts — cooling down for 1 hour" })
              )
            }
            return yield* Effect.fail(new PairingError({ reason: "wrong code" }))
          }
          // Success: single-chat policy — replace any existing pairing.
          codes.delete(channel)
          const chat: PairedChat = {
            channel,
            chatId,
            displayName,
            pairedAt: new Date(now).toISOString(),
          }
          paired.set(channel, chat)
          yield* save
          return chat
        })
      ),

    isPaired: (channel, chatId) =>
      withLoad(
        Effect.sync(() => {
          const p = paired.get(channel)
          return p !== undefined && p.chatId === chatId
        })
      ).pipe(
        // Fail-closed: if the registry can't be read, the chat is NOT paired.
        Effect.catch(() => Effect.succeed(false))
      ),

    getPaired: (channel) =>
      withLoad(Effect.sync(() => paired.get(channel))).pipe(
        Effect.catch(() => Effect.succeed(undefined))
      ),

    unpair: (channel) =>
      withLoad(
        Effect.gen(function* () {
          paired.delete(channel)
          codes.delete(channel)
          yield* save
        })
      ),
  }
}
