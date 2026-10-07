# @aimy/jobs — M7 JobRunner

In-app scheduler for background tasks, cron jobs, and long-running work
(architecture §1.1 row 9, §12 M7, MoSCoW MUST 7). Jobs are **Effect programs**,
never shell commands.

## Layout

- `src/types.ts` — `JobSpec`, `CronSpec`, `RestartPolicy`, `RunRecord`, `JobAlert`,
  `AlertSinkService`, `JobCapabilitiesService`
- `src/cron.ts` — pure cron helpers (`cronAny`/`cronAt`/`cronEvery`) and the pure
  `nextRunAfter(spec, fromMs)` computation (UTC; Vixie day-of-month/day-of-week OR)
- `src/errors.ts` — typed errors: `TierEscalationDenied`, `JobFailed`, `JobParked`,
  `JobNotFound`, `JobAlreadyExists`, `InvalidJobSpec`, `JobNotRunnable`, `JobStoreError`
- `src/capabilities.ts` — `JobCapabilities` tier-inheritance gate
- `src/history.ts` — append-only per-job run history (`InMemoryRunHistory`,
  `FileRunHistoryLive` under `<xdg-state>/jobs/<instanceId>/<jobId>/runs.jsonl`)
- `src/runner.ts` — `JobRunner` service + `AlertSink` banner seam
  (`SilentAlertSink`, `collectingAlertSink` for tests)
- `src/cadences.ts` — `monthlyAscDiagnostic()` and `learningReviewDrainJob()` factories

## Wiring

```ts
import { Layer } from "effect"
import { JobRunnerLive, AlertSink, FileRunHistoryLive, JobRunnerConfig } from "@aimy/jobs"
// (import path per the coordinator's packaging; source lives in core/jobs)

const bannerLayer: Layer.Layer<AlertSink> = /* CommsBanner adapter, wired by the coordinator */

const program = JobRunnerLive.pipe(
  Layer.provide(Layer.mergeAll(bannerLayer, FileRunHistoryLive))
  // JobRunnerConfig is a Context.Reference with a default (AIMY_INSTANCE_ID or
  // "local-dev-instance"); production provides the IdentityService install UUID.
)
```

## Supervision policy

This section is the JobRunner side of **architecture open risk #6**
("Module-host ↔ JobRunner fork supervision"): the single written policy for how
job fibers are parented, cancelled, restarted, and parked.

**1. One supervision root.** The `JobRunner` layer acquires a dedicated child
`Scope` at build time (`Effect.acquireRelease(Scope.make(), Scope.close)`).
Every job fiber — scheduled triggers, backoff retries, and the scheduler loop
itself — is forked into that scope with `Effect.forkIn`. Layer teardown closes
the scope, which interrupts the loop and every in-flight run. Job fibers are
leaves: they never outlive the runner, and nothing parents *under* a job fiber.

**2. The scheduler loop is the only trigger.** A single loop fiber computes the
nearest deadline across enabled jobs and parks in
`race(await wakeup, sleep(deadline))`. `schedule`/`enable`/`disable`/`remove`/`runNow`
mutate state and then `poke()` the loop. Pokes use a sequence counter checked
after the loop installs its fresh wakeup deferred, so a poke that lands
mid-computation forces a recompute and a poke that lands later wins the race —
no lost wakeups, no double-fires. A trigger is *claimed* at fork time (retry
wakeups parked, fresh ticks advanced to the next cron time), so a second loop
pass can never fire the same trigger twice.

**3. Every run is a supervised fiber with a typed outcome.** The run body is
observed by an `Effect.onExit` finalizer, so typed failures AND defects are
captured as values — including interruption, which `Effect.exit` does not trap
in v4 (see §4). A crash produces a typed `JobFailed` that is **always**
appended to the job's run history — failed jobs are never silent. The fiber is
registered in the job's `inFlight` set *before* it is released to run (it parks
on a `Deferred` until then), so `remove()` can never miss an in-flight run.

**4. Bookkeeping observes every exit, including interruption.** Effect 4's
`Effect.exit` does NOT trap interruption — an interrupted fiber dies before
any code after `exit` runs. The terminal outcome (succeeded/failed/cancelled)
is therefore recorded in an `Effect.onExit` finalizer, which observes every
exit. The recording itself runs inside `Effect.uninterruptible`, so a
cancelled run always leaves its `cancelled` record even when the interrupt
lands mid-run. Interruption is detected via `Cause.hasInterruptsOnly` and
**never** triggers a restart and **never** parks: cancel is external intent
(`remove`, layer teardown), not failure.

**5. Restarts are new fibers, never resurrections.** `Never` / `OnFailure` /
`Always` (backoff `baseMs * 2^retriesUsed`, capped at 1h; `maxAttempts`
restarts after the initial run). A retry is forked as a *sibling* of the dead
run under the runner scope. `Always` also restarts after success, consuming the
same budget (on a one-shot job this is a bounded loop of `1 + maxAttempts`
runs, then parking).

**6. Exhaustion parks — loudly.** When a *failed* run has no restarts left in
its budget, the job's status becomes `parked`: scheduling stops, a `parked`
record is appended to run history, and a `job-parked` banner alert fires
**regardless of the job's notify policy**. (A budget spent on *successes*
under `Always` simply ends the job — parking is for failure exhaustion, which
is what needs operator attention.) Only an explicit `enable` resumes a parked
job, and it resets the restart budget. `disable` is graceful (in-flight runs
finish, no new triggers); `remove` interrupts in-flight runs (each records
`cancelled`) and deletes the job.

**7. Alerts.** `job-parked` always alerts. Terminal `job-failed` alerts when the
job's notify policy is not `"never"` (intermediate failures that will retry do
not alert — the park alert covers them). `job-succeeded` alerts only with
notify `"always"`. Jobs may also raise their own `job-info` alerts through the
provided `AlertSink`.

**8. Cross-subsystem rule.** Job fibers never parent review forks, module work,
or delegation subagents. A job that needs a background review goes through the
learning library's `ReviewForks` (its own supervision domain, M6); a job that
needs module work goes through `ModuleHost`. The runner's scope is a *sibling*
of the `AgentLoop`/`ModuleHost` scopes under the application scope — never a
parent of them, never a child of a turn. Cancellation flows strictly downward:
application → runner scope → job fibers.

## Permission-tier inheritance

Every `JobSpec` records `tier` — the tier of its scheduling context. The runner
builds a `JobCapabilities` gate for that tier and provides it to the job body;
the body executes with **at most** that tier. `check`/`perform` deny *before*
the action's effect runs, so escalation attempts have no side effect, and the
denial is a typed `TierEscalationDenied` that fails the run (fail-closed) and
is recorded in run history.

Cooperative-boundary note: the gate binds every tiered side effect a job
performs *through* it. It is the in-process enforcement point; OS-level
enforcement arrives with the sandbox backend (architecture open risk #1).
TypeScript types alone are never the boundary (Pi #9824).

## Run history

Append-only JSONL per job: `started`, then exactly one terminal record
(`succeeded` | `failed` | `cancelled`), plus a `parked` record on budget
exhaustion. File layout: `<xdg-state>/jobs/<instanceId>/<jobId>/runs.jsonl`.
A corrupt line fails `list` loudly — evidence logs never silently skip.

## Cadence seams

- `monthlyAscDiagnostic()` — M7 monthly ASC diagnostic cadence (M5 extension
  point). Scheduling only: fires 1st of month 03:00 UTC and raises a
  `job-info` alert noting the diagnostic is due. The diagnostic itself is
  M8/other work.
- `learningReviewDrainJob(drain, opts?)` — M6 `ReviewScheduler.drain()` as a
  recurring job (default hourly at :15 UTC). Takes the drain as a
  coordinator-wired thunk (`() => Effect.flatMap(ReviewScheduler, s => s.drain())`)
  so this library does not depend on the learning layer; reuses the learning
  library's `DrainReport` type. The queue's own idle-gating still applies
  inside `drain()`.

## Tests

`npx vitest run jobs` from `core/` — cron purity, scheduling, supervision
(crash/restart/park/cancel), tier escalation, history persistence, cadences.
Time-based tests use `@effect/vitest`'s `it.effect` (TestClock provided) with
`TestClock.adjust` driving the scheduler loop.
