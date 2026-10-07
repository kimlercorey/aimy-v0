/**
 * Track 2 — curator tests.
 *
 * Deterministic lifecycle transitions are pure code (no LLM):
 * active → stale → archived, never delete, pinned/cron-referenced bypass.
 * LLM consolidation PROPOSES only; adoption requires the evidence gate's
 * VerifiedReport proving absorption (Hermes #29912).
 */
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect } from "effect"

import {
  applyTransitions,
  Curator,
  CuratorError,
  planTransitions,
  type CronRef,
  type CuratorShape,
  type SkillEntry,
  type UmbrellaProposal,
} from "../src/curator.js"
import { HonestyService, type HonestyServiceShape } from "../../honesty/src/index.js"
import { makeCandidate, testCuratorConfig, testLayers, verifyPassing } from "./fixtures.js"
import type { VerificationArm } from "../src/arm.js"

const DAY_MS = 86_400_000

const entry = (overrides?: Partial<SkillEntry>): SkillEntry => ({
  skillId: "skill-a",
  name: "skill-a",
  lifecycle: "active",
  lastUsedAt: "2026-10-07T06:00:00.000Z",
  pinned: false,
  cronJobIds: [],
  ...overrides,
})

/** ISO timestamp N days before the TestClock now. */
const daysAgo = (nowMs: number, n: number): string => new Date(nowMs - n * DAY_MS).toISOString()

const withCurator = <A, E>(
  use: (
    curator: CuratorShape,
    honesty: HonestyServiceShape,
  ) => Effect.Effect<A, E, Curator | HonestyService | VerificationArm>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const curator = yield* Curator
    const honesty = yield* HonestyService
    return yield* use(curator, honesty)
  // testLayers() provides Curator, HonestyService, and VerificationArm
  // (via verifyPassing) — the cast bridges the generic R.
  }).pipe(Effect.provide(testLayers())) as Effect.Effect<A, E, never>

describe("curator deterministic lifecycle (pure)", () => {
  it.effect("active -> stale after N days unused, with evidence", () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      const transitions = planTransitions(
        [entry({ lastUsedAt: daysAgo(nowMs, 40) })],
        nowMs,
        testCuratorConfig,
      )
      expect(transitions.length).toBe(1)
      const t = transitions[0]!
      expect(t.from).toBe("active")
      expect(t.to).toBe("stale")
      expect(t.reason).toContain("40d")
      // Every transition carries its evidence report.
      expect(t.evidence.rule).toBe("inactivity/active->stale")
      expect(t.evidence.thresholds).toEqual({ staleAfterDays: 30, archiveAfterDays: 90 })
      expect(t.evidence.reportId).toBeUndefined()
    }),
  )

  it.effect("recently used skills do not transition", () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      expect(planTransitions([entry({ lastUsedAt: daysAgo(nowMs, 10) })], nowMs, testCuratorConfig)).toEqual([])
    }),
  )

  it.effect("stale -> archived after M days unused", () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      const transitions = planTransitions(
        [entry({ lifecycle: "stale", lastUsedAt: daysAgo(nowMs, 100) })],
        nowMs,
        testCuratorConfig,
      )
      expect(transitions.length).toBe(1)
      expect(transitions[0]!.to).toBe("archived")
      expect(transitions[0]!.evidence.rule).toBe("inactivity/stale->archived")
    }),
  )

  it.effect("long-unused active skills go stale first (one step per pass, never skip to archived)", () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      const transitions = planTransitions(
        [entry({ lifecycle: "active", lastUsedAt: daysAgo(nowMs, 500) })],
        nowMs,
        testCuratorConfig,
      )
      expect(transitions.length).toBe(1)
      expect(transitions[0]!.to).toBe("stale")
    }),
  )

  it.effect("pinned skills bypass the lifecycle", () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        planTransitions([entry({ pinned: true, lastUsedAt: daysAgo(nowMs, 500) })], nowMs, testCuratorConfig),
      ).toEqual([])
    }),
  )

  it.effect("cron-referenced skills bypass the lifecycle", () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        planTransitions(
          [entry({ cronJobIds: ["nightly-summarize"], lastUsedAt: daysAgo(nowMs, 500) })],
          nowMs,
          testCuratorConfig,
        ),
      ).toEqual([])
    }),
  )

  it.effect("archived is terminal: nothing transitions out, and nothing is ever deleted", () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      const transitions = planTransitions(
        [entry({ lifecycle: "archived", lastUsedAt: daysAgo(nowMs, 1000) })],
        nowMs,
        testCuratorConfig,
      )
      expect(transitions).toEqual([])
      // applyTransitions only rewrites lifecycle fields; entries are never removed.
      const entries = [entry({ skillId: "a" }), entry({ skillId: "b", lifecycle: "stale" })]
      const result = applyTransitions(entries, [
        {
          skillId: "b",
          from: "stale",
          to: "archived",
          reason: "test",
          evidence: {
            rule: "inactivity/stale->archived",
            lastUsedAt: entries[1]!.lastUsedAt,
            evaluatedAt: new Date(nowMs).toISOString(),
            thresholds: { staleAfterDays: 30, archiveAfterDays: 90 },
            reportId: undefined,
          },
        },
      ])
      expect(result.length).toBe(2)
      expect(result.map((e) => `${e.skillId}:${e.lifecycle}`)).toEqual(["a:active", "b:archived"])
    }),
  )
})

describe("curator service", () => {
  it.effect("dryRun reports without applying; run applies", () =>
    withCurator((curator) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        const entries = [entry({ lastUsedAt: daysAgo(nowMs, 40) })]
        const dry = yield* curator.dryRun(entries)
        expect(dry.dryRun).toBe(true)
        expect(dry.transitions.length).toBe(1)
        expect(dry.resulting[0]!.lifecycle).toBe("stale")
        // Input untouched by dryRun.
        expect(entries[0]!.lifecycle).toBe("active")
        const ran = yield* curator.run(entries)
        expect(ran.report.dryRun).toBe(false)
        expect(ran.entries[0]!.lifecycle).toBe("stale")
      }),
    ),
  )
})

describe("curator consolidation (LLM proposes, evidence disposes)", () => {
  const absorbedEntries: ReadonlyArray<SkillEntry> = [
    { skillId: "skill-old-1", name: "old-1", lifecycle: "active", lastUsedAt: "2026-09-01T00:00:00.000Z", pinned: false, cronJobIds: [] },
    { skillId: "skill-old-2", name: "old-2", lifecycle: "stale", lastUsedAt: "2026-08-01T00:00:00.000Z", pinned: false, cronJobIds: [] },
  ]
  const cronRefs: ReadonlyArray<CronRef> = [{ jobId: "nightly", skillId: "skill-old-1" }]

  const umbrellaProposal = (): UmbrellaProposal => ({
    proposalId: "prop-1",
    umbrella: makeCandidate({
      skillId: "skill-umbrella",
      name: "umbrella",
      behaviorCases: [{ caseId: "u1", description: "umbrella echo", input: { q: 1 }, expect: { echo: { q: 1 } } }],
    }),
    absorbs: ["skill-old-1", "skill-old-2"],
    proposedBy: "review-fork:fork-9",
    at: "2026-10-07T06:00:00.000Z",
  })

  it.effect("adoption archives absorbed skills, rewrites cron refs, carries the report", () =>
    withCurator((curator, honesty) =>
      Effect.gen(function* () {
        const proposal = umbrellaProposal()
        // The umbrella cleared quarantine -> arm -> gate: the VerifiedReport
        // proves the arm demonstrated the absorbed skills' covered cases
        // against it (Hermes #29912 — no absorption on assertion alone).
        const verified = yield* verifyPassing(proposal.umbrella)
        const { entries, cronRefs: nextRefs, outcome } = yield* curator.adoptConsolidation(
          absorbedEntries,
          cronRefs,
          proposal,
          verified,
        )
        expect(outcome.adopted).toBe(true)
        expect(outcome.reportId).toBe(verified.reportId)
        expect(outcome.archivedSkillIds).toEqual(["skill-old-1", "skill-old-2"])
        const byId = new Map(entries.map((e) => [e.skillId, e]))
        expect(byId.get("skill-old-1")!.lifecycle).toBe("archived")
        expect(byId.get("skill-old-2")!.lifecycle).toBe("archived")
        // The verified umbrella enters the library as active.
        expect(byId.get("skill-umbrella")!.lifecycle).toBe("active")
        // Cron references follow the verified consolidation.
        expect(outcome.cronRewrites).toEqual([
          { jobId: "nightly", fromSkillId: "skill-old-1", toSkillId: "skill-umbrella" },
        ])
        expect(nextRefs).toEqual([{ jobId: "nightly", skillId: "skill-umbrella" }])
        // The adoption is in the honesty ledger with the report as evidence.
        const claims = yield* honesty.claimsForTurn("learning", "curator:prop-1")
        expect(claims.length).toBe(1)
        expect(claims[0]!.claim.text).toContain("ADOPTED")
        const evidence = yield* honesty.evidenceFor(claims[0]!.claim.claimId)
        expect(evidence.some((e) => e.ref === `verification-report:${verified.reportId}`)).toBe(true)
      }),
    ),
  )

  it.effect("report/umbrella mismatch is rejected and recorded", () =>
    withCurator((curator, honesty) =>
      Effect.gen(function* () {
        const proposal = umbrellaProposal()
        const other = yield* verifyPassing(makeCandidate({ skillId: "skill-other" }))
        const err = yield* Effect.flip(curator.adoptConsolidation(absorbedEntries, cronRefs, proposal, other))
        expect(err).toBeInstanceOf(CuratorError)
        if (!(err instanceof CuratorError)) throw new Error("expected CuratorError")
        expect(err.reason).toContain("not umbrella")
        const claims = yield* honesty.claimsForTurn("learning", "curator:prop-1")
        expect(claims.length).toBe(1)
        expect(claims[0]!.claim.text).toContain("REJECTED")
      }),
    ),
  )

  it.effect("absorbing a pinned skill is rejected and recorded", () =>
    withCurator((curator) =>
      Effect.gen(function* () {
        const proposal = umbrellaProposal()
        const verified = yield* verifyPassing(proposal.umbrella)
        const withPinned = absorbedEntries.map((e) =>
          e.skillId === "skill-old-1" ? { ...e, pinned: true } : e,
        )
        const err = yield* Effect.flip(curator.adoptConsolidation(withPinned, cronRefs, proposal, verified))
        expect(err).toBeInstanceOf(CuratorError)
        if (!(err instanceof CuratorError)) throw new Error("expected CuratorError")
        expect(err.reason).toContain("pinned")
      }),
    ),
  )

  it.effect("absorbing an unknown skill is rejected and recorded", () =>
    withCurator((curator) =>
      Effect.gen(function* () {
        const proposal: UmbrellaProposal = { ...umbrellaProposal(), absorbs: ["skill-ghost"] }
        const verified = yield* verifyPassing(proposal.umbrella)
        const err = yield* Effect.flip(curator.adoptConsolidation(absorbedEntries, cronRefs, proposal, verified))
        expect(err).toBeInstanceOf(CuratorError)
        if (!(err instanceof CuratorError)) throw new Error("expected CuratorError")
        expect(err.reason).toContain("not in library")
      }),
    ),
  )
})
