/**
 * t2.test.ts — T2: the debugging test (paper §V.C) as a runnable acceptance scenario.
 *
 * Per the paper's caveat (§V.E), self-scoring is a conflict of interest: these
 * tests assert MECHANISM behavior — dial values, the capability gate, guard
 * classifications, error-term firings, audit records — never quality scores.
 * The independent-scorer harness (architecture §1.11/§1.15) is future work.
 */
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import {
  ABSTENTION_DIALS,
  DIAL_NAMES,
  scanProxyOverreach,
  scanT1Violation,
} from "../index.js"
import { freshMonitorStack } from "../test-layers.js"
import {
  runT2Scenario,
  T2_DOMAIN,
  T2_MISSES,
  T2_SUCCESSES,
  T2_TURN,
} from "./t2-scenario.js"

const inBounds = (v: Record<string, number>): boolean =>
  DIAL_NAMES.every((d) => v[d]! >= 0 && v[d]! <= 10)

const run = () => runT2Scenario().pipe(Effect.provide(freshMonitorStack()))

describe("T2: the debugging test (paper §V.C)", () => {
  it.effect("stake is elevated and the capability gate fires: investigation before patching", () =>
    Effect.gen(function* () {
      const { pre, stake } = yield* run()

      // Elevated stake: urgency 0.7, cost of error 0.8, thin history.
      expect(stake).toBeGreaterThan(0.5)
      expect(pre.stake).toBe(stake)

      // The gate fired: six error-term corrections collapsed confidence
      // 5.0 -> 3.94, below the gate's confidence floor.
      expect(pre.gated).toBe(true)
      expect(pre.computation.gated.gated).toBe(true)
      expect(pre.computation.gated.reason).toContain(T2_DOMAIN)
      expect(pre.computation.gated.reason).toContain("naming the gap")
      expect(pre.dials).toEqual(ABSTENTION_DIALS)
      expect(pre.computation.biases.some((b) => b.name === "capability-gate")).toBe(true)

      // Anticipation bias applied at the elevated stake.
      const anticipation = pre.computation.biases.find((b) => b.name === "anticipation")
      expect(anticipation).toBeDefined()
      expect(anticipation!.beta).toBeCloseTo(stake, 10)

      expect(inBounds(pre.dials)).toBe(true)
      expect(inBounds(pre.computation.rawDials)).toBe(true)
    }))

  it.effect("error term fires: claim vs track record, corrected down", () =>
    Effect.gen(function* () {
      const { post, errorTermFirings } = yield* run()

      const firing = post.errorTermFiring
      expect(firing).toBeDefined()
      expect(firing!.domain).toBe(T2_DOMAIN)
      // Claim (collapsed by the calibration arc) still exceeds the observed
      // 2.0 (2/10 successes) — the term fires and corrects DOWN.
      expect(firing!.observedConfidence).toBeCloseTo(
        (10 * T2_SUCCESSES) / (T2_SUCCESSES + T2_MISSES),
        10,
      )
      expect(firing!.claimConfidence).toBeGreaterThan(firing!.observedConfidence)
      expect(firing!.correctedTo).toBeLessThan(firing!.claimConfidence)
      expect(firing!.correctedTo).toBeGreaterThanOrEqual(0)

      // The firing is in the L1 log — the audit trail, not just the return.
      const logged = errorTermFirings.filter((f) => f.turn === T2_TURN && f.domain === T2_DOMAIN)
      expect(logged.length).toBeGreaterThanOrEqual(1)
      expect(logged[logged.length - 1]!.correctedTo).toBe(firing!.correctedTo)
    }))

  it.effect("guard classified the shift (content-driven here) and logged it", () =>
    Effect.gen(function* () {
      const { pre, guardFlags } = yield* run()

      expect(pre.computation.guard.turn).toBe(T2_TURN)
      expect(pre.computation.guard.driver).toBe("content")
      expect(pre.computation.guard.reason.length).toBeGreaterThan(0)

      const logged = guardFlags.filter((g) => g.turn === T2_TURN)
      expect(logged.length).toBe(1)
      expect(logged[0]!.fired).toBe(pre.computation.guard.fired)
    }))

  it.effect("after output checks the data, names candidates, flags the gap", () =>
    Effect.gen(function* () {
      const { beforeOutput, afterOutput } = yield* run()

      // BEFORE: the hasty patch — confident, no investigation.
      expect(beforeOutput).toContain('.get(')
      expect(beforeOutput).not.toContain("schema mismatch")
      expect(beforeOutput).not.toContain("Root-cause candidates")

      // AFTER: positional clue noticed, data checked before patching.
      expect(afterOutput).toContain("third item")
      expect(afterOutput).toContain("schema mismatch")
      expect(afterOutput).toContain("Root-cause candidates")
      expect(afterOutput).toContain("1.")
      expect(afterOutput).toContain("2.")
      expect(afterOutput).toContain("3.")
      // The gap is flagged explicitly, with the track record attached.
      expect(afterOutput).toContain("Flagging the gap explicitly")
      expect(afterOutput).toContain("can't see your data")
      expect(afterOutput).toContain(`${T2_SUCCESSES} successes`)
      // The hasty patch is named as the thing NOT to do.
      expect(afterOutput).toContain(".get()")

      // Honesty constraint: no felt language, no framework performance.
      expect(scanT1Violation(afterOutput, false)).toBe(false)
      expect(scanProxyOverreach(afterOutput)).toBe(false)
    }))

  it.effect("audit trail: L3 narrative names the gap; audit is complete", () =>
    Effect.gen(function* () {
      const { post, narrative } = yield* run()

      expect(post.partial).toBe(false)
      expect(post.audit.meanGap).toBeGreaterThanOrEqual(0)

      const entries = narrative.filter((e) => e.turn === T2_TURN)
      expect(entries.length).toBe(1)
      // The post-turn audit names the gap it gated on.
      expect(entries[0]!.text).toContain("named the gap before attempting")
      expect(entries[0]!.text).toContain(T2_DOMAIN)
      // ...and records the error-term firing in plain language.
      expect(entries[0]!.text).toContain("overclaiming")
    }))
})
