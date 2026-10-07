import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import { AscError } from "./errors-shim.js"
import { ASCEngine, INTERFACE_VERSION } from "./engine.js"
import { DIAL_NAMES } from "./dial-state.js"
import { T1_VOCABULARY } from "./asc-self-monitor.js"
import { freshEngineLayer } from "./test-layers.js"

/** The frozen v1 surface — exactly these members, no more, no less. */
const FROZEN_MEMBERS = [
  "capabilityMap",
  "currentDials",
  "dialHistory",
  "errorTermFirings",
  "guardFlags",
  "interfaceVersion",
  "narrative",
  "recordEvidence",
].sort()

const inBounds = (v: Record<string, number>) =>
  DIAL_NAMES.every((d) => v[d]! >= 0 && v[d]! <= 10)

describe("ASCEngine frozen boundary (INTERFACE.md v1)", () => {
  it.effect("exposes exactly the frozen member set", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      expect(Object.keys(engine).sort()).toEqual(FROZEN_MEMBERS)
      // No dial write, no narrative edit, no model reset anywhere.
      for (const banned of ["setDials", "editNarrative", "deleteEntry", "resetModel", "tuneBlend"]) {
        expect(banned in engine).toBe(false)
      }
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("interfaceVersion is 1.0.0", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      const v = yield* engine.interfaceVersion
      expect(v).toBe("1.0.0")
      expect(INTERFACE_VERSION).toBe("1.0.0")
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("currentDials starts neutral and stays in bounds", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      const dials = yield* engine.currentDials
      expect(dials).toEqual({ warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 })
      expect(inBounds(dials)).toBe(true)
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("recordEvidence routes taskOutcome into the capability map", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      yield* engine.recordEvidence({
        kind: "taskOutcome",
        domain: "code-review",
        payload: { success: true, receiptId: "hook-1" },
      })
      const map = yield* engine.capabilityMap
      expect(map["code-review"]).toBeDefined()
      expect(map["code-review"]!.sampleCount).toBe(1)
      // Symmetric error term: one success moves the seeded claim 5.0 toward
      // the observed 10.0 by α·(1−λ)·w = 0.15·0.7·(1/6) — calibrated, not collapsed.
      expect(map["code-review"]!.confidence).toBeCloseTo(5.0875, 4)
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("recordEvidence routes surprise without fabricating an outcome", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      yield* engine.recordEvidence({
        kind: "surprise",
        domain: "research",
        payload: { epistemicDisruption: 0.8, note: "unexpected API behavior" },
      })
      const notes = yield* engine.narrative()
      expect(notes.some((n) => n.text.includes("unexpected API behavior"))).toBe(true)
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("recordEvidence routes tuningChange into the tuning record + narrative", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      yield* engine.recordEvidence({
        kind: "tuningChange",
        payload: { parameter: "spilloverRatio", from: 0.5, to: 0.6 },
      })
      const notes = yield* engine.narrative()
      expect(notes.some((n) => n.text.includes("spilloverRatio"))).toBe(true)
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("recordEvidence rejects unknown kinds loudly", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      const err = yield* Effect.flip(
        engine.recordEvidence({ kind: "dropTable", payload: {} } as never),
      )
      expect(err).toBeInstanceOf(AscError)
      expect(err.reason).toContain("unknown evidence kind")
      // Typed failure: the reason names the offending kind.
      expect(err.reason).toContain("dropTable")
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("taskOutcome miscalibration is corrected and narrated in plain language", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      for (let i = 0; i < 3; i++) {
        yield* engine.recordEvidence({
          kind: "taskOutcome",
          domain: "code-review",
          payload: { success: true },
        })
      }
      for (let i = 0; i < 7; i++) {
        yield* engine.recordEvidence({
          kind: "taskOutcome",
          domain: "code-review",
          payload: { success: false },
        })
      }
      const firings = yield* engine.errorTermFirings()
      expect(firings.length).toBeGreaterThanOrEqual(1)
      expect(firings[0]!.domain).toBe("code-review")
      const notes = yield* engine.narrative()
      const correction = notes.find((n) => n.text.startsWith("Correction in code-review:"))
      expect(correction).toBeDefined()
      // Plain language per the T1 rule: no framework vocabulary in L3.
      for (const word of T1_VOCABULARY) {
        expect(correction!.text.toLowerCase()).not.toContain(word)
      }
      expect(correction!.text).toContain("track record")
      expect(correction!.text).toContain("Adjusted to")
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("recordEvidence routes errorTermLambda into the tuning record + narrative", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      yield* engine.recordEvidence({
        kind: "tuningChange",
        payload: { parameter: "errorTermLambda", from: 0.3, to: 0.6 },
      })
      const notes = yield* engine.narrative()
      expect(
        notes.some(
          (n) =>
            n.text.includes("errorTermLambda") &&
            n.text.includes("0.3") &&
            n.text.includes("0.6"),
        ),
      ).toBe(true)
    }).pipe(Effect.provide(freshEngineLayer())))

  it.effect("reads return snapshots: history, firings, flags, narrative", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      const [history, firings, flags, notes] = yield* Effect.all([
        engine.dialHistory(),
        engine.errorTermFirings(),
        engine.guardFlags(),
        engine.narrative(),
      ])
      expect(Array.isArray(history)).toBe(true)
      expect(Array.isArray(firings)).toBe(true)
      expect(Array.isArray(flags)).toBe(true)
      expect(Array.isArray(notes)).toBe(true)
    }).pipe(Effect.provide(freshEngineLayer())))
})
