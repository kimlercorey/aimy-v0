/**
 * asc-channels/errors.ts — tagged failures for the simultaneous-channels module.
 */
import { Data } from "effect"

/**
 * Fatal channel failure: empty text, or anything that prevents producing
 * the text + expression channels. TTS failure is NOT a ChannelError — the
 * turn degrades (text + FACS still delivered, audio marked unavailable).
 */
export class ChannelError extends Data.TaggedError("ChannelError")<{
  readonly reason: string
}> {}
