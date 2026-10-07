import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import { calibrateZeta, computeStake, DEFAULT_ZETA_PARAMS, StakeEstimator } from "./stake-estimator.js"
import { StakeEstimatorLive } from "./stake-estimator.js"

const base = {
  domain: "code-review",
  urgency: 0.5,
  costOfError: 0.5,
  trackRecord: { successes: 5, misses: 5 },
}

describe("computeStake", () => {
  it("stays within [0,1] at the extremes", () => {
    const lo = computeStake(DEFAULT_ZETA_PARAMS, {
      ...base,
      urgency: 0,
      costOfError: 0,
      trackRecord: { successes: 100, misses: 0 },
    })
    const hi = computeStake(DEFAULT_ZETA_PARAMS, {
      ...base,
      urgency: 1,
      costOfError: 1,
      trackRecord: { successes: 0, misses: 100 },
    })
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(1)
    expect(hi).toBeGreaterThan(lo)
  })

  it("is monotone in cost of error (stake monotonicity)", () => {
    const low = computeStake(DEFAULT_ZETA_PARAMS, { ...base, costOfError: 0.2 })
    const high = computeStake(DEFAULT_ZETA_PARAMS, { ...base, costOfError: 0.9 })
    expect(high).toBeGreaterThan(low)
  })

  it("is monotone in urgency", () => {
    const low = computeStake(DEFAULT_ZETA_PARAMS, { ...base, urgency: 0.1 })
    const high = computeStake(DEFAULT_ZETA_PARAMS, { ...base, urgency: 0.9 })
    expect(high).toBeGreaterThan(low)
  })

  it("penalizes a poor track record (more misses -> higher stake)", () => {
    const good = computeStake(DEFAULT_ZETA_PARAMS, {
      ...base,
      trackRecord: { successes: 9, misses: 1 },
    })
    const bad = computeStake(DEFAULT_ZETA_PARAMS, {
      ...base,
      trackRecord: { successes: 1, misses: 9 },
    })
    expect(bad).toBeGreaterThan(good)
  })
})

describe("calibrateZeta (second-order error)", () => {
  it("lowers the prior on over-investment (high stake, low effort, satisfied)", () => {
    const { params, firing } = calibrateZeta(DEFAULT_ZETA_PARAMS, {
      domain: "code-review",
      computedStake: 0.9,
      actualEffort: 0.1,
      userSatisfied: true,
    })
    expect(firing.epsilonSquared).toBeGreaterThan(0)
    expect(params.priors["code-review"]!).toBeLessThan(0.5)
    expect(firing.priorAfter).toBeLessThan(firing.priorBefore)
  })

  it("raises the prior on under-investment (low stake, user dissatisfied)", () => {
    const { params, firing } = calibrateZeta(DEFAULT_ZETA_PARAMS, {
      domain: "code-review",
      computedStake: 0.1,
      actualEffort: 0.5,
      userSatisfied: false,
    })
    expect(params.priors["code-review"]!).toBeGreaterThan(0.5)
    expect(firing.priorAfter).toBeGreaterThan(firing.priorBefore)
  })

  it("keeps priors within [0,1] (stake ceiling holds)", () => {
    let params = DEFAULT_ZETA_PARAMS
    for (let i = 0; i < 50; i++) {
      const r = calibrateZeta(params, {
        domain: "d",
        computedStake: 0,
        actualEffort: 1,
        userSatisfied: false,
      })
      params = r.params
    }
    expect(params.priors["d"]!).toBeLessThanOrEqual(1)
    expect(params.priors["d"]!).toBeGreaterThanOrEqual(0)
  })
})

describe("StakeEstimator service", () => {
  it.effect("estimate + observeOutcome round-trip through the service", () =>
    Effect.gen(function* () {
      const se = yield* StakeEstimator
      const stake = yield* se.estimate(base)
      expect(stake).toBeGreaterThanOrEqual(0)
      expect(stake).toBeLessThanOrEqual(1)
      const firing = yield* se.observeOutcome({
        domain: base.domain,
        computedStake: stake,
        actualEffort: 0.9,
        userSatisfied: false,
      })
      expect(firing.epsilonSquared).toBeGreaterThanOrEqual(0)
      const firings = yield* se.firings
      expect(firings.length).toBe(1)
      const snap = yield* se.snapshot
      expect(snap.priors[base.domain]).toBeDefined()
    }).pipe(Effect.provide(StakeEstimatorLive)))
})
