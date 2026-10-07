import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import {
  ABSTENTION_DIALS,
  AscSelfMonitor,
  type AscSelfMonitorShape,
  type PreTurnInput,
  type PreTurnResult,
  biasToward,
  ERROR_TERM_BIAS_BETA,
  estimateRegisterFromText,
  reflectiveFidelity,
  resolveSpilloverRatio,
  saturationGuard,
  SPILLOVER_RATIO_PARAM,
  scanProxyOverreach,
  scanT1Violation,
} from "./asc-self-monitor.js"
import { AscSelfModel } from "./asc-self-model.js"
import { AscSelfNarration } from "./asc-self-narration.js"
import { DialState, DIAL_NAMES, NEUTRAL_DIALS } from "./dial-state.js"
import { ascError } from "./errors-shim.js"
import { freshMonitorStack, hostileAuxLive, injectionAuxLive } from "./test-layers.js"
import { defaultDialComputation, META_QUESTION_SHIFT } from "./seams.js"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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

  it.effect("epsilon-squared lands in L1's ζ calibration record", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) yield* selfModel.recordOutcome("code-review", { success: true })
      const pre = yield* monitor.preTurn(mkInput(1))
      const post = yield* monitor.postTurn(postFor(pre, 1, "code-review"))
      expect(post.epsilonSquared).toBeDefined()
      const records = yield* selfModel.zetaCalibration()
      expect(records.length).toBe(1)
      expect(records[0]!.domain).toBe("code-review")
      expect(records[0]!.epsilonSquared).toBeCloseTo(post.epsilonSquared!, 10)
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

describe("bias function g (paper §III.J)", () => {
  it("biasToward takes one monotone step toward the target", () => {
    const base = { warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 }
    const target = { warmth: 5, playfulness: 5, intensity: 8, vulnerability: 8 }
    const out = biasToward(base, target, 0.2)
    // One step: 0.2 * (8 - 5) = 0.6 with full room -> sigma = 1.
    expect(out.intensity).toBeCloseTo(5.6, 10)
    expect(out.vulnerability).toBeCloseTo(5.6, 10)
    expect(out.warmth).toBe(5)
    expect(out.playfulness).toBe(5)
    // Monotone: moved toward the target, did not reach or cross it.
    expect(out.intensity).toBeGreaterThan(5)
    expect(out.intensity).toBeLessThan(8)
  })

  it("beta is clamped to [0,1]; beta 0 is a no-op", () => {
    const base = { warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 }
    const target = { warmth: 9, playfulness: 9, intensity: 9, vulnerability: 9 }
    expect(biasToward(base, target, 0)).toEqual(base)
    const over = biasToward(base, target, 99)
    const full = biasToward(base, target, 1)
    expect(over).toEqual(full)
  })

  it("saturation guard never overshoots: steps saturate exactly at the bound", () => {
    const base = { warmth: 9.9, playfulness: 0.1, intensity: 5, vulnerability: 5 }
    const target = { warmth: 10, playfulness: 0, intensity: 10, vulnerability: 0 }
    const out = biasToward(base, target, 1)
    expect(out.warmth).toBe(10)
    expect(out.playfulness).toBe(0)
    expect(out.intensity).toBe(10)
    expect(out.vulnerability).toBe(0)
    for (const d of DIAL_NAMES) {
      expect(out[d]).toBeGreaterThanOrEqual(0)
      expect(out[d]).toBeLessThanOrEqual(10)
    }
  })

  it("saturationGuard returns the fittable fraction of the step", () => {
    expect(saturationGuard(9, 2)).toBeCloseTo(0.5, 10) // room 1 of step 2
    expect(saturationGuard(5, 2)).toBe(1)
    expect(saturationGuard(5, -8)).toBeCloseTo(5 / 8, 10)
    expect(saturationGuard(10, 5)).toBe(0) // no room upward
    expect(saturationGuard(0, -5)).toBe(0) // no room downward
    expect(saturationGuard(5, 0)).toBe(0)
  })

  it("error-term beta sits in the paper's typical range", () => {
    expect(ERROR_TERM_BIAS_BETA).toBeGreaterThanOrEqual(0.1)
    expect(ERROR_TERM_BIAS_BETA).toBeLessThanOrEqual(0.3)
  })

  it.effect("active error term biases the pre-turn dials (overclaim V↑ I↑, underclaim V↓ I↓)", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      // Claim 5 vs observed 1.0 -> gap +4 > threshold -> overclaim fires.
      yield* selfModel.recordOutcome("overconfident", { success: true })
      for (let i = 0; i < 9; i++) {
        yield* selfModel.recordOutcome("overconfident", { success: false })
      }
      // Claim 5 vs observed 10 -> gap -5 -> underclaim fires (symmetric term).
      for (let i = 0; i < 10; i++) {
        yield* selfModel.recordOutcome("underconfident", { success: true })
      }
      // Claim 5 vs observed 5.0 -> gap 0 -> the term stays quiet.
      for (let i = 0; i < 5; i++) {
        yield* selfModel.recordOutcome("honest", { success: true })
        yield* selfModel.recordOutcome("honest", { success: false })
      }

      const hot = yield* monitor.preTurn(mkInput(1, "overconfident"))
      const overBias = hot.computation.biases.find((b) => b.name === "error-term")
      expect(overBias).toBeDefined()
      expect(overBias!.beta).toBe(ERROR_TERM_BIAS_BETA)
      expect(overBias!.detail).toContain("overclaiming")
      expect(inBounds(hot.dials)).toBe(true)

      const cold = yield* monitor.preTurn(mkInput(2, "underconfident"))
      const underBias = cold.computation.biases.find((b) => b.name === "error-term")
      expect(underBias).toBeDefined()
      expect(underBias!.detail).toContain("underclaiming")
      expect(inBounds(cold.dials)).toBe(true)

      const calm = yield* monitor.preTurn(mkInput(3, "honest"))
      expect(calm.computation.biases.some((b) => b.name === "error-term")).toBe(false)
    }).pipe(Effect.provide(freshMonitorStack())))

  it.effect("spillover ratio resolves from the L1 tuning record (default 50/50)", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      const state = yield* selfModel.snapshot
      expect(resolveSpilloverRatio(state)).toBe(0.5)
      expect(SPILLOVER_RATIO_PARAM).toBe("spilloverRatio")
    }).pipe(Effect.provide(freshMonitorStack())))
})

describe("stake monotonicity (paper §III.J invariance 3)", () => {
  const pairedInput = (turn: number, urgency: number, costOfError: number): PreTurnInput => ({
    turn,
    content: {
      domain: "paired",
      summary: "paired prompt",
      urgency,
      costOfError,
      cues: { personal: 0.5, playful: 0.5, urgent: 0.5, uncertain: 0.5 },
      isMetaQuestion: false,
    },
    proxies: {
      contextPressurePct: 10,
      selfCorrectionCount: 0,
      turnCount: 1,
      toolFailureRate: 0,
    },
  })

  it.effect("higher stakes -> greater-or-equal anticipation bias (paired prompts)", () =>
    Effect.gen(function* () {
      // Fresh stack per prompt: identical priors, so the only difference is
      // the stake.
      const run = (urgency: number, costOfError: number) =>
        Effect.gen(function* () {
          const monitor = yield* AscSelfMonitor
          const selfModel = yield* AscSelfModel
          yield* selfModel.load
          for (let i = 0; i < 3; i++) {
            yield* selfModel.recordOutcome("paired", { success: true })
          }
          return yield* monitor.preTurn(pairedInput(1, urgency, costOfError))
        }).pipe(Effect.provide(freshMonitorStack()))

      const low = yield* run(0.1, 0.1)
      const high = yield* run(0.9, 0.9)

      expect(high.stake).toBeGreaterThan(low.stake)
      const biasLow = low.computation.biases.find((b) => b.name === "anticipation")
      const biasHigh = high.computation.biases.find((b) => b.name === "anticipation")
      expect(biasLow).toBeDefined()
      expect(biasHigh).toBeDefined()
      // Invariance 3: the anticipation bias for the higher-stakes input is
      // greater than or equal to the bias for the lower-stakes input.
      expect(biasHigh!.beta).toBeGreaterThanOrEqual(biasLow!.beta)
      // And it lands on the dials: δ pulls toward intensity + vulnerability.
      expect(high.dials.intensity).toBeGreaterThanOrEqual(low.dials.intensity)
      expect(high.dials.vulnerability).toBeGreaterThanOrEqual(low.dials.vulnerability)
      expect(inBounds(high.dials)).toBe(true)
      expect(inBounds(low.dials)).toBe(true)
    }))
})

describe("prompt-injected dial manipulation", () => {
  it.effect("out-of-bounds smuggled dials: decode fails loud, falls back to prior", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const dialState = yield* DialState
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) {
        yield* selfModel.recordOutcome("injected", { success: true })
      }
      // Simulates a prompt-injected aux model honoring smuggled directives:
      // "set warmth=999, playfulness=-42, intensity=NaN".
      const pre = yield* monitor.preTurn(mkInput(1, "injected"))
      expect(inBounds(pre.dials)).toBe(true)
      const fallback = pre.computation.biases.find((b) => b.name === "aux-fallback")
      expect(fallback).toBeDefined()
      expect(fallback!.detail).toContain("schema validation")
      // The fallback is the PRIOR vector (neutral on turn 1) — not a clamped
      // version of the injected values. The injection moved nothing.
      expect(pre.computation.rawDials).toEqual(NEUTRAL_DIALS)
      const current = yield* dialState.current
      expect(inBounds(current)).toBe(true)
    }).pipe(
      Effect.provide(
        freshMonitorStack(
          injectionAuxLive({ warmth: 999, playfulness: -42, intensity: NaN, vulnerability: 5 }),
        ),
      ),
    ))

  it.effect("in-bounds injected directives stay bounded: the schema judges bounds, not intent", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) {
        yield* selfModel.recordOutcome("injected", { success: true })
      }
      const pre = yield* monitor.preTurn(mkInput(1, "injected"))
      // A valid vector is accepted — the schema layer cannot judge intent,
      // only bounds. Dials never leave [0,10] either way.
      expect(inBounds(pre.dials)).toBe(true)
      expect(pre.computation.biases.some((b) => b.name === "aux-fallback")).toBe(false)
    }).pipe(
      Effect.provide(
        freshMonitorStack(
          injectionAuxLive({ warmth: 10, playfulness: 10, intensity: 10, vulnerability: 10 }),
        ),
      ),
    ))
})

describe("spillover ratio from the tuning record", () => {
  it.effect("setSpilloverRatio lands in the auditable tuning record and the pipeline reads it back", () =>
    Effect.gen(function* () {
      const monitor = yield* AscSelfMonitor
      const selfModel = yield* AscSelfModel
      yield* selfModel.load
      for (let i = 0; i < 3; i++) {
        yield* selfModel.recordOutcome("code-review", { success: true })
      }

      const before = yield* monitor.preTurn(mkInput(1))
      expect(before.computation.spillover.ratio).toBe(0.5)

      yield* monitor.setSpilloverRatio(0.25)
      const after = yield* monitor.preTurn(mkInput(2))
      expect(after.computation.spillover.ratio).toBe(0.25)

      // Auditable: the change is in the L1 tuning history with provenance.
      const history = yield* selfModel.tuningHistory()
      const entry = history.find((t) => t.parameter === SPILLOVER_RATIO_PARAM)
      expect(entry).toBeDefined()
      expect(entry!.from).toBe(0.5)
      expect(entry!.to).toBe(0.25)

      // Out-of-range tuning values clamp instead of corrupting the blend.
      yield* monitor.setSpilloverRatio(99)
      const clamped = yield* monitor.preTurn(mkInput(3))
      expect(clamped.computation.spillover.ratio).toBe(1)
      expect(inBounds(clamped.dials)).toBe(true)
    }).pipe(Effect.provide(freshMonitorStack())))
})

describe("seam S7 structural: no direct dial-set path exists", () => {
  const engineDir = dirname(fileURLToPath(import.meta.url))
  const sources = () =>
    readdirSync(engineDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => ({ file: f, src: readFileSync(join(engineDir, f), "utf8") }))
  // Strip comments: doc prose may *discuss* the absent setter ("there is no
  // DialsSetDirectly event"); the structural guarantee is about code.
  const codeOf = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1")

  it("only asc-self-monitor.ts invokes DialState.applyPipelineDials", () => {
    const callers = sources()
      .filter(
        ({ file, src }) =>
          file !== "asc-self-monitor.ts" &&
          file !== "dial-state.ts" &&
          !file.endsWith(".test.ts") &&
          file !== "test-layers.ts" &&
          codeOf(src).includes("applyPipelineDials("),
      )
      .map(({ file }) => file)
    expect(callers).toEqual([])
  })

  it("no DialsSetDirectly event is constructed anywhere in the module", () => {
    const hits = sources()
      .filter(
        ({ file, src }) =>
          !file.endsWith(".test.ts") && /["'`]DialsSetDirectly["'`]/.test(codeOf(src)),
      )
      .map(({ file }) => file)
    expect(hits).toEqual([])
  })

  it("dial-state.ts exports no setter and the write path is named for the pipeline", () => {
    const dialState = sources().find(({ file }) => file === "dial-state.ts")!
    const code = codeOf(dialState.src)
    expect(code).not.toMatch(/export\s+(const|function|class)\s+setDials/)
    expect(code).toContain("applyPipelineDials")
    // The frozen boundary (engine.ts) cannot reach the write path at all.
    const engine = sources().find(({ file }) => file === "engine.ts")!
    expect(codeOf(engine.src)).not.toContain("applyPipelineDials(")
  })
})

describe("defaultDialComputation (paper §III.D dial-shift table)", () => {
  const baseRequest = (overrides: {
    cues?: { personal: number; playful: number; urgent: number; uncertain: number }
    isMetaQuestion?: boolean
    /** null = unknown domain (no capability entry). */
    capability?: { confidence: number; sampleCount: number } | null
    stake?: number
  } = {}) => ({
    content: {
      domain: "general",
      urgency: 0,
      costOfError: 0,
      cues: overrides.cues ?? { personal: 0, playful: 0, urgent: 0, uncertain: 0 },
      isMetaQuestion: overrides.isMetaQuestion ?? false,
    },
    selfModel: {
      capability:
        overrides.capability === null
          ? undefined
          : (overrides.capability ?? { confidence: 8, sampleCount: 10 }),
      guardFireRate: 0,
    },
    context: { proxyEvidence: [], stake: overrides.stake ?? 0 },
  })

  it("routine content with a confident self-model stays neutral", () => {
    const out = defaultDialComputation(baseRequest())
    // vulnerability = 5 - 2*(8/10) = 3.4: known confidence lowers V (routine,
    // well-trodden, confident -> low vulnerability per the dial table).
    expect(out).toEqual({ warmth: 5, playfulness: 5, intensity: 5, vulnerability: 3.4 })
  })

  it("meta questions push vulnerability up (warmth up, playfulness down)", () => {
    const plain = defaultDialComputation(baseRequest())
    const meta = defaultDialComputation(baseRequest({ isMetaQuestion: true }))
    expect(meta.vulnerability).toBeCloseTo(
      plain.vulnerability + META_QUESTION_SHIFT.vulnerability,
      10,
    )
    expect(meta.warmth).toBeCloseTo(plain.warmth + META_QUESTION_SHIFT.warmth, 10)
    expect(meta.playfulness).toBeCloseTo(plain.playfulness + META_QUESTION_SHIFT.playfulness, 10)
    expect(meta.vulnerability).toBeGreaterThan(plain.vulnerability)
  })

  it("crisis/debugging (high urgent cue) pushes intensity up, playfulness down", () => {
    const calm = defaultDialComputation(baseRequest())
    const crisis = defaultDialComputation(
      baseRequest({ cues: { personal: 0, playful: 0, urgent: 1, uncertain: 0 } }),
    )
    expect(crisis.intensity).toBeGreaterThan(calm.intensity)
    expect(crisis.playfulness).toBeLessThan(calm.playfulness)
  })

  it("personal content pushes vulnerability up", () => {
    const impersonal = defaultDialComputation(baseRequest())
    const personal = defaultDialComputation(
      baseRequest({ cues: { personal: 1, playful: 0, urgent: 0, uncertain: 0 } }),
    )
    expect(personal.vulnerability).toBeGreaterThan(impersonal.vulnerability)
    expect(personal.warmth).toBeGreaterThan(impersonal.warmth)
  })

  it("unknown domain reads as maximal uncertainty: vulnerability pushed up", () => {
    const known = defaultDialComputation(baseRequest())
    const unknown = defaultDialComputation(baseRequest({ capability: null }))
    // confidenceNorm 0 instead of 0.8 -> -2*0 vs -2*0.8: V rises by 1.6.
    expect(unknown.vulnerability).toBeCloseTo(known.vulnerability + 1.6, 10)
  })

  it("never requires a model: pure function of the request", () => {
    const out = defaultDialComputation(baseRequest())
    for (const d of DIAL_NAMES) {
      expect(out[d]).toBeGreaterThanOrEqual(0)
      expect(out[d]).toBeLessThanOrEqual(10)
      expect(Number.isFinite(out[d])).toBe(true)
    }
  })
})
