import { describe, expect, it } from "vitest"

import { AU_NAMES, dialsToAUFrame, frameActivation } from "./facs.js"

describe("dialsToAUFrame", () => {
  it("maps the neutral vector to the hand-computed frame", () => {
    const frame = dialsToAUFrame({ warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 })
    // n = 0.5 each; gain = 0.35 + 0.65·0.5 = 0.675
    expect(frame).toEqual({
      browRaise: 0.338, // 0.5 · 0.675 = 0.3375
      browLower: 0.2, // 0.5 · 0.5 · 0.8
      eyeOpen: 0.338, // 0.5 · 0.675
      lidTighten: 0.125, // 0.25 · 0.5
      smile: 0.27, // 0.5 · (0.6+0.2) · 0.675
      mouthCornerDepress: 0.175, // 0.5 · 0.5 · 0.7
      lipPress: 0.15, // 0.5 · 0.5 · 0.6
      jawDrop: 0.169, // 0.5 · 0.5 · 0.675 = 0.16875
      headTiltDeg: 0, // (0.5−0.5) · 24
    })
  })

  it("maps cold + intense + flat to furrowed, pressed, tilted-down", () => {
    const frame = dialsToAUFrame({ warmth: 0, playfulness: 0, intensity: 10, vulnerability: 0 })
    // gain = 1.0
    expect(frame.browRaise).toBe(0)
    expect(frame.browLower).toBe(0.8)
    expect(frame.eyeOpen).toBe(1)
    expect(frame.lidTighten).toBe(0.5)
    expect(frame.smile).toBe(0)
    expect(frame.mouthCornerDepress).toBe(0.7)
    expect(frame.lipPress).toBe(0.6)
    expect(frame.jawDrop).toBe(0)
    expect(frame.headTiltDeg).toBe(-12)
  })

  it("maps warm + playful + vulnerable to raised, smiling, tilted-up", () => {
    const frame = dialsToAUFrame({ warmth: 10, playfulness: 10, intensity: 2, vulnerability: 8 })
    // gain = 0.35 + 0.65·0.2 = 0.48
    expect(frame.browRaise).toBe(0.48)
    expect(frame.browLower).toBe(0)
    expect(frame.eyeOpen).toBe(0.096) // 0.2 · 0.48
    expect(frame.lidTighten).toBe(0.02) // 0.04 · 0.5
    expect(frame.smile).toBe(0.48) // 1 · 1 · 0.48
    expect(frame.mouthCornerDepress).toBe(0)
    expect(frame.lipPress).toBe(0)
    expect(frame.jawDrop).toBe(0.192) // 0.8 · 0.5 · 0.48
    expect(frame.headTiltDeg).toBe(7.2) // (0.8−0.5) · 24
  })

  it("is deterministic and bounded", () => {
    const dials = { warmth: 3.3, playfulness: 7.7, intensity: 9.1, vulnerability: 1.2 }
    const a = dialsToAUFrame(dials)
    const b = dialsToAUFrame(dials)
    expect(a).toEqual(b)
    for (const name of AU_NAMES) {
      expect(a[name]).toBeGreaterThanOrEqual(0)
      expect(a[name]).toBeLessThanOrEqual(1)
    }
    expect(a.headTiltDeg).toBeGreaterThanOrEqual(-12)
    expect(a.headTiltDeg).toBeLessThanOrEqual(12)
  })

  it("clamps out-of-range dial inputs instead of exploding", () => {
    const frame = dialsToAUFrame({ warmth: -5, playfulness: 50, intensity: 10, vulnerability: 10 })
    for (const name of AU_NAMES) {
      expect(frame[name]).toBeGreaterThanOrEqual(0)
      expect(frame[name]).toBeLessThanOrEqual(1)
    }
    expect(frame.smile).toBe(0) // warmth clamped to 0
    expect(frame.browRaise).toBe(1) // playfulness clamped to 1, gain 1
  })

  it("frameActivation averages the AU channels", () => {
    const frame = dialsToAUFrame({ warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 })
    const expected =
      (0.338 + 0.2 + 0.338 + 0.125 + 0.27 + 0.175 + 0.15 + 0.169) / 8
    expect(frameActivation(frame)).toBeCloseTo(expected, 3)
  })
})
