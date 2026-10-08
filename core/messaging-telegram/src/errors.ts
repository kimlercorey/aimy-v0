/**
 * messaging-telegram/errors.ts — tagged failures for the Telegram channel.
 */
import { Data } from "effect"

/** The Bot API answered ok:false or unparseable JSON. */
export class TelegramApiError extends Data.TaggedError("TelegramApiError")<{
  readonly method: string
  readonly reason: string
}> {}

/** Transport failure calling the Bot API. */
export class TelegramTransportError extends Data.TaggedError("TelegramTransportError")<{
  readonly method: string
  readonly reason: string
}> {}

/** The token is missing or rejected by getMe. */
export class TelegramAuthError extends Data.TaggedError("TelegramAuthError")<{
  readonly reason: string
}> {}

export type TelegramError = TelegramApiError | TelegramTransportError | TelegramAuthError
