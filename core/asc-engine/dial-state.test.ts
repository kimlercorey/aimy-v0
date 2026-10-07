import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import { AscError } from "./errors-shim.js"
import {
  decodeDialVector,
  DEFAULT_SPILLOVER_RATIO,
  DIAL_NAMES,
  DialState,
  DialStateLive,
  NEUTRAL_DIALS,
  spillover,
} from "./dial-state.js"

const inBounds = (v: { warmth: number; playfulness: number; intensity: number; vulnerability: number }) =>
  DIAL_NAMES.every((d) => v[d] >= 0 && v[d] <= 10)

describe("DialVector schema", () => {
  it.effect("rejects out-of-range dial construction", () =>
    Effect.gen(function* () {
      const over = yield* Effect.flip(
        decodeDialVector({ warmth: 11, playfulness: 5, intensity: 5, vulnerability: 5 }),
      )
      expect(over).toBeInstanceOf(AscError)
      expect(over.reason).toContain("schema validation")

      const under = yield* Effect.flip(
        decodeDialVector({ warmth: 5, playfulness: -0.5, intensity: 5, vulnerability: 5 }),
      )
      expect(under).toBeInstanceOf(AscError)

      const nan = yield* Effect.flip(
        decodeDialVector({ warmth: NaN, playfulness: 5, intensity: 5, vulnerability: 5 }),
      )
      expect(nan).toBeInstanceOf(AscError)

      const infinite = yield* Effect.flip(
        decodeDialVector({ warmth: 5, playfulness: 5, intensity: Infinity, vulnerability: 5 }),
      )
      expect(infinite).toBeInstanceOf(AscError)
    }))

  it.effect("accepts the boundary values 0 and 10", () =>
    Effect.gen(function* () {
      const v = yield* decodeDialVector({ warmth: 0, playfulness: 10, intensity: 0, vulnerability: 10 })
      expect(v.warmth).toBe(0)
      expect(v.playfulness).toBe(10)
      expect(inBounds(v)).toBe(true)
    }))
})

describe("spillover", () => {
  it("blends 50/50 by default (exact math)", () => {
    expect(DEFAULT_SPILLOVER_RATIO).toBe(0.5)
    const out = spillover(
      { warmth: 10, playfulness: 10, intensity: 10, vulnerability: 10 },
      { warmth: 0, playfulness: 0, intensity: 0, vulnerability: 0 },
    )
    expect(out).toEqual({ warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 })
  })

  it("is tunable: ratio weights the computed vector", () => {
    const computed = { warmth: 8, playfulness: 8, intensity: 8, vulnerability: 8 }
    const prior = { warmth: 4, playfulness: 4, intensity: 4, vulnerability: 4 }
    const out = spillover(computed, prior, 0.25)
    // 0.25*8 + 0.75*4 = 5
    expect(out.warmth).toBeCloseTo(5, 10)
    const out2 = spillover(computed, prior, 1)
    expect(out2.warmth).toBe(8)
    const out3 = spillover(computed, prior, 0)
    expect(out3.warmth).toBe(4)
  })

  it("cannot produce out-of-bounds vectors even with hostile ratios", () => {
    const out = spillover(
      { warmth: 10, playfulness: 10, intensity: 10, vulnerability: 10 },
      { warmth: 10, playfulness: 10, intensity: 10, vulnerability: 10 },
      999,
    )
    expect(inBounds(out)).toBe(true)
  })

  it("decays rather than snaps: each blend halves the remaining gap", () => {
    const raw = { warmth: 10, playfulness: 2, intensity: 8, vulnerability: 0 }
    const prior = { warmth: 0, playfulness: 8, intensity: 2, vulnerability: 10 }
    const once = spillover(raw, prior) // 50% of the way
    const twice = spillover(raw, once) // 75% of the way
    for (const d of DIAL_NAMES) {
      const gap0 = Math.abs(prior[d] - raw[d])
      const gap1 = Math.abs(once[d] - raw[d])
      const gap2 = Math.abs(twice[d] - raw[d])
      // Exact 50/50 blend math: the gap halves every turn (geometric decay).
      expect(gap1).toBeCloseTo(gap0 / 2, 10)
      expect(gap2).toBeCloseTo(gap0 / 4, 10)
      // Decays, never snaps: still strictly short of the computed vector.
      expect(gap1).toBeGreaterThan(0)
      expect(gap2).toBeLessThan(gap1)
    }
  })
})

describe("DialState", () => {
  it.effect("starts from neutral defaults", () =>
    Effect.gen(function* () {
      const ds = yield* DialState
      const current = yield* ds.current
      expect(current).toEqual(NEUTRAL_DIALS)
    }).pipe(Effect.provide(DialStateLive)))

  it.effect("is session-scoped: two builds are independent", () =>
    Effect.gen(function* () {
      const prog = Effect.gen(function* () {
        const ds = yield* DialState
        yield* ds.applyPipelineDials({ warmth: 9, playfulness: 1, intensity: 8, vulnerability: 2 })
        return yield* ds.current
      })
      const first = yield* prog.pipe(Effect.provide(DialStateLive))
      const second = yield* Effect.gen(function* () {
        const ds = yield* DialState
        return yield* ds.current
      }).pipe(Effect.provide(DialStateLive))
      expect(first.warmth).toBe(9)
      expect(second).toEqual(NEUTRAL_DIALS)
    }))

  it.effect("exposes no direct dial write on its shape", () =>
    Effect.gen(function* () {
      const ds = yield* DialState
      const keys = Object.keys(ds).sort()
      // The only write path is named for the L2 pipeline (seam S7).
      expect(keys).toEqual(
        ["applyPipelineDials", "counters", "current", "recordSelfCorrection", "recordTurn"].sort(),
      )
      expect("setDials" in ds).toBe(false)
    }).pipe(Effect.provide(DialStateLive)))

  it.effect("tracks session counters", () =>
    Effect.gen(function* () {
      const ds = yield* DialState
      yield* ds.recordTurn
      yield* ds.recordTurn
      yield* ds.recordSelfCorrection
      const counters = yield* ds.counters
      expect(counters).toEqual({ turns: 2, selfCorrections: 1 })
    }).pipe(Effect.provide(DialStateLive)))
})
