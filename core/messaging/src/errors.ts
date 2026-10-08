/**
 * messaging/errors.ts — typed failures for the messaging gateway.
 *
 * Same convention as the rest of the core: every failure crossing the module
 * boundary is a tagged error, never an untyped throw (architecture §1.4).
 */
import { Data } from "effect"

/** A channel operation failed (network, API error, timeout). */
export class ChannelError extends Data.TaggedError("ChannelError")<{
  readonly channel: string
  readonly reason: string
}> {}

/** Pairing code invalid, expired, or rate-limited. */
export class PairingError extends Data.TaggedError("PairingError")<{
  readonly reason: string
}> {}

/** The pairing registry failed (read/write). */
export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly reason: string
}> {}

/** A message arrived from an unpaired chat — not an error, a routing decision. */
export class UnpairedChat extends Data.TaggedError("UnpairedChat")<{
  readonly channel: string
  readonly chatId: string
}> {}

export type MessagingError = ChannelError | PairingError | RegistryError | UnpairedChat
