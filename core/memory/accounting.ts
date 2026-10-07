/**
 * accounting.ts — cumulative context-budget accounting (Track A, M9).
 *
 * Architecture §3.9 / Pi #9409: sessions wedge at the context ceiling because
 * estimateTokens() can't see reasoning tokens and compaction never fires. This
 * module makes the budget a first-class, cumulative ledger:
 *
 *   - every turn's TokenUsage is recorded with its provenance (reported vs
 *     estimated) — the estimate NEVER travels unlabeled;
 *   - pressure levels (ok / elevated / critical) are surfaced via a report,
 *     never silently;
 *   - shouldCompact() fires at the configured threshold, and the Pi #9409
 *     guarantee is structural: when ANY recorded usage has estimated
 *     reasoning tokens, the trigger threshold TIGHTENS automatically and the
 *     report says so;
 *   - cumulative totals are monotonic — a decrease is a typed error that
 *     catches accounting bugs instead of letting the budget lie;
 *   - usage that is entirely unmeasurable fails LOUD (typed error), never
 *     proceeds silently.
 *
 * Pure core: no I/O, no services. Builds on compaction.ts (TokenUsage,
 * accountUsage) without touching it.
 */
import { Data, Effect } from "effect"
import { TokenUsage, accountUsage } from "./compaction.js"

/** Re-exported so budget consumers get usage + accounting from one module. */
export type { TokenUsage } from "./compaction.js"

/** Cumulative totals moved backwards — an accounting bug, surfaced loudly. */
export class NonMonotonicLedger extends Data.TaggedError("NonMonotonicLedger")<{
  readonly sessionId: string
  readonly field: "promptTokens" | "completionTokens" | "reasoningTokens"
  readonly previous: number
  readonly attempted: number
}> {}

/** The provider reported nothing and no transcript text was available to
 *  estimate from — usage is entirely unmeasurable. Fail loud, never guess. */
export class UnmeasurableUsage extends Data.TaggedError("UnmeasurableUsage")<{
  readonly sessionId: string
  readonly reason: string
}> {}

export type AccountingError = NonMonotonicLedger | UnmeasurableUsage

/** Honest label for how a ledger entry's numbers were obtained. */
export type UsageProvenance = "reported" | "estimated-reasoning"

export interface LedgerEntry {
  readonly turn: number
  readonly usage: TokenUsage
  readonly provenance: UsageProvenance
}

export interface BudgetConfig {
  readonly budgetTokens: number
  /** Fire compaction at this fraction of budget. Default 0.80. */
  readonly compactAt: number
  /** elevated pressure at this fraction. Default 0.70. */
  readonly elevatedAt: number
  /** critical pressure at this fraction. Default 0.90. */
  readonly criticalAt: number
  /**
   * Tightened trigger when reasoning tokens are estimated, not reported.
   * Default 0.70 — the Pi #9409 guarantee: an estimated budget must fire
   * EARLIER, because the estimate is known-conservative and the real usage
   * may be higher.
   */
  readonly estimatedCompactAt: number
}

export const defaultBudgetConfig = (budgetTokens: number): BudgetConfig => ({
  budgetTokens,
  compactAt: 0.8,
  elevatedAt: 0.7,
  criticalAt: 0.9,
  estimatedCompactAt: 0.7,
})

export interface ContextBudget {
  readonly sessionId: string
  readonly config: BudgetConfig
  readonly ledger: ReadonlyArray<LedgerEntry>
  /** Cumulative totals across all recorded turns. Never decreases. */
  readonly totals: TokenUsage
  /**
   * Cumulative tokens freed by compaction. The ledger stays append-only
   * (audit trail of what was spent); pressure is computed on
   * totals − relieved. Never decreases; never exceeds totals.
   */
  readonly relieved: TokenUsage
}

const zeroTotals = (): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  estimatedReasoning: false,
})

/** Total context tokens consumed by a usage record: prompt + completion + reasoning. */
export const totalTokens = (usage: TokenUsage): number =>
  usage.promptTokens + usage.completionTokens + usage.reasoningTokens

export const createBudget = (sessionId: string, budgetTokens: number, config?: Partial<BudgetConfig>): ContextBudget => ({
  sessionId,
  config: { ...defaultBudgetConfig(budgetTokens), ...config },
  ledger: [],
  totals: zeroTotals(),
  relieved: zeroTotals(),
})

/**
 * Effective live-context usage: what was spent minus what compaction freed.
 * Clamped at zero per field (defensive — applyRelief already prevents
 * over-relief, but the report must never show negative pressure).
 */
export const effectiveUsage = (budget: ContextBudget): TokenUsage => ({
  promptTokens: Math.max(0, budget.totals.promptTokens - budget.relieved.promptTokens),
  completionTokens: Math.max(0, budget.totals.completionTokens - budget.relieved.completionTokens),
  reasoningTokens: Math.max(0, budget.totals.reasoningTokens - budget.relieved.reasoningTokens),
  estimatedReasoning: budget.totals.estimatedReasoning,
})

/**
 * Record compaction relief: the summarized window's tokens leave the live
 * context. The ledger is untouched (it records what was spent); `relieved`
 * accumulates what compaction freed. Relieving more than was spent is a
 * typed error — it means a window was double-counted.
 */
export const applyRelief = (
  budget: ContextBudget,
  freed: TokenUsage,
): Effect.Effect<ContextBudget, NonMonotonicLedger> =>
  Effect.gen(function* () {
    for (const field of FIELDS) {
      const value = freed[field]
      if (!Number.isFinite(value) || value < 0) {
        return yield* Effect.fail(
          new NonMonotonicLedger({
            sessionId: budget.sessionId,
            field,
            previous: budget.relieved[field],
            attempted: budget.relieved[field] + value,
          }),
        )
      }
      if (budget.relieved[field] + value > budget.totals[field]) {
        return yield* Effect.fail(
          new NonMonotonicLedger({
            sessionId: budget.sessionId,
            field,
            previous: budget.relieved[field],
            attempted: budget.relieved[field] + value,
          }),
        )
      }
    }
    return {
      ...budget,
      relieved: {
        promptTokens: budget.relieved.promptTokens + freed.promptTokens,
        completionTokens: budget.relieved.completionTokens + freed.completionTokens,
        reasoningTokens: budget.relieved.reasoningTokens + freed.reasoningTokens,
        estimatedReasoning: budget.relieved.estimatedReasoning,
      },
    }
  })

const FIELDS = ["promptTokens", "completionTokens", "reasoningTokens"] as const

/**
 * Pure append of one turn's usage to the ledger. Monotonicity enforced:
 * every cumulative field must not decrease — a decrease is a typed error
 * (catches negative/buggy per-turn values before they corrupt the budget).
 */
export const recordTurn = (
  budget: ContextBudget,
  usage: TokenUsage,
  provenance: UsageProvenance,
): Effect.Effect<ContextBudget, NonMonotonicLedger> =>
  Effect.gen(function* () {
    for (const field of FIELDS) {
      const value = usage[field]
      if (!Number.isFinite(value) || value < 0) {
        return yield* Effect.fail(
          new NonMonotonicLedger({
            sessionId: budget.sessionId,
            field,
            previous: budget.totals[field],
            attempted: budget.totals[field] + value,
          }),
        )
      }
    }
    const totals: TokenUsage = {
      promptTokens: budget.totals.promptTokens + usage.promptTokens,
      completionTokens: budget.totals.completionTokens + usage.completionTokens,
      reasoningTokens: budget.totals.reasoningTokens + usage.reasoningTokens,
      estimatedReasoning: budget.totals.estimatedReasoning || usage.estimatedReasoning,
    }
    // defensive: the invariant is cumulative totals never decrease, checked
    // explicitly even though non-negative inputs make it hold by construction.
    for (const field of FIELDS) {
      if (totals[field] < budget.totals[field]) {
        return yield* Effect.fail(
          new NonMonotonicLedger({
            sessionId: budget.sessionId,
            field,
            previous: budget.totals[field],
            attempted: totals[field],
          }),
        )
      }
    }
    const entry: LedgerEntry = { turn: budget.ledger.length + 1, usage, provenance }
    return { ...budget, ledger: [...budget.ledger, entry], totals }
  })

/**
 * Cross-provider usage shapes, each labeled honestly:
 *   - full report (prompt/completion/reasoning) → "reported";
 *   - reasoning missing → conservative estimate (compaction.ts ratio), labeled
 *     "estimated-reasoning" with estimatedReasoning: true;
 *   - nothing reported at all → fail LOUD (UnmeasurableUsage), unless
 *     transcript text is supplied for a labeled estimate.
 */
export const usageFromProviderReport = (
  budget: ContextBudget,
  report: {
    readonly promptTokens?: number
    readonly completionTokens?: number
    readonly reasoningTokens?: number
  } | null,
  fallbackText?: { readonly promptText: string; readonly completionText: string },
): Effect.Effect<ContextBudget, AccountingError> =>
  Effect.gen(function* () {
    if (report === null) {
      if (fallbackText === undefined) {
        return yield* Effect.fail(
          new UnmeasurableUsage({
            sessionId: budget.sessionId,
            reason:
              "provider reported no usage and no transcript text was supplied — " +
              "recording an unmeasurable turn would silently corrupt the budget",
          }),
        )
      }
      const usage = accountUsage({
        promptText: fallbackText.promptText,
        completionText: fallbackText.completionText,
      })
      return yield* recordTurn(budget, usage, "estimated-reasoning")
    }
    const promptTokens = report.promptTokens ?? 0
    const completionTokens = report.completionTokens ?? 0
    const reported = report.reasoningTokens
    // estimatedReasoning: true and labeled "estimated-reasoning" below —
    // the estimate never travels unlabeled (Pi #9409).
    const usage: TokenUsage =
      reported === undefined
        ? { promptTokens, completionTokens, reasoningTokens: completionTokens * 2, estimatedReasoning: true }
        : { promptTokens, completionTokens, reasoningTokens: reported, estimatedReasoning: false }
    const provenance: UsageProvenance = reported === undefined ? "estimated-reasoning" : "reported"
    return yield* recordTurn(budget, usage, provenance)
  })

export type PressureLevel = "ok" | "elevated" | "critical"

export interface PressureReport {
  readonly level: PressureLevel
  readonly usedTokens: number
  readonly budgetTokens: number
  readonly ratio: number
  /** The threshold that will actually fire compaction. */
  readonly compactThreshold: number
  /**
   * True when the threshold was tightened because reasoning tokens were
   * estimated — the Pi #9409 guarantee, stated in the report, never silent.
   */
  readonly thresholdTightened: boolean
  readonly reasoningEstimated: boolean
  readonly notes: ReadonlyArray<string>
}

/**
 * Pressure report for a budget — never silent. The threshold-tightening
 * decision and its reason are part of the report, not hidden behavior.
 */
export const pressureReport = (budget: ContextBudget): PressureReport => {
  const usedTokens = totalTokens(effectiveUsage(budget))
  const ratio = budget.config.budgetTokens === 0 ? 0 : usedTokens / budget.config.budgetTokens
  const reasoningEstimated = budget.ledger.some((e) => e.usage.estimatedReasoning)
  const thresholdTightened = reasoningEstimated
  const compactThreshold = thresholdTightened ? budget.config.estimatedCompactAt : budget.config.compactAt
  const level: PressureLevel =
    ratio >= budget.config.criticalAt ? "critical" : ratio >= budget.config.elevatedAt ? "elevated" : "ok"
  const notes: string[] = []
  if (reasoningEstimated) {
    notes.push(
      `reasoning tokens estimated, not reported (Pi #9409): compaction trigger tightened ` +
        `${String(budget.config.compactAt)} -> ${String(compactThreshold)}`,
    )
  }
  if (level === "critical") {
    notes.push(`context budget critical: ${String(Math.round(ratio * 100))}% of budget consumed`)
  }
  return {
    level,
    usedTokens,
    budgetTokens: budget.config.budgetTokens,
    ratio,
    compactThreshold,
    thresholdTightened,
    reasoningEstimated,
    notes,
  }
}

/**
 * Whether compaction should fire for this budget. Fires at the configured
 * threshold — tightened automatically when reasoning tokens are estimated
 * (the Pi #9409 guarantee: a session must never wedge at the ceiling with
 * compaction never firing because the budget couldn't see reasoning tokens).
 */
export const shouldCompact = (budget: ContextBudget): boolean =>
  pressureReport(budget).ratio >= pressureReport(budget).compactThreshold
