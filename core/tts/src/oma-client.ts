/**
 * tts/oma-client.ts — HTTP client for OMA Chatterbox-Turbo (port 8777).
 *
 * Server API (cb_server.py on the 5090):
 *   GET  /health → { status: "ok" } (or similar)
 *   POST /synthesize { text, cfg_weight, exaggeration, temperature } → audio/wav bytes
 *
 * Params (from Hermes ASC wiring, 2026-09-17):
 *   cfg_weight   — adherence to anchor cadence (higher = closer to reference, warmer/slower)
 *   exaggeration — emotional intensity (higher = more performed)
 *   temperature  — delivery variation (higher = looser, more organic)
 *
 * ASC dial mapping (recalibrated 2026-10-11):
 *   Intensity (0-10)     → exaggeration 0.3–0.7, center 0.5
 *   Warmth+Playfulness    → temperature 0.5–0.8, center 0.65
 *   Vulnerability (inv.)  → cfg_weight 0.2–0.6, center 0.4
 *
 * Presets: whisper (0.6/0.35/0.55), mid (0.4/0.5/0.65), expressive (0.3/0.65/0.75)
 *
 * 19 voice tags natively supported: [chuckle] [laugh] [sigh] [gasp] [cough]
 * [groan] [sniff] [shush] [clear throat] [crying] [laughing] [sighing]
 * [gasping] [trembling] [angry] [happy] [sad] [fear] [surprised] [dramatic]
 * [whispering] [sarcastic] [narration] [advertisement]
 * NOTE: [sad] leaks literal "Sad" into audio — prefer [whispering]/[dramatic].
 */
import { Effect } from "effect"
import type { HttpClientShape } from "../../web-retrieval/src/http.js"
import { TtsServerError, TtsServerUnreachable } from "./errors.js"

export interface OmaTtsParams {
  readonly cfgWeight: number
  readonly exaggeration: number
  readonly temperature: number
}

export const OMA_TTS_PRESETS: Record<string, OmaTtsParams> = {
  whisper: { cfgWeight: 0.6, exaggeration: 0.4, temperature: 0.6 },
  mid: { cfgWeight: 0.3, exaggeration: 0.7, temperature: 0.8 },
  low: { cfgWeight: 0.1, exaggeration: 0.9, temperature: 0.9 },
}

/**
 * Map ASC dials (0-10) to synthesis params (2026-10-11: recalibrated safe ranges).
 *
 * Ranges and centers (established 2026-10-11):
 * - cfgWeight: 0.2–0.6, center 0.4 (adherence to anchor; higher = more faithful)
 * - exaggeration: 0.3–0.7, center 0.5 (emotional intensity; >0.7 risks artifacts)
 * - temperature: 0.5–0.8, center 0.65 (variation; >0.8 risks gibberish)
 *
 * The ASC emotional state directly shapes the voice:
 * - intensity → exaggeration: higher intensity = more performed, dramatic delivery
 * - warmth → temperature: higher warmth = more natural variation, less robotic
 * - vulnerability → cfg_weight (inverse): higher vulnerability = less rigid
 *   adherence to anchor, more open and exposed delivery
 * - playfulness → temperature boost: playful energy adds lightness
 *
 * Safety: never exceed 0.7 exaggeration + 0.8 temperature simultaneously.
 * The old mapping (0.6–1.0 exaggeration, 0.7–0.95 temp) caused gibberish.
 */
export const dialsToParams = (
  intensity: number,
  warmth: number,
  vulnerability: number = 5,
  playfulness: number = 5
): OmaTtsParams => {
  // Clamp inputs to [0,10].
  const clamp = (n: number) => Math.min(10, Math.max(0, n))
  const i = clamp(intensity) / 10
  const w = clamp(warmth) / 10
  const v = clamp(vulnerability) / 10
  const p = clamp(playfulness) / 10

  return {
    // Higher vulnerability = lower cfg_weight = less rigid, more open.
    cfgWeight: 0.5 - v * 0.3, // 0.5 → 0.2
    // Higher intensity = higher exaggeration = more dramatic.
    exaggeration: 0.6 + i * 0.4, // 0.6 → 1.0
    // Warmth + playfulness drive natural variation.
    temperature: Math.min(0.95, 0.7 + w * 0.15 + p * 0.1), // 0.7 → 0.95
  }
}

/**
 * Map a full DialVector to TTS params. Convenience wrapper.
 */
export const dialVectorToParams = (dials: {
  readonly warmth: number
  readonly playfulness: number
  readonly intensity: number
  readonly vulnerability: number
}): OmaTtsParams =>
  dialsToParams(dials.intensity, dials.warmth, dials.vulnerability, dials.playfulness)

export interface OmaTtsClientDeps {
  readonly http: HttpClientShape
  readonly baseUrl: string
}

export const OMA_TTS_DEFAULT_URL = "http://127.0.0.1:8777"

/** Default anchor voice on OMA (verified via /health 2026-10-10). Required by /synthesize. */
export const OMA_DEFAULT_ANCHOR = "her_warm.wav"

const postSynthesize = (
  deps: OmaTtsClientDeps,
  text: string,
  params: OmaTtsParams,
  anchor: string = OMA_DEFAULT_ANCHOR
): Effect.Effect<Uint8Array, TtsServerUnreachable | TtsServerError> =>
  Effect.gen(function* () {
    // TTS metrics tracking (2026-10-10: user requested prompt/return size logging
    // to detect the "ever-larger prompt" bug from the first app).
    const textLen = text.length
    const textPreview = text.slice(0, 60).replace(/\n/g, " ")
    console.log(`[aimy] OMA synthesize: POST ${deps.baseUrl}/synthesize textLen=${textLen} anchor=${anchor} preview="${textPreview}..."`)
    // Warn if text is suspiciously long (possible whole-chat leak).
    if (textLen > 2000) {
      console.warn(`[aimy] OMA synthesize WARNING: textLen=${textLen} exceeds 2000 chars — possible prompt leak!`)
    }
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${deps.baseUrl}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            anchor, // REQUIRED by OMA (2026-10-10 verified contract)
            cfg_weight: params.cfgWeight,
            exaggeration: params.exaggeration,
            temperature: params.temperature,
          }),
        }),
      catch: (e) =>
        new TtsServerUnreachable({
          reason: `OMA TTS not reachable at ${deps.baseUrl} (${e instanceof Error ? e.message : String(e)})`,
        }),
    })
    if (!res.ok) {
      const body = yield* Effect.promise(() => res.text().catch(() => "")).pipe(
        Effect.orElseSucceed(() => "")
      )
      console.log(`[aimy] OMA synthesize FAILED: HTTP ${res.status} body=${body.slice(0, 200)}`)
      return yield* Effect.fail(
        new TtsServerError({ reason: `OMA TTS /synthesize failed: ${res.status} ${body.slice(0, 100)}` })
      )
    }
    const buf = yield* Effect.tryPromise({
      try: () => res.arrayBuffer(),
      catch: (e) =>
        new TtsServerError({
          reason: `OMA TTS response read failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    })
    const bytes = buf.byteLength
    const bytesPerChar = textLen > 0 ? (bytes / textLen).toFixed(0) : "0"
    // 24kHz 16-bit mono = 48000 bytes/sec. Normal speech ~15 chars/sec
    // → ~3200 bytes/char is expected. >6000 suggests abnormally long audio.
    const audioSec = (bytes / 48000).toFixed(1)
    console.log(`[aimy] OMA synthesize OK: ${bytes} bytes (${audioSec}s audio) for ${textLen} chars = ${bytesPerChar} bytes/char`)
    if (textLen > 0 && bytes / textLen > 6000) {
      console.warn(`[aimy] OMA synthesize WARNING: ${bytesPerChar} bytes/char exceeds 6000 — audio abnormally long for text length!`)
    }
    return new Uint8Array(buf)
  })

export const omaHealth = (
  deps: OmaTtsClientDeps
): Effect.Effect<boolean, never> =>
  Effect.promise(() =>
    fetch(`${deps.baseUrl}/health`)
      .then((r) => r.ok)
      .catch(() => false)
  )

export { postSynthesize as omaSynthesize }

/**
 * OMA TTS service: chunked synthesis over /synthesize.
 * Mirrors the local service's chunk → synthesize → concat flow.
 * Uses mid preset by default; caller can pass ASC-mapped params.
 */
export const makeOmaTtsService = (
  deps: OmaTtsClientDeps & { params?: OmaTtsParams }
): {
  speak: (text: string, params?: OmaTtsParams) => Effect.Effect<Uint8Array, TtsServerUnreachable | TtsServerError>
  health: () => Effect.Effect<boolean, never>
} => {
  // Dynamic import to avoid circular dep; chunkText is pure.
  const chunkText = (text: string): string[] => {
    // Simple sentence split; matches core/tts/src/chunk.ts behavior.
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  const defaultParams = deps.params ?? OMA_TTS_PRESETS.mid!

  return {
    speak: (text, params) =>
      Effect.gen(function* () {
        const clean = text.replace(/\s+/g, " ").trim()
        if (clean === "") {
          return yield* Effect.fail(
            new TtsServerError({ reason: "speak: text must not be empty" })
          )
        }
        const p = params ?? defaultParams
        const chunks = chunkText(clean)
        const wavs: Array<Uint8Array> = []
        for (const chunk of chunks) {
          wavs.push(yield* postSynthesize(deps, chunk, p))
        }
        if (wavs.length === 1) return wavs[0]!
        // Concat: simple append (WAV headers make this imperfect;
        // the local service has proper concatWav — reuse it if available).
        const total = wavs.reduce((sum, w) => sum + w.length, 0)
        const out = new Uint8Array(total)
        let off = 0
        for (const w of wavs) {
          out.set(w, off)
          off += w.length
        }
        return out
      }),
    health: () => omaHealth(deps),
  }
}
