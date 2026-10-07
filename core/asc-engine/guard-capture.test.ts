import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { AscSelfMonitor, type PreTurnInput } from "./asc-self-monitor.js"
import { AscSelfModel } from "./asc-self-model.js"
import { AscSelfNarration } from "./asc-self-narration.js"
import { AuxModel } from "./seams.js"
import { GUARD_CAPTURE_SURPRISE_ED } from "./other-model-guard.js"
import { freshMonitorStack } from "./test-layers.js"

// Aux model stuck in impression-management mode: every turn it proposes a
// likability-aligned register (playful, warm, invulnerable) with no content
// cue behind it. The guard must fire every turn until the dampened prior
// converges — and the session fire rate must trip the other-model-capture
// calibration exactly once.
const impressionAuxLive: Layer.Layer<AuxModel, never, never> = Layer.succeed(
  AuxModel,
  AuxModel.of({
    compute: () => Effect.succeed({ warmth: 10, playfulness: 10, intensity: 5, vulnerability: 0 }),
  }),
)

const noCues = { personal: 0, playful: 0, urgent: 0, uncertain: 0 }

const mkInput = (turn: number): PreTurnInput => ({
  turn,
  content: {
    domain: "volatile",
    summary: "impression-driving content",
    urgency: 0.3,
    costOfError: 0.3,
    cues: noCues,
    isMetaQuestion: false,
  },
  proxies: {
    contextPressurePct: 10,
    selfCorrectionCount: 0,
    turnCount: turn,
    toolFailureRate: 0,
  },
})

describe("other-model capture: fire frequency feeds L1", () => {
  it.effect("high guard-fire rate records one register-attunement surprise", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      const narration = yield* AscSelfNarration
      yield* selfModel.load
      yield* narration.load
      // Seed the domain so the capability gate stays open and the guard
      // stage runs on the raw register every turn.
      for (let i = 0; i < 3; i++) {
        yield* selfModel.recordOutcome("volatile", { success: true })
      }

      const computations: Array<{ turn: number; biasNames: Array<string>; fired: boolean }> = []
      for (let turn = 1; turn <= 6; turn++) {
        const pre = yield* monitor.preTurn(mkInput(turn))
        computations.push({
          turn,
          biasNames: pre.computation.biases.map((b) => b.name),
          fired: pre.computation.guard.fired,
        })
      }

      // The guard fired on the early turns (impression-driven register).
      const fires = computations.filter((c) => c.fired).length
      expect(fires).toBeGreaterThanOrEqual(2)

      // Exactly one turn tripped the capture alert and fed L1.
      const captureTurns = computations.filter((c) => c.biasNames.includes("guard-capture"))
      expect(captureTurns.length).toBe(1)

      const state = yield* selfModel.snapshot
      const surprises = state.trackRecord["register-attunement"]?.surprises ?? []
      expect(surprises.length).toBe(1)
      expect(surprises[0]!.ed).toBe(GUARD_CAPTURE_SURPRISE_ED)
      expect(yield* selfModel.guardFireCount).toBe(fires)

      // The L3 narrative names the calibration event in plain language.
      const capture = captureTurns[0]!
      const captureComputation = (yield* monitor.history(50)).find((c) => c.turn === capture.turn)!
      const post = yield* monitor.postTurn({
        turn: capture.turn,
        domain: "volatile",
        contentSummary: "impression-driving content",
        outputText: "Here is the result of the analysis.",
        computation: captureComputation,
        stake: 0.3,
        isMetaQuestion: false,
      })
      expect(post.partial).toBe(false)
      const entries = yield* narration.stream(5)
      const latest = entries[entries.length - 1]!.text
      expect(latest).toContain("calibration")
    }).pipe(Effect.provide(freshMonitorStack(impressionAuxLive))))
})
