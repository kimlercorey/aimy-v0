/**
 * tts/service.ts — the TtsService: chunked synthesis over the local server.
 *
 * speak(text): validate → chunk on sentence boundaries → one /speak per
 * chunk → concatenate WAVs. A single-chunk synthesis skips the concat path.
 * The active voice persists in-memory (Phase 3 adds voice refs on disk).
 */
import { Effect } from "effect"
import { chunkText } from "./chunk.js"
import { concatWav } from "./wav.js"
import { fetchHealth, fetchVoices, speakChunk, addVoiceRemote, type TtsClientDeps } from "./client.js"
import { InvalidTtsArgs, TtsServerError } from "./errors.js"
import { TTS_SERVER_DEFAULT_URL, type TtsServiceShape, type Voice } from "./types.js"

export interface TtsServiceDeps {
  readonly http: TtsClientDeps["http"]
  readonly baseUrl?: string | undefined
}

export const makeTtsService = (deps: TtsServiceDeps): TtsServiceShape => {
  const client: TtsClientDeps = { http: deps.http, baseUrl: deps.baseUrl ?? TTS_SERVER_DEFAULT_URL }
  let activeVoiceId: string | undefined

  const resolveVoice = Effect.gen(function* () {
    if (activeVoiceId !== undefined) return activeVoiceId
    const voices = yield* fetchVoices(client)
    const def = voices.find((v) => v.isDefault) ?? voices[0]
    if (def === undefined) {
      return yield* Effect.fail(new TtsServerError({ reason: "server returned no voices" }))
    }
    activeVoiceId = def.id
    return def.id
  })

  return {
    speak: (text, voiceId) =>
      Effect.gen(function* () {
        const clean = text.replace(/\s+/g, " ").trim()
        if (clean === "") {
          return yield* Effect.fail(new InvalidTtsArgs({ reason: "speak: text must not be empty" }))
        }
        const voice = voiceId ?? (yield* resolveVoice)
        const chunks = chunkText(clean)
        const wavs: Array<Uint8Array> = []
        for (const chunk of chunks) {
          wavs.push(yield* speakChunk(client, chunk, voice))
        }
        if (wavs.length === 1) return wavs[0]!
        try {
          return concatWav(wavs)
        } catch (e) {
          return yield* Effect.fail(
            new TtsServerError({ reason: `WAV concat failed: ${e instanceof Error ? e.message : String(e)}` })
          )
        }
      }),

    voices: () => fetchVoices(client),

    setVoice: (voiceId) =>
      Effect.gen(function* () {
        const voices: ReadonlyArray<Voice> = yield* fetchVoices(client)
        if (!voices.some((v) => v.id === voiceId)) {
          return yield* Effect.fail(new InvalidTtsArgs({ reason: `unknown voice "${voiceId}"` }))
        }
        activeVoiceId = voiceId
      }),

    addVoice: (name, wav) => addVoiceRemote(client, name, wav),

    health: () => fetchHealth(client),
  }
}
