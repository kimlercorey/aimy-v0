/**
 * runner.test.ts — the JobRunner service.
 *
 * Covers: schedule validation, one-shot + cron triggering (TestClock-driven),
 * list/enable/disable/remove/runNow, crash → typed JobFailed → backoff
 * retries → JobParked + banner alert, Never/Always restart semantics,
 * interruption → cancelled (no restart, no park), and the poke/wakeup
 * protocol (no lost wakeups, no double-fires).
 */
import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Ref } from "effect"
import { TestClock } from "effect/testing"

import { cronAny, cronAt, cronEvery } from "../src/cron.js"
import { JobCapabilities } from "../src/capabilities.js"
import type { JobSpec, Tier } from "../src/types.js"
import { alertsOf, countStatus, eventually, hasStatus, withRunner } from "./helpers.js"

const everyMinute = {
  minute: cronEvery(1, 0, 59),
  hour: cronAny,
  dayOfMonth: cronAny,
  month: cronAny,
  dayOfWeek: cronAny
}

const oneShot = (atMs: number): JobSpec<never, never>["schedule"] => ({
  _tag: "OneShot",
  atMs
})

describe("schedule validation", () => {
  it.effect("rejects duplicates, bad ids, bad tiers, bad schedules", () =>
    withRunner(({ runner }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const ok: JobSpec<void, never> = {
          id: "ok-job",
          name: "ok",
          tier: "T1",
          schedule: oneShot(now + 60_000),
          restart: { _tag: "Never" },
          run: Effect.void
        }
        yield* runner.schedule(ok)

        const dup = yield* Effect.flip(runner.schedule(ok))
        expect(dup._tag).toBe("JobAlreadyExists")

        const badId = yield* Effect.flip(runner.schedule({ ...ok, id: "UPPER!" }))
        expect(badId._tag).toBe("InvalidJobSpec")

        const badTier = yield* Effect.flip(
          runner.schedule({ ...ok, id: "bad-tier", tier: "T9" as Tier })
        )
        expect(badTier._tag).toBe("InvalidJobSpec")

        const badCron = yield* Effect.flip(
          runner.schedule({
            ...ok,
            id: "bad-cron",
            schedule: { _tag: "Cron", cron: { ...everyMinute, minute: cronAt(99) } }
          })
        )
        expect(badCron._tag).toBe("InvalidJobSpec")

        const impossible = yield* Effect.flip(
          runner.schedule({
            ...ok,
            id: "impossible",
            schedule: {
              _tag: "Cron",
              cron: { ...everyMinute, dayOfMonth: cronAt(30), month: cronAt(2) }
            }
          })
        )
        expect(impossible._tag).toBe("InvalidJobSpec")

        const badAt = yield* Effect.flip(
          runner.schedule({ ...ok, id: "bad-at", schedule: oneShot(-5) })
        )
        expect(badAt._tag).toBe("InvalidJobSpec")

        const badRestart = yield* Effect.flip(
          runner.schedule({
            ...ok,
            id: "bad-restart",
            restart: { _tag: "OnFailure", maxAttempts: -1, backoffMs: 100 }
          })
        )
        expect(badRestart._tag).toBe("InvalidJobSpec")

        // Only the valid job is listed.
        expect((yield* runner.list()).map((d) => d.id)).toEqual(["ok-job"])
      })
    )
  )
})

describe("triggering", () => {
  it.effect("one-shot job runs once at its due time", () =>
    withRunner(({ runner, history }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const ran = yield* Deferred.make<void>()
        yield* runner.schedule({
          id: "once",
          name: "once",
          tier: "T1",
          schedule: oneShot(now + 60_000),
          restart: { _tag: "Never" },
          run: Deferred.succeed(ran, void 0)
        })
        expect(yield* history.list("once")).toEqual([])
        yield* TestClock.adjust("61 seconds")
        yield* Deferred.await(ran)
        yield* eventually(hasStatus(history, "once", "succeeded"), "one-shot succeeded")
        const records = yield* history.list("once")
        expect(records.map((r) => r.status)).toEqual(["started", "succeeded"])
        expect(records[0]!.tier).toBe("T1")
        expect(records[1]!.durationMs).toBeGreaterThanOrEqual(0)
        // One-shot is consumed: no further runs.
        yield* TestClock.adjust("5 minutes")
        yield* eventually(countStatus(history, "once", "started").pipe(Effect.map((n) => n === 1)), "no second run")
      })
    )
  )

  it.effect("cron job fires on every tick", () =>
    withRunner(({ runner, history }) =>
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        yield* runner.schedule({
          id: "ticky",
          name: "ticky",
          tier: "T0",
          schedule: { _tag: "Cron", cron: everyMinute },
          restart: { _tag: "Never" },
          run: Ref.update(counter, (n) => n + 1)
        })
        yield* TestClock.adjust("61 seconds")
        yield* eventually(
          Ref.get(counter).pipe(Effect.map((n) => n >= 1)),
          "first tick"
        )
        yield* TestClock.adjust("60 seconds")
        yield* eventually(
          Ref.get(counter).pipe(Effect.map((n) => n >= 2)),
          "second tick"
        )
        expect(yield* countStatus(history, "ticky", "succeeded")).toBeGreaterThanOrEqual(2)
      })
    )
  )

  it.effect("runNow triggers an enabled job immediately", () =>
    withRunner(({ runner, history }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const ran = yield* Deferred.make<void>()
        yield* runner.schedule({
          id: "manual",
          name: "manual",
          tier: "T1",
          schedule: oneShot(now + 3_600_000),
          restart: { _tag: "Never" },
          run: Deferred.succeed(ran, void 0)
        })
        yield* runner.runNow("manual")
        yield* Deferred.await(ran)
        yield* eventually(hasStatus(history, "manual", "succeeded"), "runNow fired")
      })
    )
  )

  it.effect("runNow fails for missing/disabled jobs", () =>
    withRunner(({ runner }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* runner.schedule({
          id: "sleepy",
          name: "sleepy",
          tier: "T1",
          schedule: oneShot(now + 3_600_000),
          restart: { _tag: "Never" },
          run: Effect.void
        })
        const missing = yield* Effect.flip(runner.runNow("ghost"))
        expect(missing._tag).toBe("JobNotFound")
        yield* runner.disable("sleepy")
        const disabled = yield* Effect.flip(runner.runNow("sleepy"))
        expect(disabled._tag).toBe("JobNotRunnable")
        expect(disabled).toMatchObject({ status: "disabled" })
      })
    )
  )
})

describe("enable / disable / remove", () => {
  it.effect("disable stops ticks gracefully; enable resumes", () =>
    withRunner(({ runner, history }) =>
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        yield* runner.schedule({
          id: "pausable",
          name: "pausable",
          tier: "T0",
          schedule: { _tag: "Cron", cron: everyMinute },
          restart: { _tag: "Never" },
          run: Ref.update(counter, (n) => n + 1)
        })
        yield* runner.disable("pausable")
        yield* TestClock.adjust("3 minutes")
        yield* eventually(Effect.succeed(true), "settle")
        expect(yield* Ref.get(counter)).toBe(0)
        expect(yield* history.list("pausable")).toEqual([])

        yield* runner.enable("pausable")
        yield* TestClock.adjust("61 seconds")
        yield* eventually(
          Ref.get(counter).pipe(Effect.map((n) => n >= 1)),
          "resumed tick"
        )
        expect((yield* runner.list()).find((d) => d.id === "pausable")!.status).toBe("enabled")
      })
    )
  )

  it.effect("remove deletes the job; unknown ids fail typed", () =>
    withRunner(({ runner }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* runner.schedule({
          id: "doomed",
          name: "doomed",
          tier: "T1",
          schedule: oneShot(now + 3_600_000),
          restart: { _tag: "Never" },
          run: Effect.void
        })
        yield* runner.remove("doomed")
        expect(yield* runner.list()).toEqual([])
        expect((yield* Effect.flip(runner.remove("doomed")))._tag).toBe("JobNotFound")
        expect((yield* Effect.flip(runner.enable("doomed")))._tag).toBe("JobNotFound")
        expect((yield* Effect.flip(runner.disable("doomed")))._tag).toBe("JobNotFound")
      })
    )
  )

  it.effect("remove interrupts an in-flight run; the run records cancelled", () =>
    withRunner(({ runner, history }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const gate = yield* Deferred.make<void>()
        yield* runner.schedule({
          id: "blocked",
          name: "blocked",
          tier: "T1",
          schedule: oneShot(now),
          restart: { _tag: "Never" },
          run: Deferred.await(gate)
        })
        yield* eventually(hasStatus(history, "blocked", "started"), "run started")
        // remove() interrupts and waits for termination: afterwards the
        // cancelled record is guaranteed present (deterministic).
        yield* runner.remove("blocked")
        const records = yield* history.list("blocked")
        expect(records.map((r) => r.status)).toEqual(["started", "cancelled"])
        expect(records[1]!.reason).toBe("interrupted")
      })
    )
  )
})

describe("failure, restart, parking", () => {
  it.effect("crash → typed JobFailed → backoff retries → JobParked + banner alert", () =>
    withRunner(({ runner, history, alerts }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* runner.schedule({
          id: "flaky",
          name: "flaky",
          tier: "T1",
          schedule: oneShot(now),
          restart: { _tag: "OnFailure", maxAttempts: 2, backoffMs: 1000 },
          run: Effect.fail(new Error("boom"))
        })

        // Attempt 1 fails immediately → retry armed at +1s.
        yield* eventually(hasStatus(history, "flaky", "failed"), "attempt 1 failed")
        yield* TestClock.adjust("1 second")
        yield* eventually(
          countStatus(history, "flaky", "failed").pipe(Effect.map((n) => n >= 2)),
          "attempt 2 failed"
        )
        // Backoff is exponential: retry 2 waits 2s.
        yield* TestClock.adjust("2 seconds")
        yield* eventually(hasStatus(history, "flaky", "parked"), "parked")

        const records = yield* history.list("flaky")
        expect(records.filter((r) => r.status === "started")).toHaveLength(3)
        expect(records.filter((r) => r.status === "failed")).toHaveLength(3)
        const failed = records.find((r) => r.status === "failed")!
        expect(failed.reason).toContain("JobFailed")
        expect(failed.reason).toContain("boom")
        // Retries are flagged as retries.
        expect(records.filter((r) => r.isRetry && r.status === "started")).toHaveLength(2)

        const desc = (yield* runner.list()).find((d) => d.id === "flaky")!
        expect(desc.status).toBe("parked")
        expect(desc.consecutiveFailures).toBe(3)

        // One job-parked alert, always — and no job-failed spam for retries.
        const parked = yield* alertsOf(alerts, "job-parked")
        expect(parked).toHaveLength(1)
        expect(parked[0]!.detail).toContain("JobParked")
        expect(parked[0]!.detail).toContain("attempts=2")
        expect(yield* alertsOf(alerts, "job-failed")).toEqual([])

        // A parked job never fires again on its own…
        yield* TestClock.adjust("10 minutes")
        expect(yield* countStatus(history, "flaky", "started")).toBe(3)

        // …until an explicit enable resets the budget.
        yield* runner.enable("flaky")
        expect((yield* runner.list()).find((d) => d.id === "flaky")!.status).toBe("enabled")
      })
    )
  )

  it.effect("defect (die) is recorded as a typed failure, not silent", () =>
    withRunner(({ runner, history }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* runner.schedule({
          id: "defective",
          name: "defective",
          tier: "T1",
          schedule: oneShot(now),
          restart: { _tag: "Never" },
          run: Effect.die(new Error("kaput"))
        })
        yield* eventually(hasStatus(history, "defective", "failed"), "defect recorded")
        const failed = (yield* history.list("defective")).find((r) => r.status === "failed")!
        expect(failed.reason).toContain("defect:")
        expect(failed.reason).toContain("kaput")
      })
    )
  )

  it.effect("Never: failure alerts once per terminal failure, cron continues", () =>
    withRunner(({ runner, history, alerts }) =>
      Effect.gen(function* () {
        yield* runner.schedule({
          id: "sad-cron",
          name: "sad-cron",
          tier: "T0",
          schedule: { _tag: "Cron", cron: everyMinute },
          restart: { _tag: "Never" },
          run: Effect.fail(new Error("always fails"))
        })
        yield* TestClock.adjust("61 seconds")
        yield* eventually(
          countStatus(history, "sad-cron", "failed").pipe(Effect.map((n) => n >= 1)),
          "first failure"
        )
        yield* TestClock.adjust("60 seconds")
        yield* eventually(
          countStatus(history, "sad-cron", "failed").pipe(Effect.map((n) => n >= 2)),
          "second failure"
        )
        // No parking with Never; still enabled; failures counted.
        const desc = (yield* runner.list()).find((d) => d.id === "sad-cron")!
        expect(desc.status).toBe("enabled")
        expect(desc.consecutiveFailures).toBeGreaterThanOrEqual(2)
        // Terminal failures alert under the default on-failure policy…
        expect((yield* alertsOf(alerts, "job-failed")).length).toBeGreaterThanOrEqual(2)
        // …and never park.
        expect(yield* alertsOf(alerts, "job-parked")).toEqual([])
      })
    )
  )

  it.effect("Always restarts after success within budget, then stops (no park on success)", () =>
    withRunner(({ runner, history, alerts }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const counter = yield* Ref.make(0)
        yield* runner.schedule({
          id: "eager",
          name: "eager",
          tier: "T1",
          schedule: oneShot(now),
          restart: { _tag: "Always", maxAttempts: 2, backoffMs: 500 },
          notify: "always",
          run: Ref.update(counter, (n) => n + 1)
        })
        // 1 initial run, then 2 backoff restarts (500ms, 1000ms). The
        // success alerts are sent at the END of each settle, so three alerts
        // means all three runs fully settled — deterministic.
        //
        // NOTE: wait for run 1's *settled* record (not just body completion)
        // before advancing the clock: the retry wakeup is armed during the
        // settle, from a timestamp read before the clock moves.
        yield* eventually(hasStatus(history, "eager", "succeeded"), "run 1 settled")
        yield* TestClock.adjust("5 seconds")
        yield* eventually(
          alertsOf(alerts, "job-succeeded").pipe(Effect.map((xs) => xs.length >= 3)),
          "three successes"
        )
        // The budget was spent on a SUCCESS: the job is done, not parked
        // (parking is for restart-budget exhaustion by failure).
        expect(yield* Ref.get(counter)).toBe(3)
        expect(yield* countStatus(history, "eager", "succeeded")).toBe(3)
        const desc = (yield* runner.list()).find((d) => d.id === "eager")!
        expect(desc.status).toBe("enabled")
        expect(desc.nextRunAtMs).toBeUndefined()
        expect(yield* alertsOf(alerts, "job-parked")).toEqual([])
      })
    )
  )

  it.effect("notify always alerts on success; notify never stays silent", () =>
    withRunner(({ runner, alerts }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const mk = (id: string, notify: "always" | "never"): JobSpec<void, never> => ({
          id,
          name: id,
          tier: "T1",
          schedule: oneShot(now),
          restart: { _tag: "Never" },
          notify,
          run: Effect.void
        })
        yield* runner.schedule(mk("loud", "always"))
        yield* runner.schedule(mk("quiet", "never"))
        yield* eventually(
          alertsOf(alerts, "job-succeeded").pipe(Effect.map((xs) => xs.length >= 1)),
          "success alert"
        )
        const succeeded = yield* alertsOf(alerts, "job-succeeded")
        expect(succeeded.map((a) => a.jobId)).toEqual(["loud"])
      })
    )
  )
})

describe("job bodies receive JobCapabilities", () => {
  it.effect("the runner provides the tier gate to every run", () =>
    withRunner(({ runner }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const seen = yield* Deferred.make<Tier>()
        yield* runner.schedule({
          id: "gated",
          name: "gated",
          tier: "T2",
          schedule: oneShot(now),
          restart: { _tag: "Never" },
          run: Effect.andThen(JobCapabilities, (caps) => Deferred.succeed(seen, caps.tier))
        })
        expect(yield* Deferred.await(seen)).toBe("T2")
      })
    )
  )
})
