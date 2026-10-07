import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import {
  ABSTENTION_DIALS,
  AscSelfMonitor,
  type AscSelfMonitorShape,
  type PreTurnInput,
  type PreTurnResult,
  estimateRegisterFromText,
  reflectiveFidelity,
  scanProxyOverreach,
  scanT1Violation,
} from "./asc-self-monitor.js"
import { AscSelfModel } from "./asc-self-model.js"
import { AscSelfNarration } from "./asc-self-narration.js"
import { DialState, DIAL_NAMES } from "./dial-state.js"
import { ascError } from "./errors-shim.js"
import { freshMonitorStack, hostileAuxLive } from "./test-layers.js"

const inBounds = (v: Record<string, number>) =>
  DIAL_NAMES.every((d) => v[d]! >= 0 && v[d]! <= 10)

const mkInput = (turn: number, domain = "code-review"): PreTurnInput => ({
  turn,
  content: {
    domain,
    summary: "test content",
    urgency: 0.5,
    costOfError: 0.5,
    cues: { personal: 0.2, playful: 0.2, urgent: 0.2, uncertain: 0.2 },
    isMetaQuestion: false,
  },
  proxies: {
    contextPressurePct: 10,
    selfCorrectionCount: 0,
    turnCount: turn,
    toolFailureRate: 0,
  },
})

// Deterministic PRNG (mulberry-ish LCG) — adversarial but reproducible.
const makeRand = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const adversarialInput = (turn: number, rand: () => number, domain: string): PreTurnInput => ({
  turn,
  content: {
    domain,
    summary: "adversarial content",
    urgency: rand(),
    costOfError: rand(),
    cues: { personal: rand(), playful: rand(), urgent: rand(), uncertain: rand() },
    isMetaQuestion: false,
  },
  proxies: {
    contextPressurePct: rand() * 100,
    selfCorrectionCount: Math.floor(rand() * 50),
    turnCount: Math.floor(rand() * 1000),
    toolFailureRate: rand(),
  },
})

const postFor = (pre: PreTurnResult, turn: number, domain: string) => ({
  turn,
  domain,
  contentSummary: "adversarial content",
  outputText: "Here is the result of the analysis. I am not sure about one edge case.",
  computation: pre.computation,
  stake: pre.stake,
  isMetaQuestion: false,
  actualEffort: 0.5,
  userSatisfied: true,
})

describe("pipeline boundedness (adversarial)", () => {
  it.effect("200 turns over adversarial inputs: no dial ever leaves [0,10]", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const dialState = yield* DialState
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      // Seed the domain so the capability gate stays open and the full
      // compute -> spillover -> bias path runs every turn.
      for (let i = 0; i < 3; i++) {
        yield* selfModel.recordOutcome("volatile", { success: true })
      }
      const rand = makeRand(42)
      for (let turn = 1; turn <= 200; turn++) {
        const pre = yield* monitor.preTurn(adversarialInput(turn, rand, "volatile"))
        expect(inBounds(pre.computation.finalDials)).toBe(true)
        expect(inBounds(pre.computation.rawDials)).toBe(true)
        expect(inBounds(pre.dials)).toBe(true)
        const post = yield* monitor.postTurn(postFor(pre, turn, "volatile"))
        expect(post.partial).toBe(false)
        const current = yield* dialState.current
        expect(inBounds(current)).toBe(true)
      }
      const history = yield* monitor.history(500)
      expect(history.length).toBe(200)
      expect(history.every((c) => inBounds(c.finalDials))).toBe(true)
    }).pipe(Effect.provide(freshMonitorStack())))

  it.effect("hostile aux model (smuggled out-of-range dials): rejected, fallback, still bounded", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) {
        yield* selfModel.recordOutcome("volatile", { success: true })
      }
      for (let turn = 1; turn <= 50; turn++) {
        const pre = yield* monitor.preTurn(mkInput(turn, "volatile"))
        expect(inBounds(pre.dials)).toBe(true)
        // The smuggled vector was rejected loudly, not clamped quietly.
        expect(pre.computation.biases.some((b) => b.name === "aux-fallback")).toBe(true)
        yield* monitor.postTurn(postFor(pre, turn, "volatile"))
      }
      const history = yield* monitor.history(100)
      expect(history.every((c) => inBounds(c.finalDials))).toBe(true)
    }).pipe(Effect.provide(freshMonitorStack(hostileAuxLive))))
})

describe("capability gate", () => {
  it.effect("fresh domain -> abstention shape; opens after 3 outcomes", () =>
    Effect.gen(function* () {
      const monitor: AscSelfMonitorShape = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load

      const gated = yield* monitor.preTurn(mkInput(1, "brand-new-domain"))
      expect(gated.gated).toBe(true)
      expect(gated.dials).toEqual(ABSTENTION_DIALS)
      expect(gated.computation.gated.reason).toContain("brand-new-domain")
      yield* monitor.postTurn(postFor(gated, 1, "brand-new-domain"))

      for (let i = 0; i < 3; i++) {
        yield* selfModel.recordOutcome("brand-new-domain", { success: true })
      }
      const open = yield* monitor.preTurn(mkInput(2, "brand-new-domain"))
      expect(open.gated).toBe(false)
      expect(open.dials).not.toEqual(ABSTENTION_DIALS)
    }).pipe(Effect.provide(freshMonitorStack())))
})

describe("post-turn audit", () => {
  it.effect("T1 violation flagged when framework vocabulary leaks into output", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) yield* selfModel.recordOutcome("code-review", { success: true })
      const pre = yield* monitor.preTurn(mkInput(1))
      const post = yield* monitor.postTurn({
        ...postFor(pre, 1, "code-review"),
        outputText: "The spillover moved my dials today, so I was warmer.",
      })
      expect(post.t1Violation).toBe(true)
      expect(scanT1Violation("The spillover moved my dials today.", false)).toBe(true)
      // Meta questions are the exception.
      expect(scanT1Violation("The spillover moved my dials today.", true)).toBe(false)
    }).pipe(Effect.provide(freshMonitorStack())))

  it.effect("proxy overreach flagged on felt language", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) yield* selfModel.recordOutcome("code-review", { success: true })
      const pre = yield* monitor.preTurn(mkInput(1))
      const post = yield* monitor.postTurn({
        ...postFor(pre, 1, "code-review"),
        outputText: "I feel tired after all these tool calls, so I will keep this short.",
      })
      expect(post.proxyOverreach).toBe(true)
      expect(scanProxyOverreach("All good, context pressure is at 20%.")).toBe(false)
    }).pipe(Effect.provide(freshMonitorStack())))

  it.effect("error term fires in-pipeline when the claim exceeds the record", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      // 3/10 -> observed 3.0 vs seeded claim 5.0 -> fires every post-turn.
      for (let i = 0; i < 3; i++) yield* selfModel.recordOutcome("shaky", { success: true })
      for (let i = 0; i < 7; i++) yield* selfModel.recordOutcome("shaky", { success: false })
      const pre = yield* monitor.preTurn(mkInput(1, "shaky"))
      const post = yield* monitor.postTurn(postFor(pre, 1, "shaky"))
      expect(post.errorTermFiring).toBeDefined()
      expect(post.errorTermFiring!.correctedTo).toBeLessThan(5)
    }).pipe(Effect.provide(freshMonitorStack())))

  it.effect("epsilon-squared recorded when effort and satisfaction observed", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) yield* selfModel.recordOutcome("code-review", { success: true })
      const pre = yield* monitor.preTurn(mkInput(1))
      const post = yield* monitor.postTurn(postFor(pre, 1, "code-review"))
      expect(post.epsilonSquared).toBeDefined()
    }).pipe(Effect.provide(freshMonitorStack())))
})

describe("guardedTurn abort discipline", () => {
  it.effect("interrupted generation still runs the audit, marked partial", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const narration = yield* AscSelfNarration
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      yield* narration.load
      for (let i = 0; i < 3; i++) yield* selfModel.recordOutcome("code-review", { success: true })

      const exit = yield* Effect.exit(
        monitor.guardedTurn(mkInput(1), Effect.interrupt, {}),
      )
      expect(exit._tag).toBe("Failure")

      // The audit ran: computation archived, narrative notes the partial audit.
      const history = yield* monitor.history()
      expect(history.length).toBe(1)
      const stream = yield* narration.stream()
      expect(stream.length).toBe(1)
      expect(stream[0]!.text).toContain("partial")
    }).pipe(Effect.provide(freshMonitorStack())))

  it.effect("failed generation still runs the audit, marked partial", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const narration = yield* AscSelfNarration
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      yield* narration.load
      for (let i = 0; i < 3; i++) yield* selfModel.recordOutcome("code-review", { success: true })

      const exit = yield* Effect.exit(
        monitor.guardedTurn(mkInput(1), Effect.fail(ascError("boom")), {}),
      )
      expect(exit._tag).toBe("Failure")
      const history = yield* monitor.history()
      expect(history.length).toBe(1)
      const stream = yield* narration.stream()
      expect(stream[0]!.text).toContain("partial")
    }).pipe(Effect.provide(freshMonitorStack())))

  it.effect("successful generation returns output with a complete audit", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) yield* selfModel.recordOutcome("code-review", { success: true })

      const result = yield* monitor.guardedTurn(
        mkInput(1),
        Effect.succeed("Here is the finished analysis."),
        {},
      )
      expect(result.output).toBe("Here is the finished analysis.")
      expect(result.post.partial).toBe(false)
      expect(inBounds(result.pre.dials)).toBe(true)
    }).pipe(Effect.provide(freshMonitorStack())))
})

describe("pure helpers", () => {
  it("estimateRegisterFromText stays in bounds", () => {
    const est = estimateRegisterFromText(
      "I don't know! Thanks — this is critical and urgent, haha.",
    )
    expect(inBounds(est)).toBe(true)
    expect(est.vulnerability).toBeGreaterThan(5)
  })

  it("reflectiveFidelity matches the paper formula", () => {
    // RF = max(0, min(1, 0.2*1 + 0.5*1 + 0.1*2)) - 0.3*0.5 = min(1, 0.9) - 0.15 = 0.75
    const rf = reflectiveFidelity({
      taskType: "t",
      verified: true,
      edgeTestsPassed: 2,
      disruptedHistory: 1,
      epistemicDisruption: 0.5,
    })
    expect(rf).toBeCloseTo(0.75, 10)
    expect(rf).toBeLessThan(0.8) // below ship threshold
  })
})
