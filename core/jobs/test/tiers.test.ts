/**
 * tiers.test.ts — permission-tier inheritance.
 *
 * The core guarantee: a job scheduled at T1 can never perform T2/T3
 * actions. Escalation attempts fail closed with a typed
 * `TierEscalationDenied` BEFORE the action's effect runs (no side effect),
 * the run fails typed, and the denial is in the run history.
 */
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Ref } from "effect"

import { JobCapabilities, makeJobCapabilities } from "../src/capabilities.js"
import type { TierEscalationDenied } from "../src/errors.js"
import type { JobSpec, Tier } from "../src/types.js"
import { alertsOf, eventually, hasStatus, withRunner } from "./helpers.js"

describe("makeJobCapabilities (pure gate)", () => {
  it.effect("allows at/below the granted tier, denies above", () =>
    Effect.gen(function* () {
      const caps = makeJobCapabilities("job-1", "T1")
      expect(caps.tier).toBe("T1")
      yield* caps.check("T0", "read")
      yield* caps.check("T1", "write")
      const denied = yield* Effect.flip(caps.check("T2", "exec"))
      expect(denied._tag).toBe("TierEscalationDenied")
      expect(denied).toMatchObject({
        jobId: "job-1",
        grantedTier: "T1",
        requestedTier: "T2",
        action: "exec"
      })
      const denied3 = yield* Effect.flip(caps.check("T3", "exec"))
      expect(denied3._tag).toBe("TierEscalationDenied")
    })
  )

  it.effect("perform runs the effect when allowed, skips it when denied", () =>
    Effect.gen(function* () {
      const caps = makeJobCapabilities("job-1", "T1")
      const marker = yield* Ref.make(0)
      yield* caps.perform("T1", "count", Ref.update(marker, (n) => n + 1))
      expect(yield* Ref.get(marker)).toBe(1)
      const denied = yield* Effect.flip(
        caps.perform("T3", "count", Ref.update(marker, (n) => n + 100))
      )
      expect(denied._tag).toBe("TierEscalationDenied")
      // The denial happened BEFORE the effect: no side effect.
      expect(yield* Ref.get(marker)).toBe(1)
    })
  )

  it.effect("unknown granted tier denies everything (fail closed)", () =>
    Effect.gen(function* () {
      const caps = makeJobCapabilities("job-x", "T9" as Tier)
      for (const tier of ["T0", "T1", "T2", "T3"] as const) {
        const denied = yield* Effect.flip(caps.check(tier, "anything"))
        expect(denied._tag).toBe("TierEscalationDenied")
      }
    })
  )
})

describe("tier inheritance through the runner", () => {
  const escalateSpec = (marker: Ref.Ref<boolean>): JobSpec<void, TierEscalationDenied> => ({
    id: "escalate",
    name: "escalate",
    tier: "T1",
    schedule: { _tag: "OneShot", atMs: 0 },
    restart: { _tag: "Never" },
    run: Effect.gen(function* () {
      const caps = yield* JobCapabilities
      // T1 job attempts a T3 action: must be denied with no side effect.
      yield* caps.perform("T3", "write memory", Ref.set(marker, true))
    })
  })

  it.effect("T1 job attempting T3 → TierEscalationDenied, job fails typed, no side effect", () =>
    withRunner(({ runner, history, alerts }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const marker = yield* Ref.make(false)
        const spec = escalateSpec(marker)
        // Observe completion through the run history, not through the body:
        // the body is expected to fail at the gate.
        yield* runner.schedule({ ...spec, schedule: { _tag: "OneShot", atMs: now } })

        yield* eventually(hasStatus(history, "escalate", "failed"), "escalation denied")
        // The denial fired before the effect: the marker was never set.
        expect(yield* Ref.get(marker)).toBe(false)

        const failed = (yield* history.list("escalate")).find((r) => r.status === "failed")!
        expect(failed.reason).toContain("TierEscalationDenied")
        expect(failed.reason).toContain("grantedTier=\"T1\"")
        expect(failed.reason).toContain("requestedTier=\"T3\"")
        expect(failed.tier).toBe("T1")

        // Terminal failure under the default policy alerts.
        expect((yield* alertsOf(alerts, "job-failed")).length).toBeGreaterThanOrEqual(1)
      })
    )
  )

  it.effect("T3 job may perform T3 actions; T1 job may perform T1 actions", () =>
    withRunner(({ runner, history }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const t3ok = yield* Ref.make(false)
        const t1ok = yield* Ref.make(false)
        const mk = (
          id: string,
          tier: Tier,
          requested: Tier,
          marker: Ref.Ref<boolean>
        ): JobSpec<void, TierEscalationDenied> => ({
          id,
          name: id,
          tier,
          schedule: { _tag: "OneShot", atMs: now },
          restart: { _tag: "Never" },
          run: Effect.gen(function* () {
            const caps = yield* JobCapabilities
            yield* caps.perform(requested, "act", Ref.set(marker, true))
          })
        })
        yield* runner.schedule(mk("t3-job", "T3", "T3", t3ok))
        yield* runner.schedule(mk("t1-job", "T1", "T1", t1ok))
        yield* eventually(hasStatus(history, "t3-job", "succeeded"), "t3 ok")
        yield* eventually(hasStatus(history, "t1-job", "succeeded"), "t1 ok")
        expect(yield* Ref.get(t3ok)).toBe(true)
        expect(yield* Ref.get(t1ok)).toBe(true)
      })
    )
  )
})
