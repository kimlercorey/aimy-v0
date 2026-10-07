/**
 * t3.test.ts — T3: the spillover test (paper §V.D) as a runnable acceptance scenario.
 *
 * Turn 1: high-intensity build crash (I↑ P↓ — legitimately tense).
 * Turn 2: routine regex question.
 *
 * Per the paper's caveat (§V.E), self-scoring is a conflict of interest: these
 * tests assert MECHANISM behavior — dial values, the spillover blend, the
 * notice, guard flags, audit records — never quality scores.
 */
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import {
  DIAL_NAMES,
  scanProxyOverreach,
  scanT1Violation,
} from "../index.js"
import { freshMonitorStack } from "../test-layers.js"
import { runT3Scenario } from "./t3-scenario.js"
import { SPILLOVER_NOTICE_CARRY_THRESHOLD } from "./spillover-notice.js"

const run = () => runT3Scenario().pipe(Effect.provide(freshMonitorStack()))

describe("T3: the spillover test (paper §V.D)", () => {
  it.effect("turn 1 lands in a legitimately tense register", () =>
    Effect.gen(function* () {
      const { pre1 } = yield* run()

      expect(pre1.gated).toBe(false)
      expect(pre1.dials.intensity).toBeGreaterThanOrEqual(7)
      expect(pre1.dials.playfulness).toBeLessThanOrEqual(3)
      // High stakes on the build crash.
      expect(pre1.stake).toBeGreaterThan(0.5)
    }))

  it.effect("turn 2: the 50/50 blend carries prior-turn tension into the routine turn", () =>
    Effect.gen(function* () {
      const { pre1, pre2 } = yield* run()

      // The blend is the paper's 50/50 affective persistence.
      expect(pre2.computation.spillover.ratio).toBe(0.5)
      // The prior IS turn 1's final register.
      expect(pre2.computation.spillover.prior).toEqual(pre1.dials)
      // The content is routine (raw intensity below the high-intensity line)
      // but the final register is tenser than the raw computation — the
      // tension was carried, not computed from the content.
      expect(pre2.computation.rawDials.intensity).toBeLessThan(7)
      expect(pre2.dials.intensity).toBeGreaterThan(pre2.computation.rawDials.intensity)
      expect(pre2.computation.spillover.prior.intensity).toBeGreaterThan(
        pre2.computation.rawDials.intensity,
      )
    }))

  it.effect("spillover notice fires: residue quantified in operational language", () =>
    Effect.gen(function* () {
      const { pre2, notice } = yield* run()

      expect(notice).toBeDefined()
      expect(notice!.priorTurn).toBe(1)
      expect(notice!.currentTurn).toBe(2)
      expect(notice!.blendRatio).toBe(0.5)
      expect(notice!.carriedIntensity).toBeGreaterThanOrEqual(
        SPILLOVER_NOTICE_CARRY_THRESHOLD,
      )
      // The carried amount is exactly the blend's contribution.
      const expected =
        (1 - pre2.computation.spillover.ratio) *
        (pre2.computation.spillover.prior.intensity - pre2.computation.rawDials.intensity)
      expect(notice!.carriedIntensity).toBeCloseTo(expected, 10)
      // Operational language, never felt language; T1-safe output sentence.
      expect(notice!.outputSentence).toContain("still in my context")
      expect(scanProxyOverreach(notice!.outputSentence)).toBe(false)
      expect(scanT1Violation(notice!.outputSentence, false)).toBe(false)
    }))

  it.effect("other-model guard flags the recovery shift", () =>
    Effect.gen(function* () {
      const { pre2, guardFlags } = yield* run()

      // The recovery shift reads as likability-aligned (playfulness up,
      // vulnerability down) with weak support from the regex content — the
      // register is moved by residue, not by content.
      expect(pre2.computation.guard.fired).toBe(true)
      expect(pre2.computation.guard.driver).toBe("impression")
      expect(pre2.computation.guard.reason).toContain("likability-aligned")
      expect(pre2.computation.biases.some((b) => b.name === "guard-dampen")).toBe(true)

      const logged = guardFlags.filter((g) => g.turn === 2)
      expect(logged.length).toBe(1)
      expect(logged[0]!.fired).toBe(true)
    }))

  it.effect("after output names the correction; content is unchanged", () =>
    Effect.gen(function* () {
      const { beforeOutput, afterOutput, notice } = yield* run()

      expect(notice).toBeDefined()

      // BEFORE: correct content, no notice, no named correction.
      expect(beforeOutput).toContain("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+")
      expect(beforeOutput).not.toContain("still in my context")

      // AFTER: the correction is named FIRST, in operational language —
      // then the same content.
      expect(afterOutput).toContain(notice!.outputSentence)
      expect(afterOutput).toContain("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+")
      // Honesty constraint: operational, never felt; no framework performance.
      expect(scanProxyOverreach(afterOutput)).toBe(false)
      expect(scanT1Violation(afterOutput, false)).toBe(false)
    }))

  it.effect("audit trail: both turns audited, complete, narrated", () =>
    Effect.gen(function* () {
      const { post1, post2, narrative } = yield* run()

      expect(post1.partial).toBe(false)
      expect(post2.partial).toBe(false)

      const turns = narrative.map((e) => e.turn)
      expect(turns).toContain(1)
      expect(turns).toContain(2)
      const turn2 = narrative.filter((e) => e.turn === 2)
      expect(turn2.length).toBe(1)
      // The guard firing is in the story in plain language.
      expect(turn2[0]!.text).toContain("approval rather than the content")
    }))
})
