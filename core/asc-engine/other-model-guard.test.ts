import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import {
  classifyShift,
  GUARD_DAMPEN_BETA,
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
})
