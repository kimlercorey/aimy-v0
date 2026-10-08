/**
 * messaging/types.ts — the gateway's public data shapes.
 *
 * The gateway connects AImy's agent loop to external chat platforms.
 * Phase 1 covers: the channel seam, the pairing registry, inbound message
 * shapes, and forwarding preferences. Telegram is the first channel
 * (core/messaging-telegram); the seam admits more without touching this file.
 *
 * Security model: only paired chats reach the agent. Pairing is human→instance
 * (a person proving they own the chat), distinct from the identity module's
 * instance→instance pairing grants — but the trust-record shape mirrors it
 * deliberately (peer id, paired-at, display name).
 */
import type { BannerSeverity } from "../../comms/types.js"
import type { ChannelError } from "./errors.js"

/** A chat platform the gateway can speak to. */
export type ChannelName = "telegram"

/** A message arriving from a paired chat, normalized across channels. */
export interface InboundMessage {
  readonly channel: ChannelName
  /** Platform chat identifier (Telegram chat id as string). */
  readonly chatId: string
  readonly fromDisplayName?: string | undefined
  readonly text: string
  readonly receivedAt: string // ISO-8601
}

/** A chat authorized to talk to this instance. Single-chat policy (spec §9.1):
 *  the registry holds at most one per channel. */
export interface PairedChat {
  readonly channel: ChannelName
  readonly chatId: string
  readonly displayName?: string | undefined
  readonly pairedAt: string // ISO-8601
}

/** A one-time pairing code: 6 digits, 5-minute expiry, single-use. */
export interface PairingCode {
  readonly code: string
  readonly channel: ChannelName
  readonly createdAt: number // epoch ms
  readonly expiresAt: number // epoch ms
  readonly attempts: number
}

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const PAIRING_MAX_ATTEMPTS = 5
export const PAIRING_COOLDOWN_MS = 60 * 60 * 1000

/** Which comms-banner severities forward to the paired chat. */
export interface ForwardingPrefs {
  readonly enabled: boolean
  readonly severities: ReadonlyArray<BannerSeverity>
}

export const DEFAULT_FORWARDING_PREFS: ForwardingPrefs = {
  enabled: true,
  severities: ["success", "critical"],
}

/**
 * The channel seam. Implementations (telegram, …) are pure platform adapters:
 * they poll/send, they never decide trust — the gateway core does.
 */
export interface Channel {
  readonly name: ChannelName
  /**
   * Listen loop: yields inbound messages to `onMessage`. Runs until the
   * scope closes. Transport failures become `onEvent` calls, never throws —
   * a dead channel must not kill the gateway.
   */
  readonly listen: (handlers: ChannelHandlers) => Effect.Effect<void, ChannelError, Scope.Scope>
  /** Send a text message (splitting per platform limits internally). */
  readonly send: (to: PairedChat, text: string) => Effect.Effect<void, ChannelError>
}

export interface ChannelHandlers {
  readonly onMessage: (msg: InboundMessage) => Effect.Effect<void>
  readonly onEvent: (event: ChannelEvent) => Effect.Effect<void>
}

export type ChannelEvent =
  | { readonly kind: "connected" }
  | { readonly kind: "disconnected"; readonly reason: string }
  | { readonly kind: "backoff"; readonly retryInMs: number; readonly reason: string }

// Effect/Scope imports are type-only here to keep the seam light; the
// concrete Effect import lives in the implementations.
import type { Effect, Scope } from "effect"
