/**
 * tts/errors.ts — tagged failures for the TTS module.
 */
import { Data } from "effect"

/** The TTS server is not reachable (not running, wrong port, network). */
export class TtsServerUnreachable extends Data.TaggedError("TtsServerUnreachable")<{
  readonly reason: string
}> {}

/** The server answered but the request failed (model not loaded, GPU OOM, bad audio). */
export class TtsServerError extends Data.TaggedError("TtsServerError")<{
  readonly reason: string
}> {}

/** Invalid speak() arguments (empty text, unknown voice). Fail-fast: no server call. */
export class InvalidTtsArgs extends Data.TaggedError("InvalidTtsArgs")<{
  readonly reason: string
}> {}

export type TtsError = TtsServerUnreachable | TtsServerError | InvalidTtsArgs
