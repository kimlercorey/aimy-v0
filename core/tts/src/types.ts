/**
 * tts/types.ts — the TTS module's public data shapes.
 *
 * The service speaks through a local Python server (Chatterbox) over HTTP.
 * All audio is WAV bytes; the service never touches the filesystem or the
 * speakers — playback is the caller's job (desktop in the ASC channels build).
 */
export interface Voice {
  readonly id: string
  readonly name: string
  readonly isDefault: boolean
}

export interface TtsHealth {
  readonly reachable: boolean
  readonly modelLoaded: boolean
  /** GPU name when the server reports one, e.g. "NVIDIA GeForce RTX 5090". */
  readonly gpu?: string | undefined
}

export interface TtsServiceShape {
  /**
   * Speak text → WAV bytes (16-bit PCM, mono). Long texts are chunked on
   * sentence boundaries and concatenated. Empty text fails fast.
   */
  readonly speak: (text: string, voiceId?: string) => Effect.Effect<Uint8Array, TtsError>
  readonly voices: () => Effect.Effect<ReadonlyArray<Voice>, TtsError>
  readonly setVoice: (voiceId: string) => Effect.Effect<void, TtsError>
  /**
   * Add a voice reference from WAV bytes (stored server-side under
   * ~/.aimy/voices/). Returns the new voice. Name: 1–40 chars.
   */
  readonly addVoice: (name: string, wav: Uint8Array) => Effect.Effect<Voice, TtsError>
  readonly health: () => Effect.Effect<TtsHealth, TtsError>
}

export const TTS_SERVER_DEFAULT_PORT = 8001
export const TTS_SERVER_DEFAULT_URL = `http://127.0.0.1:${TTS_SERVER_DEFAULT_PORT}`
/** Max chars per synthesis chunk — Chatterbox is happiest around a paragraph. */
export const TTS_CHUNK_CHARS = 500

import type { Effect } from "effect"
import type { TtsError } from "./errors.js"
