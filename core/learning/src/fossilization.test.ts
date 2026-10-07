/**
 * fossilization.test.ts — the fossilization guard (Hermes #6051).
 *
 * Covers: structural failure classification, environment fingerprinting,
 * learning time-bounded versioned avoidances, expiry unenforcement, retest
 * lifting on success, renewal with fresh context on continued failure,
 * conservative renewal without a probe, sweep of expired rules, and timeline
 * recording of every intervention.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  classifyFailure,
  environmentFingerprint,
  FossilizationGuard,
  FossilizationGuardLive,
  InMemoryAvoidanceStore,
  ruleIdFor,
  type AvoidanceProbe,
  type FailureContext,
} from "./fossilization.js"
import { InMemoryTimelineStore, LearningTimeline, LearningTimelineLive, type Provenance } from "./timeline.js"
import { AvoidanceNotFound } from "./errors.js"

const prov: Provenance = { origin: "review-fork", sessionId: "sess-1", profileId: "default" }

const ctx = (overrides: Partial<FailureContext> = {}): FailureContext => ({
  whatFailed: "playwright launch",
  failureKind: "timeout",
  environmentFingerprint: "env-1",
  recordedAt: "2026-10-07T06:00:00.000Z",
  ...overrides,
})

const TimelineProvided = Layer.provide(LearningTimelineLive, InMemoryTimelineStore)

// `provideMerge` (not `provide`): the test layer must retain LearningTimeline
// alongside the guard so tests read the same store the guard writes to.
const GuardTestLayer = Layer.provideMerge(
  FossilizationGuardLive,
  Layer.mergeAll(TimelineProvided, InMemoryAvoidanceStore),
)

const withGuard = <A, E>(
  eff: Effect.Effect<A, E, FossilizationGuard | LearningTimeline>,
): Effect.Effect<A, E, never> => Effect.provide(eff, GuardTestLayer)

const learn = (behavior = "tool.exec(playwright)", context: FailureContext = ctx()) =>
  Effect.gen(function* () {
    const guard = yield* FossilizationGuard
    return yield* guard.learnAvoidance({ behavior, reason: "flaky launch", context, provenance: prov })
  })

const worksProbe: AvoidanceProbe = () =>
  Effect.succeed({
    outcome: "works" as const,
    observedAt: "2026-10-07T08:00:00.000Z",
    summary: "playwright launched cleanly against current environment",
  })

const failsProbe: AvoidanceProbe = () =>
  Effect.succeed({
    outcome: "still-fails" as const,
    observedAt: "2026-10-07T08:00:00.000Z",
    summary: "playwright still times out",
    freshContext: ctx({ failureKind: "timeout", recordedAt: "2026-10-07T08:00:00.000Z", attempts: 2 }),
  })

describe("classifyFailure", () => {
  it("classifies environment weather as transient", () => {
    expect(classifyFailure(ctx({ failureKind: "timeout" }))).toBe("transient")
    expect(classifyFailure(ctx({ failureKind: "network-error" }))).toBe("transient")
    expect(classifyFailure(ctx({ failureKind: "resource-exhaustion" }))).toBe("transient")
    expect(classifyFailure(ctx({ failureKind: "exit-signal" }))).toBe("transient")
  })

  it("treats prior successes as transient (it worked before — the world regressed)", () => {
    expect(classifyFailure(ctx({ failureKind: "assertion-failure", priorSuccesses: 3 }))).toBe("transient")
  })

  it("treats policy denial as persistent", () => {
    expect(classifyFailure(ctx({ failureKind: "policy-denial" }))).toBe("persistent")
  })

  it("treats repeated assertion failures across environments as persistent", () => {
    expect(
      classifyFailure(ctx({ failureKind: "assertion-failure", consecutiveFailures: 5, distinctEnvironments: 2 })),
    ).toBe("persistent")
    expect(classifyFailure(ctx({ failureKind: "assertion-failure", consecutiveFailures: 1 }))).toBe("unknown")
    expect(
      classifyFailure(ctx({ failureKind: "assertion-failure", consecutiveFailures: 9, distinctEnvironments: 1 })),
    ).toBe("unknown")
  })

  it("is conservative on unknown failure kinds", () => {
    expect(classifyFailure(ctx({ failureKind: "weird-new-thing" }))).toBe("unknown")
  })
})

describe("environmentFingerprint", () => {
  it("is deterministic and changes when the environment changes", () => {
    const snap = { platform: "linux-x86_64", toolVersions: { playwright: "1.49.1" } }
    expect(environmentFingerprint(snap)).toBe(environmentFingerprint(snap))
    expect(environmentFingerprint({ ...snap, toolVersions: { playwright: "1.50.0" } })).not.toBe(
      environmentFingerprint(snap),
    )
  })
})

describe("ruleIdFor", () => {
  it("is deterministic over behavior, version, and timestamp", () => {
    expect(ruleIdFor("b", 1, "t")).toBe(ruleIdFor("b", 1, "t"))
    expect(ruleIdFor("b", 2, "t")).not.toBe(ruleIdFor("b", 1, "t"))
  })
})

describe("fossilization guard", () => {
  it.effect("learnAvoidance creates a time-bounded, versioned, contextual rule", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const rule = yield* learn()
        expect(rule.version).toBe(1)
        expect(rule.status).toBe("active")
        expect(rule.classification).toBe("transient")
        expect(rule.ruleId).toBe(ruleIdFor(rule.behavior, 1, rule.learnedAt))
        expect(Date.parse(rule.expiresAt)).toBeGreaterThan(Date.parse(rule.learnedAt))
        expect(Date.parse(rule.expiresAt) - Date.parse(rule.learnedAt)).toBe(6 * 60 * 60 * 1000)
        expect(rule.failureContext.whatFailed).toBe("playwright launch")
        // And the learning is a timeline node.
        const timeline = yield* LearningTimeline
        const learned = yield* timeline.query({ types: ["avoidance.learned"], subject: rule.behavior })
        expect(learned).toHaveLength(1)
        expect(learned[0]?.payload).toMatchObject({ ruleId: rule.ruleId, behavior: rule.behavior })
      }),
    ),
  )

  it.effect("learnAvoidance honors explicit classification and TTL overrides", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const rule = yield* guard.learnAvoidance({
          behavior: "tool.exec(rm)",
          reason: "policy",
          context: ctx({ failureKind: "policy-denial" }),
          classification: "persistent",
          ttlMs: 1000,
          provenance: prov,
        })
        expect(rule.classification).toBe("persistent")
        expect(Date.parse(rule.expiresAt) - Date.parse(rule.learnedAt)).toBe(1000)
      }),
    ),
  )

  it.effect("isAvoided is true for active rules and false for unknown behaviors", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        yield* learn()
        expect(yield* guard.isAvoided("tool.exec(playwright)")).toBe(true)
        expect(yield* guard.isAvoided("tool.exec(curl)")).toBe(false)
      }),
    ),
  )

  it.effect("an expired avoidance is NOT enforced until retested (the anti-#6051 rule)", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const rule = yield* guard.learnAvoidance({
          behavior: "tool.exec(playwright)",
          reason: "flaky",
          context: ctx(),
          ttlMs: 0, // expires immediately
          provenance: prov,
        })
        expect(rule.status).toBe("active")
        expect(yield* guard.isAvoided("tool.exec(playwright)")).toBe(false)
      }),
    ),
  )

  it.effect("retest lifts the avoidance when the behavior works again, and records the intervention", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const timeline = yield* LearningTimeline
        const rule = yield* learn()
        yield* guard.registerProbe("tool.exec(playwright)", worksProbe)
        const lifted = yield* guard.retest(rule.ruleId)
        expect(lifted.status).toBe("lifted")
        expect(lifted.ruleId).toBe(rule.ruleId) // lift keeps the rule's identity
        expect(yield* guard.isAvoided("tool.exec(playwright)")).toBe(false)
        const interventions = yield* timeline.query({
          types: ["fossilization.intervention"],
          subject: "tool.exec(playwright)",
        })
        expect(interventions).toHaveLength(1)
        expect(interventions[0]?.payload).toMatchObject({
          ruleId: rule.ruleId,
          decision: "lifted",
          previousVersion: 1,
        })
      }),
    ),
  )

  it.effect("retest renews the avoidance with fresh context when it still fails", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const timeline = yield* LearningTimeline
        const rule = yield* learn()
        yield* guard.registerProbe("tool.exec(playwright)", failsProbe)
        const renewed = yield* guard.retest(rule.ruleId)
        expect(renewed.version).toBe(2)
        expect(renewed.status).toBe("active")
        expect(renewed.ruleId).not.toBe(rule.ruleId) // renewal is a NEW id, never a mutation
        expect(renewed.supersedes).toBe(rule.ruleId)
        expect(renewed.failureContext.attempts).toBe(2) // fresh context carried forward
        expect(renewed.failureContext.recordedAt).toBe("2026-10-07T08:00:00.000Z")
        expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(renewed.learnedAt))
        const old = (yield* guard.getRules("tool.exec(playwright)")).find((r) => r.ruleId === rule.ruleId)
        expect(old?.status).toBe("superseded")
        expect(yield* guard.isAvoided("tool.exec(playwright)")).toBe(true)
        const interventions = yield* timeline.query({
          types: ["fossilization.intervention"],
          subject: "tool.exec(playwright)",
        })
        expect(interventions[0]?.payload).toMatchObject({ decision: "renewed", newVersion: 2 })
      }),
    ),
  )

  it.effect("retest without a registered probe renews conservatively, never silently drops", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const timeline = yield* LearningTimeline
        const rule = yield* learn()
        const renewed = yield* guard.retest(rule.ruleId)
        expect(renewed.version).toBe(2)
        expect(renewed.status).toBe("active")
        expect(yield* guard.isAvoided("tool.exec(playwright)")).toBe(true)
        const interventions = yield* timeline.query({ types: ["fossilization.intervention"] })
        expect(String((interventions[0]?.payload as { probeSummary: string }).probeSummary)).toContain(
          "no probe registered",
        )
      }),
    ),
  )

  it.effect("retest fails typed for unknown rules and is a no-op for lifted rules", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const timeline = yield* LearningTimeline
        const missing = yield* Effect.flip(guard.retest("nope"))
        expect(missing).toBeInstanceOf(AvoidanceNotFound)
        const rule = yield* learn()
        yield* guard.registerProbe("tool.exec(playwright)", worksProbe)
        const lifted = yield* guard.retest(rule.ruleId)
        expect(lifted.status).toBe("lifted")
        const again = yield* guard.retest(rule.ruleId)
        expect(again.status).toBe("lifted")
        // The no-op retest recorded nothing new.
        expect(yield* timeline.query({ types: ["fossilization.intervention"] })).toHaveLength(1)
      }),
    ),
  )

  it.effect("sweepExpired retests every expired rule and skips the rest", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const expired = yield* guard.learnAvoidance({
          behavior: "tool.exec(playwright)",
          reason: "flaky",
          context: ctx(),
          ttlMs: 0,
          provenance: prov,
        })
        yield* guard.learnAvoidance({
          behavior: "tool.exec(curl)",
          reason: "also flaky",
          context: ctx({ whatFailed: "curl fetch" }),
          provenance: prov,
        })
        yield* guard.registerProbe("tool.exec(playwright)", worksProbe)
        const results = yield* guard.sweepExpired()
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          ruleId: expired.ruleId,
          behavior: "tool.exec(playwright)",
          decision: "lifted",
          version: 1,
        })
        expect(yield* guard.isAvoided("tool.exec(curl)")).toBe(true) // untouched
      }),
    ),
  )

  it.effect("sweepExpired renews (with prior context) when the expired rule has no probe", () =>
    withGuard(
      Effect.gen(function* () {
        const guard = yield* FossilizationGuard
        const expired = yield* guard.learnAvoidance({
          behavior: "tool.exec(playwright)",
          reason: "flaky",
          context: ctx(),
          ttlMs: 0,
          provenance: prov,
        })
        const results = yield* guard.sweepExpired()
        expect(results[0]?.decision).toBe("renewed")
        expect(results[0]?.version).toBe(2)
        expect(yield* guard.isAvoided("tool.exec(playwright)")).toBe(true)
        // The expired original stays expired-and-superseded; the new version enforces.
        const rules = yield* guard.getRules("tool.exec(playwright)")
        expect(rules.find((r) => r.ruleId === expired.ruleId)?.status).toBe("superseded")
      }),
    ),
  )
})
