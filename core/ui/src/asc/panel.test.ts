/**
 * ASC panel integration tests — the slice mounted against the REAL ASC
 * services (live ASCEngine boundary + the L2 pipeline + L1), never mocks.
 *
 * - run a pipeline dial computation → the slice's displayed dials ===
 *   the engine's live dials
 * - `DialComputationArchived` (the pipeline's read-only write) updates the
 *   slice
 * - `AffectTuningChanged` → the `RecordTuningChange` command → the command's
 *   effect calls the frozen boundary's `recordEvidence`, which routes to the
 *   internal `recordTuningChange` seam (asserted via L1's tuning history);
 *   the live dials are untouched
 * - unknown tuning parameters are dropped before they ever reach the seam
 */
import { Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { ASCEngine, ASCEngineLive } from "../../../asc-engine/engine.js"
import { AscSelfMonitor, AscSelfMonitorLive } from "../../../asc-engine/asc-self-monitor.js"
import { AscSelfModel, AscSelfModelLive } from "../../../asc-engine/asc-self-model.js"
import { DialStateLive } from "../../../asc-engine/dial-state.js"
import { SomaticProxiesLive } from "../../../asc-engine/somatic-proxies.js"
import { StakeEstimatorLive } from "../../../asc-engine/stake-estimator.js"
import { AscSelfNarrationLive } from "../../../asc-engine/asc-self-narration.js"
import { OtherModelGuardLive } from "../../../asc-engine/other-model-guard.js"
import {
  DeterministicAuxModelLive,
  InMemoryMemoryReaderLive,
} from "../../../asc-engine/seams.js"

import {
  initialAscSlice,
  loadAscSlice,
  type AscSlice,
} from "./model.js"
import { Message, type AscMessage } from "./messages.js"
import { update } from "./update.js"

// --- live service stack --------------------------------------------------------
// One shared DialState across ASCEngine, AscSelfMonitor, and AscSelfModel:
// Layer.build memoizes by layer identity, so every consumer sees the same
// session state.

const CoreLive = Layer.provide(
  Layer.mergeAll(
    DialStateLive,
    SomaticProxiesLive,
    StakeEstimatorLive,
    DeterministicAuxModelLive,
    AscSelfModelLive,
    AscSelfNarrationLive,
    OtherModelGuardLive,
  ),
  InMemoryMemoryReaderLive,
)
const MonitorLive = Layer.provide(AscSelfMonitorLive, CoreLive)
const EngineLive = Layer.provide(ASCEngineLive, Layer.mergeAll(CoreLive, MonitorLive))
const TestLive = Layer.mergeAll(EngineLive, MonitorLive, CoreLive)

const testTurn = (turn: number) =>
  Effect.gen(function* () {
    const monitor = yield* AscSelfMonitor
    return yield* monitor.preTurn({
      turn,
      content: {
        domain: "general",
        summary: `integration test turn ${turn}`,
        urgency: 0.3,
        costOfError: 0.2,
        cues: { personal: 0.2, playful: 0.1, urgent: 0.2, uncertain: 0.3 },
        isMetaQuestion: false,
      },
      proxies: {
        contextPressurePct: 20,
        selfCorrectionCount: 0,
        turnCount: turn,
        toolFailureRate: 0,
      },
    })
  })

const plainDials = (slice: AscSlice) => ({ ...slice.dials })

describe("ASC panel against live services", () => {
  it.effect("slice dials === engine dials after a pipeline computation", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      const pre = yield* testTurn(1)

      const slice = yield* loadAscSlice
      const live = yield* engine.currentDials

      // Displayed dials === service state.
      expect(plainDials(slice)).toEqual({
        warmth: live.warmth,
        playfulness: live.playfulness,
        intensity: live.intensity,
        vulnerability: live.vulnerability,
      })
      // The pipeline's own result agrees too (single writer, no drift).
      expect(pre.dials).toEqual({
        warmth: live.warmth,
        playfulness: live.playfulness,
        intensity: live.intensity,
        vulnerability: live.vulnerability,
      })
      // The archived computation feeds the sparkline history.
      expect(slice.dialHistory.length).toBeGreaterThan(0)
      const last = slice.dialHistory[slice.dialHistory.length - 1]
      expect(last?.turn).toBe(1)
      expect(last?.finalDials).toEqual(plainDials(slice))
      expect(slice.interfaceVersion).toBe("1.0.0")
    }).pipe(Effect.provide(TestLive)),
  )

  it.effect("DialComputationArchived updates the slice (pipeline read-only write)", () =>
    Effect.gen(function* () {
      yield* testTurn(2)
      const slice = yield* loadAscSlice
      const archived = slice.dialHistory[slice.dialHistory.length - 1]
      if (archived === undefined) throw new Error("expected an archived computation")

      const next = update(initialAscSlice, Message.DialComputationArchived({ computation: archived }))
      expect(next.model.dials).toEqual({ ...archived.finalDials })
      expect(next.model.dialHistory).toHaveLength(1)
      // Archiving emits no commands: it is a pure read of pipeline state.
      expect(next.commands).toBeUndefined()
    }).pipe(Effect.provide(TestLive)),
  )

  it.effect("AffectTuningChanged → Command → recordTuningChange seam; dials untouched", () =>
    Effect.gen(function* () {
      const engine = yield* ASCEngine
      const selfModel = yield* AscSelfModel
      const slice = yield* loadAscSlice
      const before = yield* engine.currentDials

      const result = update(
        slice,
        Message.AffectTuningChanged({ parameter: "spilloverRatio", to: 0.6 }),
      )
      expect(result.commands).toHaveLength(1)
      const command = result.commands?.[0]
      if (command === undefined) throw new Error("expected the tuning command")
      expect(command.name).toBe("RecordTuningChange")
      expect(command.args).toMatchObject({
        parameter: "spilloverRatio",
        from: 0.5,
        to: 0.6,
      })

      // Run the command's effect exactly as the foldkit runtime would at the
      // shell boundary: the effect calls the frozen boundary's recordEvidence,
      // which routes internally to AscSelfModel.recordTuningChange.
      const produced = yield* command.effect.pipe(Effect.provide(TestLive))
      expect(produced._tag).toBe("TuningChangeRecorded")
      if (produced._tag !== "TuningChangeRecorded") throw new Error("unreachable")
      expect(produced.parameter).toBe("spilloverRatio")
      expect(produced.from).toBe(0.5)
      expect(produced.to).toBe(0.6)

      // The seam received it: L1's affect-tuning history carries the change.
      const history = yield* selfModel.tuningHistory(10)
      expect(
        history.some((h) => h.parameter === "spilloverRatio" && h.from === 0.5 && h.to === 0.6),
      ).toBe(true)

      // Tuning never moves the dials themselves.
      const after = yield* engine.currentDials
      expect({ ...after }).toEqual({ ...before })

      // Feeding the result message back updates the slice's target + log.
      const confirmed = update(result.model, produced)
      const target = confirmed.model.tuning.find((t) => t.parameter === "spilloverRatio")
      expect(target?.value).toBe(0.6)
      expect(confirmed.model.tuningLog.at(-1)).toMatchObject({
        parameter: "spilloverRatio",
        from: 0.5,
        to: 0.6,
      })
      expect(confirmed.commands).toBeUndefined()
    }).pipe(Effect.provide(TestLive)),
  )

  it("drops tuning changes for unknown parameters before they reach the seam", () => {
    const result = update(
      initialAscSlice,
      Message.AffectTuningChanged({ parameter: "dialHack", to: 9 }),
    )
    expect(result.commands).toBeUndefined()
    expect(result.model).toEqual(initialAscSlice)
  })

  it("guard, error-term, and diagnostic messages update their feeds", () => {
    const m1 = update(
      initialAscSlice,
      Message.OtherModelGuardFired({
        classification: {
          turn: 3,
          at: "2026-10-07T00:00:00.000Z",
          fired: true,
          driver: "content",
          reason: "approval-seeking shift",
        },
      }),
    )
    expect(m1.model.guardFeed).toHaveLength(1)
    expect(m1.model.guardFeed[0]?.fired).toBe(true)

    const m2 = update(
      m1.model,
      Message.ErrorTermFired({
        firing: {
          id: "et-1",
          turn: 3,
          at: "2026-10-07T00:00:01.000Z",
          domain: "general",
          claimConfidence: 8,
          observedConfidence: 5,
          correctedTo: 6,
        },
      }),
    )
    expect(m2.model.errorFirings).toHaveLength(1)

    const m3 = update(
      m2.model,
      Message.DiagnosticRunCompleted({
        at: "2026-10-07T00:00:02.000Z",
        passed: 14,
        total: 16,
        regressedDomains: ["security"],
      }),
    )
    expect(m3.model.diagnostic).toMatchObject({ passed: 14, total: 16 })
    expect(m3.commands).toBeUndefined()
  })

  it("a failed tuning change surfaces as a message, never a silent drop", () => {
    const m = update(
      initialAscSlice,
      Message.TuningChangeFailed({
        parameter: "spilloverRatio",
        reason: "unknown evidence kind",
        at: "2026-10-07T00:00:03.000Z",
      }),
    )
    expect(m.model.tuningError).toMatchObject({
      parameter: "spilloverRatio",
      reason: "unknown evidence kind",
    })
    // The failed value never lands in the targets or the log.
    expect(m.model.tuning.find((t) => t.parameter === "spilloverRatio")?.value).toBe(0.5)
    expect(m.model.tuningLog).toHaveLength(0)
  })
})
