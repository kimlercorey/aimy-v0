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
      yield* model.recordSurprise("research", 0.8)
      const state = yield* model.snapshot
      const tr = state.trackRecord["research"]!
      expect(tr.successes).toBe(0)
      expect(tr.misses).toBe(0)
      expect(tr.surprises.length).toBe(1)
      expect(tr.surprises[0]!.ed).toBe(0.8)
    }).pipe(Effect.provide(modelLayer())))
})
