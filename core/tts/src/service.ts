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
import { fetchHealth, fetchVoices, speakChunk, addVoiceRemote, deleteVoiceRemote, setVoiceDefaultRemote, type TtsClientDeps } from "./client.js"
import { omaSynthesize, OMA_TTS_PRESETS, type OmaTtsParams } from "./oma-client.js"
import { InvalidTtsArgs, TtsServerError } from "./errors.js"
import { TTS_SERVER_DEFAULT_URL, type TtsServiceShape, type Voice } from "./types.js"

export interface TtsServiceDeps {
  readonly http: TtsClientDeps["http"]
  readonly baseUrl?: string | undefined
  /** OMA Chatterbox-Turbo endpoint (via SSH tunnel). If set, speak() tries OMA first, falls back to local. */
  readonly omaBaseUrl?: string | undefined
  /** Synthesis params for OMA (default: mid preset). */
  readonly omaParams?: OmaTtsParams | undefined
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
        // Main-process diagnostic (2026-10-10): visible in /tmp/aimy-electron.log
        console.log(`[aimy] TTS speak: "${clean.slice(0, 60)}${clean.length > 60 ? "…" : ""}" (omaBaseUrl=${deps.omaBaseUrl ?? "none"})`)
        // OMA first (Chatterbox-Turbo on 5090), fallback to local.
        if (deps.omaBaseUrl !== undefined) {
          const omaDeps = { http: deps.http, baseUrl: deps.omaBaseUrl }
          const params = deps.omaParams ?? OMA_TTS_PRESETS.mid!
          const chunks = chunkText(clean)
          console.log(`[aimy] TTS: trying OMA (${chunks.length} chunk(s)) via ${deps.omaBaseUrl}`)
          const tryOma: Effect.Effect<Uint8Array, unknown> = Effect.gen(function* () {
            const wavs: Array<Uint8Array> = []
            for (const chunk of chunks) {
              wavs.push(yield* omaSynthesize(omaDeps, chunk, params))
            }
            if (wavs.length === 1) return wavs[0]!
            return concatWav(wavs)
          })
          const omaWav: Uint8Array | undefined = yield* tryOma.pipe(
            Effect.orElseSucceed((): Uint8Array | undefined => undefined)
          )
          if (omaWav !== undefined) {
            console.log(`[aimy] TTS: OMA success (${omaWav.length} bytes)`)
            return omaWav
          }
          console.log(`[aimy] OMA TTS failed, falling back to local`)
        } else {
          console.log(`[aimy] TTS: no OMA configured, using local`)
        }
        // Local fallback (or primary if no OMA configured).
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

    deleteVoice: (voiceId) => deleteVoiceRemote(client, voiceId),

    setVoiceDefault: (voiceId) => setVoiceDefaultRemote(client, voiceId),

    testProvider: () =>
      Effect.gen(function* () {
        // Latency: time a short synthesis.
        const start = Date.now()
        const testText = "Testing provider latency."
        const wav = yield* speakChunk(client, testText, yield* resolveVoice)
        const latencyMs = Date.now() - start
        // Throughput: chars per second.
        const throughputCharsPerSec = (testText.length / latencyMs) * 1000
        // Model size: from health endpoint.
        const health = yield* fetchHealth(client)
        const modelSizeMb = "modelSizeMb" in health && typeof health.modelSizeMb === "number"
          ? health.modelSizeMb
          : 0
        // Keep the WAV bytes alive (prevent optimization).
        void wav.length
        return { latencyMs, modelSizeMb, throughputCharsPerSec }
      }),

    health: () => fetchHealth(client),
  }
}
