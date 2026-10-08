/**
 * messaging/dispatch.ts — Phase 3: inbound messages → agent turns.
 *
 * `handleInbound` is the gateway core's message router:
 * - paired chat → agent-loop turn (session per channel+chat), reply routed back;
 * - unpaired chat sending a 6-digit code → pairing claim attempt;
 * - unpaired chat otherwise → pairing prompt (never the agent, never memory).
 *
 * The agent loop is depended on through the narrow `TurnRunner` interface —
 * the real AgentLoop service satisfies it structurally; tests stub it.
 * Replies come from the stream's `Done` chunk (`report.text`); a failed turn
 * becomes an honest "something went wrong on my end" — never a stack trace.
 */
import { Effect, Stream } from "effect"
import type { AgentLoopError, ChatChunk } from "../../agent-loop/src/loop.js"
import {
  ChannelError,
  PairingError,
  RegistryError,
  type MessagingError,
} from "./errors.js"
import type {
  Channel,
  ChannelName,
  InboundMessage,
  PairedChat,
} from "./types.js"
import type { PairingRegistryShape } from "./pairing.js"

/** Narrow turn interface — AgentLoop satisfies this structurally. */
export interface TurnRunner {
  readonly chat: (sessionId: string, input: string) => Stream.Stream<ChatChunk, AgentLoopError>
}

export interface DispatchDeps {
  readonly registry: PairingRegistryShape
  readonly runner: TurnRunner
  readonly channel: Channel
}

/** Deterministic session per chat: the Telegram thread is its own session. */
export const sessionIdFor = (channel: ChannelName, chatId: string): string =>
  `msg:${channel}:${chatId}`

/**
 * Channel framing for the model: the turn knows it's on Telegram so it can
 * keep replies concise. Visible, constant, and changeable — not hidden.
 */
export const CHANNEL_PREAMBLE = "[via Telegram — keep replies concise]\n\n"

export const PAIRING_PROMPT =
  "This AImy isn't paired with this chat yet. Generate a pairing code in the app (Settings → Messaging) and send the 6 digits here."

const PAIRING_SUCCESS = (name: string | undefined): string =>
  `Paired${name !== undefined ? ` as ${name}` : ""}. This chat can now talk to your AImy.`

const TURN_FAILURE_REPLY = "Something went wrong on my end — try again in a moment."

/** Collect the stream's reply text from the Done chunk. Pure over chunks. */
export const replyTextOf = (chunks: ReadonlyArray<ChatChunk>): string | undefined => {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i]
    if (c !== undefined && c._tag === "Done") return c.report.text
  }
  return undefined
}

const runTurn = (
  runner: TurnRunner,
  sessionId: string,
  input: string
): Effect.Effect<string, AgentLoopError> =>
  runner
    .chat(sessionId, input)
    .pipe(
      Stream.runCollect,
      Effect.map((chunks) => replyTextOf(Array.from(chunks)) ?? TURN_FAILURE_REPLY)
    )

const sendQuiet = (
  channel: Channel,
  to: PairedChat,
  text: string
): Effect.Effect<void, never> =>
  channel.send(to, text).pipe(Effect.catch(() => Effect.void))

/**
 * Route one inbound message. Never fails the caller — send failures are
 * swallowed after the reply is computed (the turn already ran; a dead
 * channel must not bubble into the listen loop).
 */
export const handleInbound = (
  deps: DispatchDeps
): ((msg: InboundMessage) => Effect.Effect<void, never>) => {
  const to = (chatId: string, displayName?: string): PairedChat => ({
    channel: deps.channel.name,
    chatId,
    displayName,
    pairedAt: "",
  })

  return (msg) =>
    Effect.gen(function* () {
      const paired = yield* deps.registry.isPaired(msg.channel, msg.chatId)

      if (!paired) {
        // Pairing claim attempt? A 6-digit message is a code, not a chat.
        if (/^\d{6}$/.test(msg.text.trim())) {
          const claimed = yield* deps.registry
            .claimCode(msg.channel, msg.chatId, msg.text.trim(), msg.fromDisplayName)
            .pipe(
              Effect.map((chat) => ({ ok: true as const, chat })),
              Effect.catch((e: PairingError | RegistryError) =>
                Effect.succeed({ ok: false as const, reason: e.reason })
              )
            )
          yield* sendQuiet(
            deps.channel,
            to(msg.chatId, msg.fromDisplayName),
            claimed.ok ? PAIRING_SUCCESS(claimed.chat.displayName) : `Pairing failed: ${claimed.reason}`
          )
          return
        }
        yield* sendQuiet(deps.channel, to(msg.chatId, msg.fromDisplayName), PAIRING_PROMPT)
        return
      }

      const chat = (yield* deps.registry.getPaired(msg.channel)) ?? to(msg.chatId, msg.fromDisplayName)
      const reply = yield* runTurn(
        deps.runner,
        sessionIdFor(msg.channel, msg.chatId),
        `${CHANNEL_PREAMBLE}${msg.text}`
      ).pipe(Effect.catch(() => Effect.succeed(TURN_FAILURE_REPLY)))
      yield* sendQuiet(deps.channel, chat, reply)
    }).pipe(Effect.catch(() => Effect.void))
}

export type DispatchError = MessagingError | ChannelError
