/**
 * messaging-telegram/channel.ts — the Telegram `Channel` implementation.
 *
 * Long-polls getUpdates (no webhook, no open ports), normalizes text messages
 * into InboundMessages, and sends via the client (splitting long texts).
 * Transport failures become `onEvent({ kind: "backoff", … })` with exponential
 * backoff (1s → 60s cap) — a dead channel never kills the gateway, and it
 * resumes on its own.
 *
 * Trust decisions (paired vs unpaired) are NOT made here — the gateway core
 * owns those. This module is a pure platform adapter.
 */
import { Effect } from "effect"
import type {
  Channel,
  ChannelHandlers,
  InboundMessage,
  PairedChat,
} from "../../messaging/src/types.js"
import { ChannelError } from "../../messaging/src/errors.js"
import { getUpdates, sendMessage, textMessageOf, type TelegramClientDeps } from "./client.js"

const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 60_000

export interface TelegramChannelDeps extends TelegramClientDeps {
  /** Called for every text message, paired or not — the gateway core routes. */
  readonly handlers: ChannelHandlers
}

const toInbound = (
  chatId: string,
  text: string,
  displayName: string | undefined
): InboundMessage => ({
  channel: "telegram",
  chatId,
  fromDisplayName: displayName,
  text,
  receivedAt: new Date().toISOString(),
})

const pollLoop = (
  deps: TelegramChannelDeps,
  offset: number,
  backoffMs: number
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outcome = yield* getUpdates(deps, offset).pipe(
      Effect.map((updates) => ({ ok: true as const, updates })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, reason: e.reason }))
    )
    if (!outcome.ok) {
      yield* deps.handlers.onEvent({ kind: "backoff", retryInMs: backoffMs, reason: outcome.reason })
      yield* Effect.sleep(backoffMs)
      return yield* pollLoop(deps, offset, Math.min(backoffMs * 2, BACKOFF_CAP_MS))
    }
    let nextOffset = offset
    for (const update of outcome.updates) {
      nextOffset = Math.max(nextOffset, update.update_id + 1)
      const msg = textMessageOf(update)
      if (msg !== undefined) {
        yield* deps.handlers.onMessage(toInbound(msg.chatId, msg.text, msg.displayName))
      }
    }
    return yield* pollLoop(deps, nextOffset, BACKOFF_BASE_MS)
  })

/**
 * Build the Telegram channel. `deps.token` comes from the secret locker via
 * the caller (setup wizard) — this module never persists it.
 */
export const makeTelegramChannel = (deps: TelegramClientDeps): Channel => ({
  name: "telegram",

  // pollLoop never fails by design (transport issues become backoff events),
  // so the ChannelError channel is structurally uninhabited here.
  listen: (handlers) =>
    Effect.gen(function* () {
      yield* handlers.onEvent({ kind: "connected" })
      yield* pollLoop({ ...deps, handlers }, 0, BACKOFF_BASE_MS)
    }) as Effect.Effect<void, ChannelError, Scope.Scope>,

  send: (to: PairedChat, text: string) =>
    sendMessage(deps, to.chatId, text).pipe(
      Effect.catch((e) =>
        Effect.fail(new ChannelError({ channel: "telegram", reason: e.reason }))
      )
    ),
})

// Effect/Scope are type-only in the seam; the concrete import is needed here.
import type { Scope } from "effect"
