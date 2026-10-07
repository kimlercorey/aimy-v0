/**
 * learning/fossilization.ts — the fossilization guard.
 *
 * Hermes #6051 ("learned helplessness"): a transient Playwright failure
 * fossilized into permanent tool avoidance. The guard's mechanism, per
 * architecture §2.7 and §3.5:
 *
 * - Avoidance rules learned from failures carry their failure CONTEXT (what
 *   failed, environment fingerprint, timestamp).
 * - Avoidances are time-bounded and versioned — never permanent.
 * - On expiry (or on demand) the guard re-tests the avoided behavior against
 *   CURRENT environment state: if it now works, the avoidance is LIFTED; if
 *   it still fails, the avoidance is RENEWED with fresh context as a new
 *   version (the old version is superseded, never mutated).
 * - Expired avoidances are NOT enforced while awaiting retest — an expired
 *   rule no longer reports `isAvoided`. A rule with no registered probe is
 *   renewed conservatively (fail-closed) rather than silently dropped, and
 *   the renewal is a timeline event either way.
 *
 * Transient vs persistent failures are distinguished structurally where
 * possible (`classifyFailure`); the guard never needs an LLM to decide.
 *
 * The guard's interventions are themselves timeline events
 * (`fossilization.intervention`), so the user sees exactly when an avoidance
 * was learned, lifted, or renewed and why.
 *
 * Lifecycle vs outcome records stay separate (Hermes #68499): an
 * `AvoidanceRule` is lifecycle state (active/lifted/superseded); each probe
 * run is an outcome record carried in the intervention event's payload.
 */
import { Clock, Context, Effect, Layer } from "effect"
import { canonicalJson, sha256Hex } from "../../honesty/judges/src/canonical.js"
import { AvoidanceNotFound, type LearningError } from "./errors.js"
import { LearningTimeline, type LearningEvent, type Provenance } from "./timeline.js"

// ─── Environment ─────────────────────────────────────────────────────────────

/**
 * The environment state an avoidance is bound to. The fingerprint is what
 * makes "re-run against CURRENT environment state" checkable: a different
 * fingerprint means the world changed and old evidence may not apply.
 */
export interface EnvironmentSnapshot {
  readonly platform: string // e.g. "darwin-arm64", "linux-x86_64"
  readonly toolVersions: Readonly<Record<string, string>> // e.g. { playwright: "1.49.1" }
  readonly extra?: unknown // JSON-serializable extras (GPU driver, sandbox backend, …)
}

/** Deterministic fingerprint of an environment snapshot. Throws on unserializable input (programming error). */
export const environmentFingerprint = (snapshot: EnvironmentSnapshot): string => {
  const canon = canonicalJson(snapshot)
  if (!canon.ok) throw new Error(`environmentFingerprint: snapshot not serializable: ${canon.reason}`)
  return sha256Hex(canon.json)
}

// ─── Failure context & classification ────────────────────────────────────────

export type FailureClassification = "transient" | "persistent" | "unknown"

/**
 * The failure context every avoidance rule carries. Well-known `failureKind`
 * values: "timeout" | "network-error" | "resource-exhaustion" | "exit-signal"
 * | "assertion-failure" | "policy-denial" | "not-found" | "auth-error".
 * Unknown kinds classify as "unknown" (conservative: short TTL).
 */
export interface FailureContext {
  readonly whatFailed: string
  readonly failureKind: string
  readonly environmentFingerprint: string
  readonly recordedAt: string // ISO timestamp
  readonly attempts?: number
  readonly priorSuccesses?: number
  readonly consecutiveFailures?: number
  readonly distinctEnvironments?: number
}

/**
 * Structural transient/persistent classification — no LLM involved.
 * - It worked before (`priorSuccesses > 0`) → transient: the environment
 *   regressed, or the failure is flaky.
 * - Timeout / network / resource-exhaustion / signals → transient: these are
 *   environment weather, not behavior truth.
 * - Policy denial → persistent: the rule is the behavior, not the weather.
 * - Assertion failures → persistent only with real evidence: ≥3 consecutive
 *   failures across ≥2 distinct environments. Otherwise unknown.
 */
export const classifyFailure = (ctx: FailureContext): FailureClassification => {
  if (ctx.priorSuccesses !== undefined && ctx.priorSuccesses > 0) return "transient"
  switch (ctx.failureKind) {
    case "timeout":
    case "network-error":
    case "resource-exhaustion":
    case "exit-signal":
      return "transient"
    case "policy-denial":
      return "persistent"
    case "assertion-failure":
      return (ctx.consecutiveFailures ?? 0) >= 3 && (ctx.distinctEnvironments ?? 0) >= 2
        ? "persistent"
        : "unknown"
    default:
      return "unknown"
  }
}

// ─── Avoidance rules ─────────────────────────────────────────────────────────

export type AvoidanceStatus = "active" | "lifted" | "superseded"

export interface AvoidanceRule {
  readonly ruleId: string // content-fingerprinted: behavior + version + recordedAt
  readonly behavior: string // the avoided behavior, e.g. "tool.exec(playwright)"
  readonly reason: string // human-readable why
  readonly failureContext: FailureContext
  readonly classification: FailureClassification
  readonly version: number
  readonly provenance: Provenance
  readonly learnedAt: string // ISO timestamp
  readonly expiresAt: string // ISO timestamp — the time bound
  readonly status: AvoidanceStatus
  readonly supersedes?: string
}

/** Deterministic rule id. A renewal is a NEW id (new version), never a mutation. */
export const ruleIdFor = (behavior: string, version: number, recordedAt: string): string =>
  sha256Hex(`avoidance\n${behavior}\nv${version}\n${recordedAt}`)

/** Default time bounds per classification. Transient failures are retested soon; persistent ones rarely. */
export const DEFAULT_TTL_MS: Readonly<Record<FailureClassification, number>> = {
  transient: 6 * 60 * 60 * 1000, // 6h
  persistent: 7 * 24 * 60 * 60 * 1000, // 7d
  unknown: 24 * 60 * 60 * 1000, // 24h
}

export interface LearnAvoidanceInput {
  readonly behavior: string
  readonly reason: string
  readonly context: FailureContext
  readonly classification?: FailureClassification // default: classifyFailure(context)
  readonly ttlMs?: number // default: DEFAULT_TTL_MS[classification]
  readonly provenance: Provenance
}

/** The outcome of re-testing an avoided behavior against current environment state. */
export interface ProbeOutcome {
  readonly outcome: "works" | "still-fails"
  readonly observedAt: string // ISO timestamp
  readonly summary: string
  /** Fresh failure context when it still fails; the guard renews the rule with this. */
  readonly freshContext?: FailureContext
}

/**
 * A probe re-tests the avoided behavior against CURRENT environment state.
 * Supplied by the caller (Track 2's verification arm will supply real probes);
 * the guard only orchestrates. Must be side-effect-light: probes run the
 * minimal check, not the full original workload.
 */
export type AvoidanceProbe = () => Effect.Effect<ProbeOutcome, LearningError>

export interface RetestResult {
  readonly ruleId: string
  readonly behavior: string
  readonly decision: "lifted" | "renewed"
  readonly version: number
}

// ─── Store seam ──────────────────────────────────────────────────────────────

export interface AvoidanceStoreShape {
  readonly getRule: (ruleId: string) => Effect.Effect<AvoidanceRule | undefined, LearningError>
  readonly putRule: (rule: AvoidanceRule) => Effect.Effect<void, LearningError>
  readonly listRules: () => Effect.Effect<ReadonlyArray<AvoidanceRule>, LearningError>
}

export class AvoidanceStore extends Context.Service<AvoidanceStore, AvoidanceStoreShape>()(
  "aimy/learning/AvoidanceStore",
) {}

const freezeCopy = <T>(value: T): T => Object.freeze(structuredClone(value)) as T

export const InMemoryAvoidanceStore: Layer.Layer<AvoidanceStore> = Layer.sync(AvoidanceStore, () => {
  const rules = new Map<string, AvoidanceRule>()
  const store: AvoidanceStoreShape = {
    getRule: (ruleId) => Effect.sync(() => rules.get(ruleId)),
    putRule: (rule) => Effect.sync(() => void rules.set(rule.ruleId, freezeCopy(rule))),
    listRules: () => Effect.sync(() => Array.from(rules.values()) as ReadonlyArray<AvoidanceRule>),
  }
  return store
})

// ─── Guard service ───────────────────────────────────────────────────────────

export interface FossilizationGuardShape {
  /** Learn an avoidance: time-bounded, versioned, with failure context. Emits `avoidance.learned`. */
  readonly learnAvoidance: (input: LearnAvoidanceInput) => Effect.Effect<AvoidanceRule, LearningError>
  /**
   * Is this behavior currently avoided? True only for ACTIVE, UNEXPIRED
   * rules. An expired rule is unenforced until retested — that is the whole
   * point of the guard (Hermes #6051).
   */
  readonly isAvoided: (behavior: string) => Effect.Effect<boolean, LearningError>
  readonly getRules: (behavior?: string) => Effect.Effect<ReadonlyArray<AvoidanceRule>, LearningError>
  readonly registerProbe: (behavior: string, probe: AvoidanceProbe) => Effect.Effect<void, LearningError>
  /**
   * Re-test one rule against current environment state, on demand.
   * works → lifted; still-fails → renewed as a new version with fresh
   * context. No probe registered → renewed conservatively with prior
   * context (never silently dropped). Non-active rules are returned
   * unchanged (idempotent no-op).
   */
  readonly retest: (ruleId: string) => Effect.Effect<AvoidanceRule, LearningError>
  /** Re-test every expired active rule. Returns one result per expired rule. */
  readonly sweepExpired: () => Effect.Effect<ReadonlyArray<RetestResult>, LearningError>
}

export class FossilizationGuard extends Context.Service<FossilizationGuard, FossilizationGuardShape>()(
  "aimy/learning/FossilizationGuard",
) {}

const guardProvenance = (rule: AvoidanceRule): Provenance => ({
  ...rule.provenance,
  origin: "fossilization-guard",
})

export const FossilizationGuardLive: Layer.Layer<FossilizationGuard, never, AvoidanceStore | LearningTimeline> =
  Layer.effect(
    FossilizationGuard,
    Effect.gen(function* () {
      const store = yield* AvoidanceStore
      const timeline = yield* LearningTimeline
      const probes = new Map<string, AvoidanceProbe>()

      const interventionEvent = (
        rule: AvoidanceRule,
        decision: "lifted" | "renewed",
        probeSummary: string,
        newVersion?: number,
      ): LearningEvent => ({
        type: "fossilization.intervention",
        provenance: guardProvenance(rule),
        subject: rule.behavior,
        evidenceIds: [],
        payload: {
          ruleId: rule.ruleId,
          behavior: rule.behavior,
          decision,
          previousVersion: rule.version,
          ...(newVersion !== undefined ? { newVersion } : {}),
          probeSummary,
        },
      })

      /** Renew with fresh context: new version, old version superseded (never mutated in place). */
      const renewRule = (
        old: AvoidanceRule,
        freshContext: FailureContext,
        probeSummary: string,
      ): Effect.Effect<AvoidanceRule, LearningError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const recordedAt = new Date(now).toISOString()
          const version = old.version + 1
          const ttlMs = DEFAULT_TTL_MS[old.classification]
          const renewed: AvoidanceRule = {
            ruleId: ruleIdFor(old.behavior, version, recordedAt),
            behavior: old.behavior,
            reason: old.reason,
            failureContext: freshContext,
            classification: old.classification,
            version,
            provenance: old.provenance,
            learnedAt: recordedAt,
            expiresAt: new Date(now + ttlMs).toISOString(),
            status: "active",
            supersedes: old.ruleId,
          }
          yield* store.putRule(renewed)
          yield* store.putRule({ ...old, status: "superseded" })
          yield* timeline.recordEvent(interventionEvent(old, "renewed", probeSummary, version))
          return renewed
        })

      const learnAvoidance: FossilizationGuardShape["learnAvoidance"] = (input) =>
        Effect.gen(function* () {
          const classification = input.classification ?? classifyFailure(input.context)
          const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS[classification]
          const now = yield* Clock.currentTimeMillis
          const recordedAt = new Date(now).toISOString()
          const version = 1
          const rule: AvoidanceRule = {
            ruleId: ruleIdFor(input.behavior, version, recordedAt),
            behavior: input.behavior,
            reason: input.reason,
            failureContext: input.context,
            classification,
            version,
            provenance: input.provenance,
            learnedAt: recordedAt,
            expiresAt: new Date(now + ttlMs).toISOString(),
            status: "active",
          }
          yield* store.putRule(rule)
          yield* timeline.recordEvent({
            type: "avoidance.learned",
            provenance: input.provenance,
            subject: input.behavior,
            evidenceIds: [],
            payload: {
              ruleId: rule.ruleId,
              behavior: input.behavior,
              classification,
              expiresAt: rule.expiresAt,
              reason: input.reason,
            },
          })
          return rule
        })

      const isAvoided: FossilizationGuardShape["isAvoided"] = (behavior) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rules = yield* store.listRules()
          return rules.some(
            (r) => r.behavior === behavior && r.status === "active" && Date.parse(r.expiresAt) > now,
          )
        })

      const getRules: FossilizationGuardShape["getRules"] = (behavior) =>
        Effect.gen(function* () {
          const rules = yield* store.listRules()
          return behavior === undefined ? rules : rules.filter((r) => r.behavior === behavior)
        })

      const registerProbe: FossilizationGuardShape["registerProbe"] = (behavior, probe) =>
        Effect.sync(() => {
          probes.set(behavior, probe)
        })

      const retest: FossilizationGuardShape["retest"] = (ruleId) =>
        Effect.gen(function* () {
          const rule = yield* store.getRule(ruleId)
          if (rule === undefined) return yield* Effect.fail(new AvoidanceNotFound({ ruleId }))
          if (rule.status !== "active") return rule // idempotent no-op on lifted/superseded
          const probe = probes.get(rule.behavior)
          if (probe === undefined) {
            // No probe: renew conservatively with prior context — never
            // silently drop an avoidance we cannot re-test.
            return yield* renewRule(
              rule,
              { ...rule.failureContext, recordedAt: new Date().toISOString() },
              `no probe registered for "${rule.behavior}" — renewed with prior context`,
            )
          }
          const outcome = yield* probe()
          if (outcome.outcome === "works") {
            const lifted: AvoidanceRule = { ...rule, status: "lifted" }
            yield* store.putRule(lifted)
            yield* timeline.recordEvent(interventionEvent(rule, "lifted", outcome.summary))
            return lifted
          }
          const freshContext: FailureContext = outcome.freshContext ?? {
            ...rule.failureContext,
            recordedAt: outcome.observedAt,
          }
          return yield* renewRule(rule, freshContext, outcome.summary)
        })

      const sweepExpired: FossilizationGuardShape["sweepExpired"] = () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rules = yield* store.listRules()
          const expired = rules.filter(
            (r) => r.status === "active" && Date.parse(r.expiresAt) <= now,
          )
          const results: Array<RetestResult> = []
          for (const rule of expired) {
            const updated = yield* retest(rule.ruleId)
            results.push({
              ruleId: rule.ruleId,
              behavior: rule.behavior,
              decision: updated.status === "lifted" ? "lifted" : "renewed",
              version: updated.version,
            })
          }
          return results as ReadonlyArray<RetestResult>
        })

      return FossilizationGuard.of({
        learnAvoidance,
        isAvoided,
        getRules,
        registerProbe,
        retest,
        sweepExpired,
      })
    }),
  )
