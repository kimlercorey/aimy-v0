/**
 * learning/curator.ts — the skill-library curator (M6 Track 2).
 *
 * Two halves, kept strictly separate (architecture §3.8):
 *
 * 1. DETERMINISTIC TRANSITIONS (automatic, pure code, NO LLM):
 *    active → stale (N days unused) → archived (M days). NEVER delete, only
 *    archive. Pinned and cron-referenced skills bypass. Thresholds are
 *    config; transitions are pure functions (`planTransitions`) so they can
 *    be tested without clocks or layers. Every transition carries its
 *    evidence: the deterministic rule evaluation (timestamps + thresholds).
 *
 * 2. LLM CONSOLIDATION (proposes only): an opt-in fork may PROPOSE
 *    class-level umbrellas absorbing overlapping skills. A proposal is
 *    ADOPTED only when the evidence gate verifies absorption — the
 *    `VerifiedReport` brand IS the proof: the arm ran the umbrella against
 *    the union of the absorbed skills' covered cases (Hermes #29912: a
 *    curator pass archived 10 active skills on model assertion alone —
 *    fail-open; we require verified absorption). `adoptConsolidation`
 *    cannot be called without a `VerifiedReport`: unverified consolidation
 *    is a type error. Cron references are rewritten to follow verified
 *    consolidations; dry-run report mode exists.
 *
 * Rejections are recorded in the honesty ledger, never silent.
 */
import { Clock, Context, Data, Effect, Layer } from "effect"

import { HonestyService, type HonestyError } from "../../honesty/src/index.js"
import type { CandidateSkill } from "./types.js"
import type { VerifiedReport } from "./arm.js"

export class CuratorError extends Data.TaggedError("CuratorError")<{
  readonly reason: string
}> {}

export type SkillLifecycle = "active" | "stale" | "archived"

export interface SkillEntry {
  readonly skillId: string
  readonly name: string
  readonly lifecycle: SkillLifecycle
  readonly lastUsedAt: string // ISO timestamp
  readonly pinned: boolean
  readonly cronJobIds: ReadonlyArray<string>
}

export interface CuratorConfigShape {
  /** Days of disuse before active → stale. */
  readonly staleAfterDays: number
  /** Days of disuse before stale → archived. */
  readonly archiveAfterDays: number
}

export class CuratorConfig extends Context.Service<CuratorConfig, CuratorConfigShape>()(
  "aimy/learning/CuratorConfig",
) {}

export const CuratorConfigLive = (config: CuratorConfigShape): Layer.Layer<CuratorConfig> =>
  Layer.succeed(CuratorConfig, config)

/** Evidence carried by every transition — the deterministic rule evaluation. */
export interface TransitionEvidence {
  readonly rule: "inactivity/active->stale" | "inactivity/stale->archived" | "consolidation/absorbed"
  readonly lastUsedAt: string
  readonly evaluatedAt: string
  readonly thresholds: { readonly staleAfterDays: number; readonly archiveAfterDays: number }
  /** Verification report id for consolidation transitions; undefined for inactivity. */
  readonly reportId: string | undefined
}

export interface LifecycleTransition {
  readonly skillId: string
  readonly from: SkillLifecycle
  readonly to: SkillLifecycle
  readonly reason: string
  readonly evidence: TransitionEvidence
}

const DAY_MS = 86_400_000

const unusedDays = (lastUsedAt: string, nowMs: number): number =>
  Math.max(0, Math.floor((nowMs - Date.parse(lastUsedAt)) / DAY_MS))

/**
 * Pure deterministic lifecycle planner. No LLM, no clock, no I/O —
 * the inactivity half of the curator as a testable function.
 *
 * Rules:
 * - pinned or cron-referenced skills bypass (never transitioned);
 * - active → stale at >= staleAfterDays unused;
 * - stale → archived at >= archiveAfterDays unused;
 * - archived is terminal; NOTHING transitions to deleted — the function
 *   cannot express deletion, so archive-only is structural.
 */
export const planTransitions = (
  entries: ReadonlyArray<SkillEntry>,
  nowMs: number,
  config: CuratorConfigShape,
): ReadonlyArray<LifecycleTransition> => {
  const evaluatedAt = new Date(nowMs).toISOString()
  const transitions: Array<LifecycleTransition> = []
  for (const entry of entries) {
    if (entry.pinned || entry.cronJobIds.length > 0) continue // bypass
    const days = unusedDays(entry.lastUsedAt, nowMs)
    const evidence = {
      lastUsedAt: entry.lastUsedAt,
      evaluatedAt,
      thresholds: { staleAfterDays: config.staleAfterDays, archiveAfterDays: config.archiveAfterDays },
      reportId: undefined as string | undefined,
    }
    if (entry.lifecycle === "active" && days >= config.staleAfterDays) {
      transitions.push({
        skillId: entry.skillId,
        from: "active",
        to: "stale",
        reason: `unused ${days}d >= staleAfterDays=${config.staleAfterDays}`,
        evidence: { ...evidence, rule: "inactivity/active->stale" },
      })
    } else if (entry.lifecycle === "stale" && days >= config.archiveAfterDays) {
      transitions.push({
        skillId: entry.skillId,
        from: "stale",
        to: "archived",
        reason: `unused ${days}d >= archiveAfterDays=${config.archiveAfterDays}`,
        evidence: { ...evidence, rule: "inactivity/stale->archived" },
      })
    }
  }
  return transitions
}

/** Apply planned transitions to entries (pure). */
export const applyTransitions = (
  entries: ReadonlyArray<SkillEntry>,
  transitions: ReadonlyArray<LifecycleTransition>,
): ReadonlyArray<SkillEntry> => {
  const byId = new Map(transitions.map((t) => [t.skillId, t]))
  return entries.map((e) => {
    const t = byId.get(e.skillId)
    return t ? { ...e, lifecycle: t.to } : e
  })
}

// ---------------------------------------------------------------------------
// Consolidation: LLM proposes, evidence gate disposes.
// ---------------------------------------------------------------------------

export interface UmbrellaProposal {
  readonly proposalId: string
  /** The proposed umbrella skill. Must have cleared quarantine → arm → gate; its `VerifiedReport` proves absorption. */
  readonly umbrella: CandidateSkill
  /** Skill ids the umbrella absorbs (archived on adoption). */
  readonly absorbs: ReadonlyArray<string>
  readonly proposedBy: string // lane that proposed
  readonly at: string // ISO timestamp
}

export interface CronRef {
  readonly jobId: string
  readonly skillId: string
}

export interface CronRewrite {
  readonly jobId: string
  readonly fromSkillId: string
  readonly toSkillId: string
}

export interface ConsolidationOutcome {
  readonly proposalId: string
  readonly adopted: boolean
  readonly umbrellaSkillId: string
  readonly archivedSkillIds: ReadonlyArray<string>
  readonly cronRewrites: ReadonlyArray<CronRewrite>
  readonly reportId: string
}

export interface CuratorReport {
  readonly at: string
  readonly dryRun: boolean
  readonly transitions: ReadonlyArray<LifecycleTransition>
  /** Entries after applying (dryRun: what WOULD result — inputs untouched). */
  readonly resulting: ReadonlyArray<SkillEntry>
}

export interface CuratorShape {
  /** Plan deterministic transitions for the given entries (uses Clock + config). */
  readonly plan: (
    entries: ReadonlyArray<SkillEntry>,
  ) => Effect.Effect<ReadonlyArray<LifecycleTransition>>
  /** Dry-run report mode: what would happen, nothing applied. */
  readonly dryRun: (entries: ReadonlyArray<SkillEntry>) => Effect.Effect<CuratorReport>
  /** Apply deterministic transitions; returns updated entries + report. */
  readonly run: (
    entries: ReadonlyArray<SkillEntry>,
  ) => Effect.Effect<{ readonly entries: ReadonlyArray<SkillEntry>; readonly report: CuratorReport }>
  /**
   * Adopt an umbrella consolidation. Requires the umbrella's
   * `VerifiedReport` — proof the arm demonstrated the absorbed skills'
   * covered cases against the umbrella (Hermes #29912). Without the brand,
   * adoption is a type error: the curator can never archive on model
   * assertion alone.
   */
  readonly adoptConsolidation: (
    entries: ReadonlyArray<SkillEntry>,
    cronRefs: ReadonlyArray<CronRef>,
    proposal: UmbrellaProposal,
    verified: VerifiedReport,
  ) => Effect.Effect<
    {
      readonly entries: ReadonlyArray<SkillEntry>
      readonly cronRefs: ReadonlyArray<CronRef>
      readonly outcome: ConsolidationOutcome
    },
    CuratorError | HonestyError
  >
}

export class Curator extends Context.Service<Curator, CuratorShape>()("aimy/learning/Curator") {}

export const CuratorLive: Layer.Layer<Curator, never, CuratorConfig | HonestyService> = Layer.effect(
  Curator,
  Effect.gen(function* () {
    const config = yield* CuratorConfig
    const honesty = yield* HonestyService

    const recordRejection = (proposalId: string, reason: string) =>
      honesty
        .recordClaim({
          sessionId: "learning",
          turnId: `curator:${proposalId}`,
          text: `curator REJECTED consolidation ${proposalId}: ${reason}`,
          kind: "task-result",
        })
        .pipe(Effect.asVoid)

    const plan: CuratorShape["plan"] = (entries) =>
      Effect.map(Clock.currentTimeMillis, (nowMs) => planTransitions(entries, nowMs, config))

    const dryRun: CuratorShape["dryRun"] = (entries) =>
      Effect.gen(function* () {
        const at = yield* Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
        const transitions = yield* plan(entries)
        return { at, dryRun: true, transitions, resulting: applyTransitions(entries, transitions) }
      })

    const run: CuratorShape["run"] = (entries) =>
      Effect.gen(function* () {
        const report = yield* dryRun(entries)
        return {
          entries: applyTransitions(entries, report.transitions),
          report: { ...report, dryRun: false },
        }
      })

    const adoptConsolidation: CuratorShape["adoptConsolidation"] = (entries, cronRefs, proposal, verified) =>
      Effect.gen(function* () {
        const at = yield* Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
        // The report must be FOR this umbrella: the absorption proof is
        // specific to the verified candidate.
        if (verified.skillId !== proposal.umbrella.skillId) {
          const reason = `report ${verified.reportId} verifies ${verified.skillId}, not umbrella ${proposal.umbrella.skillId}`
          yield* recordRejection(proposal.proposalId, reason)
          return yield* Effect.fail(new CuratorError({ reason }))
        }
        const byId = new Map(entries.map((e) => [e.skillId, e]))
        for (const id of proposal.absorbs) {
          const entry = byId.get(id)
          if (!entry) {
            const reason = `absorbed skill ${id} not in library`
            yield* recordRejection(proposal.proposalId, reason)
            return yield* Effect.fail(new CuratorError({ reason }))
          }
          if (entry.pinned) {
            const reason = `absorbed skill ${id} is pinned and cannot be absorbed`
            yield* recordRejection(proposal.proposalId, reason)
            return yield* Effect.fail(new CuratorError({ reason }))
          }
        }
        const absorbed = new Set(proposal.absorbs)
        const nextEntries: Array<SkillEntry> = entries.map((e) =>
          absorbed.has(e.skillId) && e.lifecycle !== "archived" ? { ...e, lifecycle: "archived" as const } : e,
        )
        // The verified umbrella enters the library as active (it cleared the
        // evidence gate to earn its VerifiedReport).
        if (!byId.has(proposal.umbrella.skillId)) {
          nextEntries.push({
            skillId: proposal.umbrella.skillId,
            name: proposal.umbrella.name,
            lifecycle: "active",
            lastUsedAt: at,
            pinned: false,
            cronJobIds: [],
          })
        }
        const cronRewrites: Array<CronRewrite> = []
        const nextCronRefs = cronRefs.map((ref) => {
          if (absorbed.has(ref.skillId)) {
            cronRewrites.push({ jobId: ref.jobId, fromSkillId: ref.skillId, toSkillId: proposal.umbrella.skillId })
            return { ...ref, skillId: proposal.umbrella.skillId }
          }
          return ref
        })
        const claim = yield* honesty.recordClaim({
          sessionId: "learning",
          turnId: `curator:${proposal.proposalId}`,
          text: `curator ADOPTED consolidation ${proposal.proposalId}: umbrella ${proposal.umbrella.skillId} absorbed ${proposal.absorbs.length} skills (report ${verified.reportId})`,
          kind: "task-result",
        })
        yield* honesty.attachEvidence(claim.claimId, {
          kind: "source",
          ref: `verification-report:${verified.reportId}`,
          summary: `verified absorption proof for umbrella ${proposal.umbrella.skillId}`,
        })
        return {
          entries: nextEntries,
          cronRefs: nextCronRefs,
          outcome: {
            proposalId: proposal.proposalId,
            adopted: true,
            umbrellaSkillId: proposal.umbrella.skillId,
            archivedSkillIds: [...proposal.absorbs],
            cronRewrites,
            reportId: verified.reportId,
          } satisfies ConsolidationOutcome,
        }
      })

    return Curator.of({ plan, dryRun, run, adoptConsolidation })
  }),
)
