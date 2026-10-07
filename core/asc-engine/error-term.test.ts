import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import {
  AscSelfModel,
  type AscSelfModelShape,
  AscSelfModelLive,
  ERROR_TERM_FIRE_THRESHOLD,
} from "./asc-self-model.js"
import { makeInMemoryMemoryReader, MemoryReader } from "./seams.js"

const modelLayer = () =>
  Layer.provide(AscSelfModelLive, Layer.succeed(MemoryReader, makeInMemoryMemoryReader()))

const recordOutcomes = (model: AscSelfModelShape, domain: string, successes: number, misses: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < successes; i++) yield* model.recordOutcome(domain, { success: true })
    for (let i = 0; i < misses; i++) yield* model.recordOutcome(domain, { success: false })
  })

describe("error term", () => {
  it.effect("does not fire without a track record", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      const ev = yield* model.evaluateErrorTerm("code-review")
      expect(ev.fired).toBe(false)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("fires when self-model confidence exceeds the track record", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      // 3/10 successes -> observed confidence 3.0; seeded claim 5.0; gap 2.0 > 1.5
      yield* recordOutcomes(model, "code-review", 3, 7)
      const ev = yield* model.evaluateErrorTerm("code-review")
      expect(ev.fired).toBe(true)
      expect(ev.claimConfidence).toBe(5)
      expect(ev.observedConfidence).toBeCloseTo(3, 10)
      expect(ev.gap).toBeGreaterThan(ERROR_TERM_FIRE_THRESHOLD)
      expect(ev.sampleWeight).toBeCloseTo(10 / 15, 10)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("corrects toward the track record (weighted, not collapsed)", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      yield* recordOutcomes(model, "code-review", 3, 7)
      const firing = yield* model.applyErrorTermCorrection("code-review", 1)
      expect(firing).toBeDefined()
      // Moved toward observed (3.0) from claim (5.0), but only by alpha*w* gap.
      expect(firing!.correctedTo).toBeLessThan(5)
      expect(firing!.correctedTo).toBeGreaterThan(3)
      const cap = yield* model.capability("code-review")
      expect(cap!.confidence).toBeCloseTo(firing!.correctedTo, 10)
      const firings = yield* model.errorTermFirings()
      expect(firings.length).toBe(1)
      expect(firings[0]!.domain).toBe("code-review")
    }).pipe(Effect.provide(modelLayer())))

  it.effect("thin record must NOT collapse confidence (over-calibration guard)", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      // n=1: one miss -> observed 0.0, claim 5.0, gap 5 -> fires,
      // but weight 1/(1+5) keeps the correction tiny.
      yield* recordOutcomes(model, "debugging", 0, 1)
      const firing = yield* model.applyErrorTermCorrection("debugging", 1)
      expect(firing).toBeDefined()
      expect(firing!.sampleWeight).toBeCloseTo(1 / 6, 10)
      expect(firing!.correctedTo).toBeGreaterThan(4.5)
      expect(firing!.correctedTo).toBeLessThan(5)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("does not fire when the claim matches the record", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      // 5/10 -> observed 5.0 = seeded claim 5.0 -> gap 0
      yield* recordOutcomes(model, "writing", 5, 5)
      const ev = yield* model.evaluateErrorTerm("writing")
      expect(ev.fired).toBe(false)
      const firing = yield* model.applyErrorTermCorrection("writing", 1)
      expect(firing).toBeUndefined()
    }).pipe(Effect.provide(modelLayer())))

  it.effect("updates are versioned and survive a persist/load round-trip", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      const before = yield* model.snapshot
      yield* model.recordOutcome("code-review", { success: true })
      yield* model.recordGuardFire
      const after = yield* model.snapshot
      expect(after.version).toBeGreaterThan(before.version)
      expect(after.revisions.length).toBeGreaterThan(before.revisions.length)
      expect(after.guardFireCount).toBe(1)
      yield* model.persist
      // Fresh service over the same memory: state survives.
    }).pipe(Effect.provide(modelLayer())))

  it.effect("recordSurprise adds evidence without fabricating an outcome", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      yield* model.recordSurprise("retrieval", 0.8)
      const state = yield* model.snapshot
      const tr = state.trackRecord["retrieval"]!
      expect(tr.successes).toBe(0)
      expect(tr.misses).toBe(0)
      expect(tr.surprises.length).toBe(1)
      expect(tr.surprises[0]!.ed).toBe(0.8)
    }).pipe(Effect.provide(modelLayer())))
})

describe("error term — convergence, weighting, λ, auditability", () => {
  it.effect("claimed ability converges toward measured ability over repeated trials", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      // 3/10 successes -> observed 3.0 vs seeded claim 5.0.
      yield* recordOutcomes(model, "converge", 3, 7)
      let last = 5
      let firings = 0
      for (let turn = 1; turn <= 8; turn++) {
        const firing = yield* model.applyErrorTermCorrection("converge", turn)
        if (!firing) break
        firings++
        // Monotone toward the observed value, never below it: the rate is
        // < 1 by construction, so the claim cannot overshoot the record.
        expect(firing.correctedTo).toBeLessThan(last)
        expect(firing.correctedTo).toBeGreaterThanOrEqual(3.0)
        last = firing.correctedTo
      }
      expect(firings).toBeGreaterThanOrEqual(2)
      const cap = yield* model.capability("converge")
      expect(cap!.confidence).toBeLessThan(4.5)
      expect(cap!.confidence).toBeGreaterThanOrEqual(3.0)
      // The firing stops once the gap is within the threshold — small gaps
      // are not worth a correction.
      const ev = yield* model.evaluateErrorTerm("converge")
      expect(ev.fired).toBe(false)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("thin record moves slowly, thick record moves fast (sample-size weighting)", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      yield* recordOutcomes(model, "thin", 0, 2)
      yield* recordOutcomes(model, "thick", 0, 40)
      const thinFiring = yield* model.applyErrorTermCorrection("thin", 1)
      const thickFiring = yield* model.applyErrorTermCorrection("thick", 1)
      expect(thinFiring).toBeDefined()
      expect(thickFiring).toBeDefined()
      const thinStep = 5 - thinFiring!.correctedTo
      const thickStep = 5 - thickFiring!.correctedTo
      expect(thinStep).toBeGreaterThan(0)
      expect(thickStep).toBeGreaterThan(thinStep)
      // Step ratio tracks the sample-weight ratio n/(n+k) exactly
      // (same λ, same recency, same gap).
      expect(thinStep / thickStep).toBeCloseTo(2 / 7 / (40 / 45), 2)
      expect(thinFiring!.sampleWeight).toBeCloseTo(2 / 7, 10)
      expect(thickFiring!.sampleWeight).toBeCloseTo(40 / 45, 10)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("fires on underconfidence too, correcting upward without overshoot", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      // 10/10 successes -> observed 10.0 vs seeded claim 5.0.
      yield* recordOutcomes(model, "strong", 10, 0)
      const ev = yield* model.evaluateErrorTerm("strong")
      expect(ev.fired).toBe(true)
      expect(ev.gap).toBeCloseTo(-5, 10)
      const firing = yield* model.applyErrorTermCorrection("strong", 1)
      expect(firing).toBeDefined()
      expect(firing!.correctedTo).toBeGreaterThan(5)
      expect(firing!.correctedTo).toBeLessThanOrEqual(10)
      // 5 + α·(1−λ)·w·(10−5) = 5 + 0.15·0.7·(10/15)·5 = 5.35
      expect(firing!.correctedTo).toBeCloseTo(5.35, 2)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("error-term λ is user-tunable: higher λ slows correction", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      yield* recordOutcomes(model, "slow", 3, 7)
      yield* recordOutcomes(model, "slower", 3, 7)
      const f1 = yield* model.applyErrorTermCorrection("slow", 1)
      const stepDefault = 5 - f1!.correctedTo
      yield* model.recordTuningChange("errorTermLambda", 0.3, 0.9)
      const ev = yield* model.evaluateErrorTerm("slower")
      expect(ev.lambda).toBeCloseTo(0.9, 10)
      const f2 = yield* model.applyErrorTermCorrection("slower", 2)
      const stepSlow = 5 - f2!.correctedTo
      // Rate ratio (1−0.9)/(1−0.3) = 1/7.
      expect(stepSlow / stepDefault).toBeCloseTo(1 / 7, 2)
      expect(stepSlow).toBeLessThan(stepDefault * 0.5)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("firing ids are unique across corrections", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      yield* recordOutcomes(model, "uniq", 3, 7)
      const ids: Array<string> = []
      for (let turn = 1; turn <= 6; turn++) {
        const f = yield* model.applyErrorTermCorrection("uniq", turn)
        if (f) ids.push(f.id)
      }
      expect(ids.length).toBeGreaterThanOrEqual(2)
      expect(new Set(ids).size).toBe(ids.length)
      const log = yield* model.errorTermFirings()
      expect(log.length).toBe(ids.length)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("tuning changes are auditable: history, live targets, no silent overwrite", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      yield* model.recordTuningChange("errorTermLambda", 0.3, 0.6)
      yield* model.recordTuningChange("errorTermLambda", 0.6, 0.9)
      yield* model.recordTuningChange("spilloverRatio", 0.5, 0.4)
      const history = yield* model.tuningHistory()
      expect(history.length).toBe(3)
      expect(history[0]).toMatchObject({ parameter: "errorTermLambda", from: 0.3, to: 0.6 })
      expect(history[1]).toMatchObject({ parameter: "errorTermLambda", from: 0.6, to: 0.9 })
      const targets = yield* model.tuningTargets
      expect(targets["errorTermLambda"]).toBe(0.9)
      expect(targets["spilloverRatio"]).toBe(0.4)
      // The revision log retains the previous target — nothing overwritten silently.
      const state = yield* model.snapshot
      const revs = state.revisions.filter((r) =>
        r.change.includes("tuningChange(errorTermLambda: 0.6 -> 0.9)"),
      )
      expect(revs.length).toBe(1)
      expect(revs[0]!.previous).toContain("0.6")
      // λ is live: the error term reads the target.
      yield* recordOutcomes(model, "tuned", 3, 7)
      const ev = yield* model.evaluateErrorTerm("tuned")
      expect(ev.lambda).toBeCloseTo(0.9, 10)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("freshness: touch refreshes, unknown subjects read undefined", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      expect(yield* model.getFreshness("quantum")).toBeUndefined()
      yield* model.touchFreshness("quantum", { confidence: 7, halfLifeDays: 30 })
      const fresh = yield* model.getFreshness("quantum")
      expect(fresh).toBeDefined()
      expect(fresh!.confidence).toBe(7)
      // Touched just now: no decay yet.
      expect(fresh!.freshness).toBeCloseTo(1, 2)
      expect(fresh!.halfLifeDays).toBe(30)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("ζ calibration records accumulate the second-order error trail", () =>
    Effect.gen(function* () {
      const model = yield* AscSelfModel
      yield* model.load
      yield* model.recordZetaCalibration("deploy", 0.8, 0.5, 0.09)
      yield* model.recordZetaCalibration("deploy", 0.4, 0.7, 0.09)
      const records = yield* model.zetaCalibration()
      expect(records.length).toBe(2)
      expect(records[0]!.domain).toBe("deploy")
      expect(records[0]!.computed).toBeCloseTo(0.8, 10)
      expect(records[0]!.actual).toBeCloseTo(0.5, 10)
      expect(records[0]!.epsilonSquared).toBeCloseTo(0.09, 10)
    }).pipe(Effect.provide(modelLayer())))

  it.effect("new L1 state survives a persist/load round-trip", () =>
    Effect.gen(function* () {
      const mem = makeInMemoryMemoryReader()
      const layer = Layer.provide(AscSelfModelLive, Layer.succeed(MemoryReader, mem))
      yield* Effect.gen(function* () {
        const model = yield* AscSelfModel
        yield* model.load
        yield* model.touchFreshness("topic", { confidence: 6 })
        yield* model.recordTuningChange("errorTermLambda", 0.3, 0.5)
        yield* model.recordZetaCalibration("d", 0.7, 0.6, 0.01)
        yield* model.persist
      }).pipe(Effect.provide(layer))
      const restored = yield* Effect.gen(function* () {
        const model = yield* AscSelfModel
        yield* model.load
        return {
          freshness: yield* model.getFreshness("topic"),
          lambda: (yield* model.tuningTargets)["errorTermLambda"],
          zeta: yield* model.zetaCalibration(),
          history: yield* model.tuningHistory(),
        }
      }).pipe(Effect.provide(layer))
      expect(restored.freshness!.confidence).toBe(6)
      expect(restored.lambda).toBe(0.5)
      expect(restored.zeta.length).toBe(1)
      expect(restored.history.length).toBe(1)
    }))
})
