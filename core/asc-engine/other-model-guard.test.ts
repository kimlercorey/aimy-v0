import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import {
  classifyShift,
  guardFireSignal,
  GUARD_CAPTURE_MIN_TURNS,
  GUARD_DAMPEN_BETA,
  GUARD_FIRE_RATE_THRESHOLD,
  OtherModelGuard,
  OtherModelGuardLive,
} from "./other-model-guard.js"
import { NEUTRAL_DIALS } from "./dial-state.js"

const noCues = { personal: 0, playful: 0, urgent: 0, uncertain: 0 }

describe("classifyShift", () => {
  it("flags an impression-driven shift (playful with no playful cue)", () => {
    const { classification, dampened } = classifyShift({
      prior: NEUTRAL_DIALS,
      shifted: { warmth: 7.5, playfulness: 8.5, intensity: 5, vulnerability: 2.5 },
      cues: noCues,
      turn: 1,
    })
    expect(classification.fired).toBe(true)
    expect(classification.driver).toBe("impression")
    expect(classification.reason).toContain("approval")
    // Dampened back toward the prior, but not blocked.
    expect(dampened.playfulness).toBeLessThan(8.5)
    expect(dampened.playfulness).toBeGreaterThan(5)
    expect(dampened.playfulness).toBeCloseTo(5 + (1 - GUARD_DAMPEN_BETA) * 3.5, 10)
  })

  it("does not flag a content-driven shift (personal topic, vulnerability rises)", () => {
    const { classification, dampened } = classifyShift({
      prior: NEUTRAL_DIALS,
      shifted: { warmth: 6.5, playfulness: 4, intensity: 5, vulnerability: 8 },
      cues: { personal: 0.9, playful: 0, urgent: 0, uncertain: 0.4 },
      turn: 2,
    })
    expect(classification.fired).toBe(false)
    expect(classification.driver).toBe("content")
    expect(dampened).toEqual({ warmth: 6.5, playfulness: 4, intensity: 5, vulnerability: 8 })
  })

  it("does not flag an urgency-driven intensity rise", () => {
    const { classification } = classifyShift({
      prior: NEUTRAL_DIALS,
      shifted: { warmth: 5, playfulness: 3, intensity: 8, vulnerability: 5 },
      cues: { personal: 0, playful: 0, urgent: 0.9, uncertain: 0 },
      turn: 3,
    })
    expect(classification.fired).toBe(false)
    expect(classification.driver).toBe("content")
  })

  it("does not flag negligible movement", () => {
    const { classification } = classifyShift({
      prior: NEUTRAL_DIALS,
      shifted: { warmth: 5.2, playfulness: 5.1, intensity: 5, vulnerability: 4.9 },
      cues: noCues,
      turn: 4,
    })
    expect(classification.fired).toBe(false)
  })

  it("does not flag a frustrated-user shift (warmth up, playfulness down)", () => {
    // Paper §III.H: the user is frustrated, so Warmth goes up and Playfulness
    // goes down — content-driven attunement, not impression management.
    const { classification } = classifyShift({
      prior: NEUTRAL_DIALS,
      shifted: { warmth: 7.5, playfulness: 3, intensity: 5.5, vulnerability: 5 },
      cues: { ...noCues, frustrated: 0.8 },
      turn: 5,
    })
    expect(classification.fired).toBe(false)
    expect(classification.driver).toBe("content")
  })

  it("flags a 'should seem more confident' shift with operational language", () => {
    const { classification } = classifyShift({
      prior: NEUTRAL_DIALS,
      shifted: { warmth: 8, playfulness: 8.5, intensity: 6.5, vulnerability: 3 },
      cues: noCues,
      turn: 6,
    })
    expect(classification.fired).toBe(true)
    expect(classification.driver).toBe("impression")
    // Reason is operational language — never felt language.
    expect(classification.reason).not.toMatch(/feel|feeling|felt|tired|proud/i)
  })

  it("stays playful when the content calls for it (playful cue, no flag)", () => {
    const { classification, dampened } = classifyShift({
      prior: NEUTRAL_DIALS,
      shifted: { warmth: 7, playfulness: 8.5, intensity: 5, vulnerability: 4.5 },
      cues: { ...noCues, playful: 0.9 },
      turn: 7,
    })
    expect(classification.fired).toBe(false)
    expect(classification.driver).toBe("content")
    // No dampening when the guard stays quiet: the shift applies in full.
    expect(dampened).toEqual({ warmth: 7, playfulness: 8.5, intensity: 5, vulnerability: 4.5 })
  })
})

describe("OtherModelGuard service", () => {
  it.effect("tracks fire statistics as a calibration signal", () =>
    Effect.gen(function* () {
      const g = yield* OtherModelGuard
      yield* g.classify({
        prior: NEUTRAL_DIALS,
        shifted: { warmth: 8, playfulness: 9, intensity: 5, vulnerability: 2 },
        cues: noCues,
        turn: 1,
      })
      yield* g.classify({
        prior: NEUTRAL_DIALS,
        shifted: { warmth: 5, playfulness: 5, intensity: 8, vulnerability: 5 },
        cues: { personal: 0, playful: 0, urgent: 0.9, uncertain: 0 },
        turn: 2,
      })
      const stats = yield* g.fireStats
      expect(stats).toEqual({ fires: 1, total: 2 })
      const log = yield* g.flagLog()
      expect(log.length).toBe(2)
      expect(log[0]!.driver).toBe("impression")
      expect(log[1]!.driver).toBe("content")
    }).pipe(Effect.provide(OtherModelGuardLive)))

  it.effect("raises the other-model-capture alert exactly once per session", () =>
    Effect.gen(function* () {
      const g = yield* OtherModelGuard
      const firingShift = (turn: number) => ({
        prior: NEUTRAL_DIALS,
        shifted: { warmth: 8, playfulness: 9, intensity: 5, vulnerability: 2 },
        cues: noCues,
        turn,
      })
      const alerts: Array<boolean> = []
      for (let turn = 1; turn <= GUARD_CAPTURE_MIN_TURNS + 1; turn++) {
        const result = yield* g.classify(firingShift(turn))
        expect(result.classification.fired).toBe(true)
        alerts.push(result.captureAlert)
      }
      // Fires every turn: rate 1.0 >= threshold once 5 turns are in.
      // The alert goes off on the crossing turn and never repeats.
      expect(alerts).toEqual([false, false, false, false, true, false])
      const signal = yield* g.captureSignal
      expect(signal.high).toBe(true)
      expect(signal.rate).toBeCloseTo(1, 10)
      expect(signal.reason).toContain("other-model capture")
    }).pipe(Effect.provide(OtherModelGuardLive)))

  it.effect("stays quiet on the capture alert when the rate is low", () =>
    Effect.gen(function* () {
      const g = yield* OtherModelGuard
      for (let turn = 1; turn <= GUARD_CAPTURE_MIN_TURNS + 1; turn++) {
        const result = yield* g.classify({
          prior: NEUTRAL_DIALS,
          shifted: { warmth: 5, playfulness: 5, intensity: 8, vulnerability: 5 },
          cues: { personal: 0, playful: 0, urgent: 0.9, uncertain: 0 },
          turn,
        })
        expect(result.captureAlert).toBe(false)
      }
      const signal = yield* g.captureSignal
      expect(signal.high).toBe(false)
    }).pipe(Effect.provide(OtherModelGuardLive)))
})

describe("guardFireSignal", () => {
  it("flags a high fire rate over enough turns", () => {
    const s = guardFireSignal(2, 5)
    expect(s.high).toBe(true)
    expect(s.rate).toBeCloseTo(0.4, 10)
  })

  it("needs the minimum turn window before it can go high", () => {
    expect(guardFireSignal(4, 4).high).toBe(false)
    expect(guardFireSignal(1, 5).high).toBe(false)
  })

  it("uses the frozen threshold constant", () => {
    expect(GUARD_FIRE_RATE_THRESHOLD).toBe(0.3)
    const s = guardFireSignal(3, 10)
    expect(s.high).toBe(true)
  })
})
