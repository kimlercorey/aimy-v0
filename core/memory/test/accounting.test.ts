/**
 * accounting.test.ts — cumulative context-budget accounting (Track A, M9).
 *
 * Covers: pressure transitions at EXACT thresholds (ok/elevated/critical);
 * shouldCompact fires at the configured threshold; the Pi #9409 guarantee —
 * estimated reasoning tightens the trigger AND the report says so;
 * monotonicity violation -> typed error; unmeasurable usage -> loud failure;
 * cross-provider shapes (reported / estimated-reasoning / unmeasurable) each
 * labeled honestly.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  ContextBudget,
  NonMonotonicLedger,
  TokenUsage,
  UnmeasurableUsage,
  createBudget,
  pressureReport,
  recordTurn,
  shouldCompact,
  totalTokens,
  usageFromProviderReport,
} from "../accounting.js"

const usage = (prompt: number, completion: number, reasoning: number, estimated = false): TokenUsage => ({
  promptTokens: prompt,
  completionTokens: completion,
  reasoningTokens: reasoning,
  estimatedReasoning: estimated,
})

const runSync = <A, E>(eff: Effect.Effect<A, E>): A => Effect.runSync(eff)

describe("pressure transitions at exact thresholds", () => {
  it("ok below 70%, elevated at exactly 70%, critical at exactly 90%", () => {
    const at = (total: number): string => {
      const b = runSync(recordTurn(createBudget("s", 1000), usage(total, 0, 0), "reported"))
      return pressureReport(b).level
    }
    expect(at(699)).toBe("ok")
    expect(at(700)).toBe("elevated")
    expect(at(899)).toBe("elevated")
    expect(at(900)).toBe("critical")
    expect(at(1000)).toBe("critical")
  })

  it("report carries used/budget/ratio and never omits them", () => {
    const b = runSync(recordTurn(createBudget("s", 1000), usage(400, 200, 100), "reported"))
    const r = pressureReport(b)
    expect(r.usedTokens).toBe(700)
    expect(r.budgetTokens).toBe(1000)
    expect(r.ratio).toBeCloseTo(0.7, 10)
    expect(r.level).toBe("elevated")
  })
})

describe("shouldCompact fires at the configured threshold", () => {
  it("fires at exactly 80% with reported usage", () => {
    const b = runSync(recordTurn(createBudget("s", 1000), usage(800, 0, 0), "reported"))
    expect(shouldCompact(b)).toBe(true)
    expect(pressureReport(b).compactThreshold).toBe(0.8)
    expect(pressureReport(b).thresholdTightened).toBe(false)
  })

  it("does not fire below the threshold", () => {
    const b = runSync(recordTurn(createBudget("s", 1000), usage(799, 0, 0), "reported"))
    expect(shouldCompact(b)).toBe(false)
  })
})

describe("Pi #9409 guarantee: estimated reasoning tightens the trigger", () => {
  it("same usage, reported -> no fire, estimated -> fires", () => {
    const reported = runSync(recordTurn(createBudget("s", 1000), usage(500, 100, 150), "reported"))
    const estimated = runSync(recordTurn(createBudget("s", 1000), usage(500, 100, 150, true), "estimated-reasoning"))
    expect(totalTokens(reported.totals)).toBe(750)
    expect(totalTokens(estimated.totals)).toBe(750)
    expect(shouldCompact(reported)).toBe(false) // 75% < 80%
    expect(shouldCompact(estimated)).toBe(true) // 75% >= tightened 70%
  })

  it("the report says the threshold was tightened — never silent", () => {
    const b = runSync(recordTurn(createBudget("s", 1000), usage(500, 100, 150, true), "estimated-reasoning"))
    const r = pressureReport(b)
    expect(r.thresholdTightened).toBe(true)
    expect(r.reasoningEstimated).toBe(true)
    expect(r.compactThreshold).toBe(0.7)
    expect(r.notes.some((n) => n.includes("tightened"))).toBe(true)
    expect(r.notes.some((n) => n.includes("9409"))).toBe(true)
  })

  it("one estimated turn in a reported ledger still tightens", () => {
    let b: ContextBudget = createBudget("s", 1000)
    b = runSync(recordTurn(b, usage(400, 0, 0), "reported"))
    b = runSync(recordTurn(b, usage(300, 0, 50, true), "estimated-reasoning"))
    expect(shouldCompact(b)).toBe(true) // 750 >= 70%
    expect(pressureReport(b).thresholdTightened).toBe(true)
  })

  it("respects a custom tightened threshold", () => {
    const b = runSync(
      recordTurn(createBudget("s", 1000, { estimatedCompactAt: 0.6 }), usage(400, 100, 100, true), "estimated-reasoning"),
    )
    expect(shouldCompact(b)).toBe(true) // 600 >= custom 60%
    expect(pressureReport(b).compactThreshold).toBe(0.6)
  })
})

describe("monotonicity: cumulative totals never decrease", () => {
  it("negative per-turn usage is a typed error", () => {
    const err = runSync(Effect.flip(recordTurn(createBudget("s", 1000), usage(100, 50, -5), "reported")))
    expect(err).toBeInstanceOf(NonMonotonicLedger)
    expect(err._tag).toBe("NonMonotonicLedger")
    expect(err.sessionId).toBe("s")
    expect(err.field).toBe("reasoningTokens")
  })

  it("totals accumulate monotonically across turns", () => {
    let b: ContextBudget = createBudget("s", 1000)
    b = runSync(recordTurn(b, usage(100, 50, 25), "reported"))
    b = runSync(recordTurn(b, usage(200, 100, 50), "reported"))
    expect(b.totals.promptTokens).toBe(300)
    expect(b.totals.completionTokens).toBe(150)
    expect(b.totals.reasoningTokens).toBe(75)
    expect(b.ledger).toHaveLength(2)
    expect(b.ledger[0]?.turn).toBe(1)
    expect(b.ledger[1]?.turn).toBe(2)
  })
})

describe("unmeasurable usage fails loud", () => {
  it("no report and no text -> UnmeasurableUsage, never silent", () => {
    const err = runSync(Effect.flip(usageFromProviderReport(createBudget("s", 1000), null)))
    expect(err).toBeInstanceOf(UnmeasurableUsage)
    expect(err._tag).toBe("UnmeasurableUsage")
    expect(err.sessionId).toBe("s")
    if (err instanceof UnmeasurableUsage) {
      expect(err.reason.length).toBeGreaterThan(0)
    } else {
      expect.unreachable("expected UnmeasurableUsage")
    }
  })
})

describe("cross-provider shapes are labeled honestly", () => {
  it("full report -> reported, numbers untouched", () => {
    const b = runSync(
      usageFromProviderReport(createBudget("s", 1000), { promptTokens: 100, completionTokens: 50, reasoningTokens: 25 }),
    )
    expect(b.totals).toMatchObject({ promptTokens: 100, completionTokens: 50, reasoningTokens: 25, estimatedReasoning: false })
    expect(b.ledger[0]?.provenance).toBe("reported")
  })

  it("missing reasoning -> conservative estimate, labeled estimated-reasoning", () => {
    const b = runSync(usageFromProviderReport(createBudget("s", 1000), { promptTokens: 100, completionTokens: 50 }))
    expect(b.totals.reasoningTokens).toBe(100) // 2x completion, conservative
    expect(b.totals.estimatedReasoning).toBe(true)
    expect(b.ledger[0]?.provenance).toBe("estimated-reasoning")
    expect(b.ledger[0]?.usage.estimatedReasoning).toBe(true)
  })

  it("no report but transcript text -> labeled text estimate, not a silent guess", () => {
    const b = runSync(
      usageFromProviderReport(createBudget("s", 1000), null, {
        promptText: "p".repeat(400),
        completionText: "c".repeat(40),
      }),
    )
    expect(b.totals.promptTokens).toBe(100)
    expect(b.totals.completionTokens).toBe(10)
    expect(b.totals.estimatedReasoning).toBe(true)
    expect(b.ledger[0]?.provenance).toBe("estimated-reasoning")
  })
})
