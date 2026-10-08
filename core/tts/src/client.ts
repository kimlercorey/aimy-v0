/**
 * tts/client.ts — HTTP client for the local Chatterbox server.
 *
 * Server API (see server/tts-server.py):
 *   GET  /health → { model_loaded: bool, gpu: string | null }
 *   GET  /voices → { voices: [{ id, name, is_default }] }
 *   POST /speak  { text, voice_id } → audio/wav bytes
 *
 * Transport goes through the shared HttpClient seam (mocked in tests).
 * Every failure is typed: unreachable vs. server error are distinct because
 * the UX differs ("start the server" vs. "the server failed").
 */
import { Effect } from "effect"
import type { HttpClientShape } from "../../web-retrieval/src/http.js"
import { TtsServerError, TtsServerUnreachable, InvalidTtsArgs } from "./errors.js"
import type { TtsHealth, Voice } from "./types.js"

export interface TtsClientDeps {
  readonly http: HttpClientShape
  readonly baseUrl: string
}

interface RawResponse {
  readonly status: number
  readonly text: string
}

const requestJson = (
  deps: TtsClientDeps,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Effect.Effect<RawResponse, TtsServerUnreachable> =>
  deps.http
    .request({
      url: `${deps.baseUrl}${path}`,
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" } as const, body: JSON.stringify(body) }
        : {}),
      timeoutMs: 120_000, // synthesis takes a while; per-chunk calls are smaller
      maxBytes: 64 * 1024 * 1024,
    })
    .pipe(
      Effect.catch((e) =>
        Effect.fail(
          new TtsServerUnreachable({
            reason: `TTS server not reachable at ${deps.baseUrl} (${e instanceof Error ? e.message : String(e)}) — start it with: python3 tts-server.py`,
          })
        )
      ),
      Effect.map((res) => ({ status: res.status, text: res.body }))
    )

/**
 * Raw-bytes variant for /speak: the HttpClient returns body as string, which
 * corrupts binary WAV. We fetch via the seam's underlying fetch when the
 * mock provides bytes… — instead, the mock in tests returns base64 in a
 * JSON envelope; production uses the real fetch path below.
 *
 * Simpler honest design: /speak returns { audio_base64 } JSON. Base64
 * overhead (~33%) is irrelevant on localhost, and it keeps every client —
 * mock or real — on the same JSON path. The Python server encodes likewise.
 */
export const speakChunk = (
  deps: TtsClientDeps,
  text: string,
  voiceId: string
): Effect.Effect<Uint8Array, TtsServerUnreachable | TtsServerError> =>
  Effect.gen(function* () {
    const res = yield* requestJson(deps, "POST", "/speak", { text, voice_id: voiceId })
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(
        new TtsServerError({ reason: `/speak HTTP ${res.status}: ${res.text.slice(0, 200)}` })
      )
    }
    let parsed: { audio_base64?: unknown; error?: unknown }
    try {
      parsed = JSON.parse(res.text) as { audio_base64?: unknown; error?: unknown }
    } catch {
      return yield* Effect.fail(new TtsServerError({ reason: "/speak returned unparseable JSON" }))
    }
    if (typeof parsed.error === "string") {
      return yield* Effect.fail(new TtsServerError({ reason: `/speak: ${parsed.error}` }))
    }
    if (typeof parsed.audio_base64 !== "string" || parsed.audio_base64 === "") {
      return yield* Effect.fail(new TtsServerError({ reason: "/speak returned no audio" }))
    }
    const bin = atob(parsed.audio_base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  })

export const fetchVoices = (
  deps: TtsClientDeps
): Effect.Effect<ReadonlyArray<Voice>, TtsServerUnreachable | TtsServerError> =>
  Effect.gen(function* () {
    const res = yield* requestJson(deps, "GET", "/voices")
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(
        new TtsServerError({ reason: `/voices HTTP ${res.status}` })
      )
    }
    let parsed: { voices?: unknown }
    try {
      parsed = JSON.parse(res.text) as { voices?: unknown }
    } catch {
      return yield* Effect.fail(new TtsServerError({ reason: "/voices returned unparseable JSON" }))
    }
    if (!Array.isArray(parsed.voices)) {
      return yield* Effect.fail(new TtsServerError({ reason: "/voices returned no voice list" }))
    }
    return (parsed.voices as ReadonlyArray<Record<string, unknown>>)
      .filter((v) => typeof v["id"] === "string" && typeof v["name"] === "string")
      .map((v) => ({
        id: v["id"] as string,
        name: v["name"] as string,
        isDefault: v["is_default"] === true,
      }))
  })

/** Add a voice reference. Server validates name/audio; 400s surface as TtsServerError. */
export const addVoiceRemote = (
  deps: TtsClientDeps,
  name: string,
  wav: Uint8Array
): Effect.Effect<Voice, TtsServerUnreachable | TtsServerError | InvalidTtsArgs> =>
  Effect.gen(function* () {
    if (name.trim() === "") {
      return yield* Effect.fail(new InvalidTtsArgs({ reason: "addVoice: name must not be empty" }))
    }
    if (wav.length < 1000) {
      return yield* Effect.fail(
        new InvalidTtsArgs({ reason: "addVoice: reference audio too short (need a real WAV)" })
      )
    }
    let b64 = ""
    const CHUNK = 0x8000
    for (let i = 0; i < wav.length; i += CHUNK) {
      b64 += String.fromCharCode(...wav.subarray(i, i + CHUNK))
    }
    const res = yield* requestJson(deps, "POST", "/voices/add", {
      name: name.trim(),
      audio_base64: btoa(b64),
    })
    let parsed: { voice?: unknown; error?: unknown }
    try {
      parsed = JSON.parse(res.text) as { voice?: unknown; error?: unknown }
    } catch {
      return yield* Effect.fail(new TtsServerError({ reason: "/voices/add returned unparseable JSON" }))
    }
    if (typeof parsed.error === "string") {
      return yield* Effect.fail(new TtsServerError({ reason: `/voices/add: ${parsed.error}` }))
    }
    const v = parsed.voice as Record<string, unknown> | undefined
    if (v === undefined || typeof v["id"] !== "string" || typeof v["name"] !== "string") {
      return yield* Effect.fail(
        new TtsServerError({ reason: `/voices/add HTTP ${res.status}: no voice returned` })
      )
    }
    return { id: v["id"] as string, name: v["name"] as string, isDefault: false }
  })

/** Health that never fails: unreachable is a result ({ reachable: false }), not an error. */
export const fetchHealth = (
  deps: TtsClientDeps
): Effect.Effect<TtsHealth, never> =>
  requestJson(deps, "GET", "/health").pipe(
    Effect.catch(() => Effect.succeed({ reachable: false, modelLoaded: false } satisfies TtsHealth)),
    Effect.flatMap((res: RawResponse | TtsHealth) => {
      if (!("status" in res)) return Effect.succeed(res)
      if (res.status < 200 || res.status >= 300) {
        return Effect.succeed({ reachable: true, modelLoaded: false } satisfies TtsHealth)
      }
      let parsed: { model_loaded?: unknown; gpu?: unknown }
      try {
        parsed = JSON.parse(res.text) as { model_loaded?: unknown; gpu?: unknown }
      } catch {
        return Effect.succeed({ reachable: true, modelLoaded: false } satisfies TtsHealth)
      }
      const health: TtsHealth = { reachable: true, modelLoaded: parsed.model_loaded === true }
      return Effect.succeed(
        typeof parsed.gpu === "string" && parsed.gpu !== "" ? { ...health, gpu: parsed.gpu } : health
      )
    })
  )
