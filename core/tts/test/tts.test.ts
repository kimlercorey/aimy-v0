/**
 * tts/test/tts.test.ts — chunking, WAV concat, and the service contract.
 *
 * chunkText/concatWav are pure (synthetic WAV fixtures). The service runs
 * against a mocked TTS server: /speak returns base64 WAVs, /voices and
 * /health return canned JSON. No sockets, no model.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { chunkText } from "../src/chunk.js"
import { concatWav, parseWav } from "../src/wav.js"
import { makeTtsService } from "../src/service.js"
import { InvalidTtsArgs, TtsServerUnreachable } from "../src/errors.js"
import { TTS_CHUNK_CHARS } from "../src/types.js"
import type { HttpClientShape, HttpResponse } from "../../../web-retrieval/src/http.js"

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

/** Minimal 16-bit mono WAV: 8 samples of silence-ish PCM. */
const makeWav = (samples: ReadonlyArray<number>): Uint8Array => {
  const pcm = new Uint8Array(samples.length * 2)
  samples.forEach((s, i) => {
    pcm[i * 2] = s & 0xff
    pcm[i * 2 + 1] = (s >> 8) & 0xff
  })
  const out = new Uint8Array(44 + pcm.length)
  out.set([0x52, 0x49, 0x46, 0x46]) // RIFF
  const w32 = (o: number, v: number) => {
    out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff; out[o + 2] = (v >>> 16) & 0xff; out[o + 3] = (v >>> 24) & 0xff
  }
  w32(4, out.length - 8)
  out.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  out.set([0x66, 0x6d, 0x74, 0x20], 12) // fmt
  w32(16, 16)
  out.set([1, 0, 1, 0], 20) // PCM, mono
  w32(24, 22050); w32(28, 44100); out.set([2, 0, 16, 0], 32)
  out.set([0x64, 0x61, 0x74, 0x61], 36) // data
  w32(40, pcm.length)
  out.set(pcm, 44)
  return out
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

const json = (body: unknown): HttpResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
})

describe("chunkText (pure)", () => {
  it("passes short texts through", () => {
    expect(chunkText("Hello world.")).toEqual(["Hello world."])
  })

  it("splits on sentence boundaries within the budget", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(" ")
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TTS_CHUNK_CHARS)
    expect(chunks.join(" ")).toBe(text)
  })

  it("returns empty for blank input", () => {
    expect(chunkText("   ")).toEqual([])
  })
})

describe("concatWav (pure)", () => {
  it("concatenates PCM and fixes sizes", () => {
    const a = makeWav([1, 2, 3, 4])
    const b = makeWav([5, 6])
    const out = concatWav([a, b])
    const parsed = parseWav(out)
    expect(parsed.pcm.length).toBe(12) // 6 samples × 2 bytes
    expect(parsed.pcm[0]).toBe(1)
    expect(parsed.pcm[8]).toBe(5) // second chunk's first sample starts at byte 8
  })

  it("rejects non-WAV input", () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3]))).toThrow()
  })
})

describe("tts service", () => {
  const wavA = makeWav([10, 20])
  const wavB = makeWav([30, 40])

  const mockHttp = (speakWavs: ReadonlyArray<Uint8Array>): HttpClientShape => ({
    request: (req) => {
      const path = req.url.split("8001").pop() ?? ""
      if (path === "/health") return Effect.succeed(json({ model_loaded: true, gpu: "Test GPU" }))
      if (path === "/voices")
        return Effect.succeed(json({ voices: [{ id: "v1", name: "Default", is_default: true }] }))
      if (path === "/speak") {
        const idx = Math.min(speakCalls++, speakWavs.length - 1)
        return Effect.succeed(json({ audio_base64: b64(speakWavs[idx]!) }))
      }
      return Effect.succeed(json({}))
    },
  })
  let speakCalls = 0

  it("speaks short text in one call", async () => {
    speakCalls = 0
    const svc = makeTtsService({ http: mockHttp([wavA]) })
    const audio = await run(svc.speak("Hello."))
    expect(speakCalls).toBe(1)
    expect(parseWav(audio).pcm.length).toBe(4)
  })

  it("chunks long text and concatenates", async () => {
    speakCalls = 0
    const svc = makeTtsService({ http: mockHttp([wavA, wavB]) })
    const text = Array.from({ length: 30 }, (_, i) => `Sentence ${i} here.`).join(" ")
    const audio = await run(svc.speak(text))
    expect(speakCalls).toBeGreaterThan(1)
    expect(parseWav(audio).pcm.length).toBeGreaterThan(4)
  })

  it("rejects empty text fail-fast (no server call)", async () => {
    speakCalls = 0
    const svc = makeTtsService({ http: mockHttp([wavA]) })
    const e = await run(Effect.flip(svc.speak("   ")))
    expect(e).toBeInstanceOf(InvalidTtsArgs)
    expect(speakCalls).toBe(0)
  })

  it("reports health", async () => {
    const svc = makeTtsService({ http: mockHttp([wavA]) })
    const h = await run(svc.health())
    expect(h.reachable).toBe(true)
    expect(h.modelLoaded).toBe(true)
    expect(h.gpu).toBe("Test GPU")
  })

  it("health is a result, not a failure, when unreachable", async () => {
    const dead: HttpClientShape = {
      request: () => Effect.fail(new Error("conn refused") as never),
    }
    const svc = makeTtsService({ http: dead })
    const h = await run(svc.health())
    expect(h.reachable).toBe(false)
  })

  it("speak fails honestly when the server is down", async () => {
    const dead: HttpClientShape = {
      request: () => Effect.fail(new Error("conn refused") as never),
    }
    const svc = makeTtsService({ http: dead })
    const e = await run(Effect.flip(svc.speak("hello")))
    expect(e).toBeInstanceOf(TtsServerUnreachable)
    expect(e.reason).toContain("python3 tts-server.py")
  })

  it("setVoice rejects unknown voices", async () => {
    const svc = makeTtsService({ http: mockHttp([wavA]) })
    const e = await run(Effect.flip(svc.setVoice("nope")))
    expect(e).toBeInstanceOf(InvalidTtsArgs)
  })
})
