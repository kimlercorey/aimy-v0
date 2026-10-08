/**
 * asc-channels/test/channels.test.ts — speakable text, timeline, orchestrator.
 *
 * speakable/timeline are pure. The orchestrator runs against a mock TTS
 * service and mock dials: full-output path, TTS-down degradation, dials-down
 * degradation, empty-text fatal.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { toSpeakable } from "../src/speakable.js"
import { buildTimeline, estimateDurationMs, wavDurationMs } from "../src/timeline.js"
import { renderChannels } from "../src/orchestrator.js"
import { NEUTRAL_FRAME } from "../src/types.js"
import { ChannelError } from "../src/errors.js"
import type { TtsServiceShape } from "../../tts/src/types.js"
import { TtsServerUnreachable } from "../../tts/src/errors.js"

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

/** 1s of 16-bit mono silence at 22050 Hz. */
const makeWav = (seconds: number, sampleRate = 22050): Uint8Array => {
  const samples = Math.floor(seconds * sampleRate)
  const out = new Uint8Array(44 + samples * 2)
  const w32 = (o: number, v: number) => {
    out[o] = v & 0xff; out[o + 1] = (v >>> 8) & 0xff; out[o + 2] = (v >>> 16) & 0xff; out[o + 3] = (v >>> 24) & 0xff
  }
  out.set([0x52, 0x49, 0x46, 0x46]); w32(4, out.length - 8); out.set([0x57, 0x41, 0x56, 0x45], 8)
  out.set([0x66, 0x6d, 0x74, 0x20], 12); w32(16, 16)
  out.set([1, 0, 1, 0], 20); w32(24, sampleRate); w32(28, sampleRate * 2); out.set([2, 0, 16, 0], 32)
  out.set([0x64, 0x61, 0x74, 0x61], 36); w32(40, samples * 2)
  return out
}

const mockTts = (wav: Uint8Array): TtsServiceShape => ({
  speak: () => Effect.succeed(wav),
  voices: () => Effect.succeed([]),
  setVoice: () => Effect.succeed(undefined),
  addVoice: () => Effect.fail(new TtsServerUnreachable({ reason: "x" })),
  health: () => Effect.succeed({ reachable: true, modelLoaded: true }),
})

const dials = { warmth: 8, playfulness: 6, intensity: 5, vulnerability: 3 }

describe("toSpeakable (pure)", () => {
  it("drops code blocks, keeps prose", () => {
    const out = toSpeakable("Here is the fix:\n```ts\nconst x = 1;\n```\nDone.")
    expect(out).toContain("Here is the fix")
    expect(out).toContain("Done.")
    expect(out).not.toContain("const x")
  })

  it("reduces links and formatting to words", () => {
    expect(toSpeakable("See [the docs](https://example.com) for **details**.")).toBe(
      "See the docs for details."
    )
  })

  it("strips headers, lists, and bare URLs", () => {
    const out = toSpeakable("## Title\n- first item\n- second item\nhttps://example.com/x")
    expect(out).not.toContain("#")
    expect(out).toContain("first item")
    expect(out).not.toContain("https://")
  })

  it("keeps paragraph breaks", () => {
    expect(toSpeakable("Para one.\n\nPara two.")).toBe("Para one.\n\nPara two.")
  })
})

describe("timeline (pure)", () => {
  it("emits one cue per chunk, times ascending within the duration", () => {
    const cues = buildTimeline(["one.", "two two.", "three three three."], dials, 3000)
    expect(cues).toHaveLength(3)
    expect(cues[0]!.atMs).toBeGreaterThanOrEqual(0)
    expect(cues[2]!.atMs).toBeLessThan(3000)
    expect(cues[0]!.atMs).toBeLessThan(cues[1]!.atMs)
    expect(cues[1]!.atMs).toBeLessThan(cues[2]!.atMs)
  })

  it("eases in from rest and back out", () => {
    const cues = buildTimeline(["a.", "b.", "c.", "d.", "e.", "f.", "g.", "h."], dials, 8000)
    const first = cues[0]!.frame
    const mid = cues[3]!.frame
    const last = cues[cues.length - 1]!.frame
    // First and last frames are closer to rest than the middle frame.
    const dist = (f: typeof first) => Math.abs(f.smile - NEUTRAL_FRAME.smile)
    expect(dist(first)).toBeLessThan(dist(mid))
    expect(dist(last)).toBeLessThan(dist(mid))
  })

  it("reads exact duration from WAV bytes", () => {
    expect(wavDurationMs(makeWav(2))).toBe(2000)
    expect(() => wavDurationMs(new Uint8Array([1, 2, 3]))).toThrow()
  })

  it("estimates duration without audio", () => {
    expect(estimateDurationMs("x".repeat(150))).toBe(10000)
  })
})

describe("renderChannels", () => {
  it("fans one turn out to three channels", async () => {
    const wav = makeWav(2)
    const out = await run(
      renderChannels({ tts: mockTts(wav), dials: Effect.succeed(dials) }, { text: "Hello there. How are you?" })
    )
    expect(out.text).toContain("Hello there")
    expect(out.spoken).toContain("Hello there")
    expect(out.audio).toEqual(wav)
    expect(out.audioUnavailableReason).toBeUndefined()
    expect(out.durationMs).toBe(2000) // exact, from the WAV
    expect(out.expressions.length).toBeGreaterThan(0)
  })

  it("degrades honestly when TTS is down", async () => {
    const dead: TtsServiceShape = {
      ...mockTts(makeWav(1)),
      speak: () => Effect.fail(new TtsServerUnreachable({ reason: "conn refused" })),
    }
    const out = await run(
      renderChannels({ tts: dead, dials: Effect.succeed(dials) }, { text: "Still here." })
    )
    expect(out.audio).toBeUndefined()
    expect(out.audioUnavailableReason).toContain("TTS unavailable")
    expect(out.text).toBe("Still here.")
    expect(out.expressions.length).toBeGreaterThan(0)
    expect(out.durationMs).toBeGreaterThan(0) // estimated
  })

  it("rests the face when dials are unreadable", async () => {
    const out = await run(
      renderChannels(
        { tts: mockTts(makeWav(1)), dials: Effect.fail(new ChannelError({ reason: "asc down" })) },
        { text: "No dials today." }
      )
    )
    expect(out.expressions).toHaveLength(1)
    expect(out.expressions[0]!.frame).toEqual(NEUTRAL_FRAME)
    expect(out.audio).toBeDefined() // voice still works
  })

  it("fails fast on empty text", async () => {
    const e = await run(
      Effect.flip(
        renderChannels({ tts: mockTts(makeWav(1)), dials: Effect.succeed(dials) }, { text: "   " })
      )
    )
    expect(e).toBeInstanceOf(ChannelError)
  })

  it("skips voice when there is nothing speakable", async () => {
    let spoke = false
    const tts: TtsServiceShape = {
      ...mockTts(makeWav(1)),
      speak: () => {
        spoke = true
        return Effect.succeed(makeWav(1))
      },
    }
    const out = await run(
      renderChannels({ tts, dials: Effect.succeed(dials) }, { text: "```\ncode only\n```" })
    )
    expect(spoke).toBe(false)
    expect(out.audioUnavailableReason).toContain("nothing speakable")
    expect(out.text).toContain("code only") // chat still shows it
  })
})
