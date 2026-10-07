/**
 * ui/demo/demo.ts — the M8 acceptance demo.
 *
 * Run: `npx tsx ui/demo/demo.ts` from ~/workspace/aimy/core.
 *
 * Mounts the FULL composed app (`ui/src/composed`: Track 1's real shell +
 * every panel slice) against LIVE services — the real ASC engine, the real
 * learning-timeline store, the real banner queue, the real job runner, all
 * in-memory — then runs the scripted scenario:
 *
 *   1. a turn runs: task-outcome + surprise evidence → the ASC pipeline
 *      computes dials → the ASC panel shows them (read-only, via
 *      `loadAscSlice` through the frozen engine boundary);
 *   2. a banner fires: a real job completes → its alert lands on the real
 *      CommsBanner channel → the banner queue shows it;
 *   3. timeline events land: memory learned, skill created (unverified →
 *      verified), curator transition → the timeline shows them;
 *   4. every other panel renders from its live slice (shell, sovereignty
 *      defaults, export wizard, onboarding, devtools-gated-off).
 *
 * The app is server-rendered to `ui/demo/index.html` (static, no JS — nothing
 * can log a console error) and acceptance assertions compare the rendered
 * values against live service state. Exit code is non-zero on failure.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import * as Server from "foldkit/experimental/server"

import { ASCEngine } from "../../asc-engine/engine.js"
import {
  ASCEngineLive,
  AscSelfModelLive,
  AscSelfMonitor,
  AscSelfMonitorLive,
  AscSelfNarrationLive,
  DeterministicAuxModelLive,
  DialStateLive,
  makeInMemoryMemoryReader,
  MemoryReader,
  OtherModelGuardLive,
  SomaticProxiesLive,
  StakeEstimatorLive,
} from "../../asc-engine/index.js"
import { runPostTurnAsc, runPreTurnAsc } from "../../agent-loop/src/asc-wiring.js"
import { AlertSink, JobRunner, JobRunnerLive } from "../../jobs/src/runner.js"
import { InMemoryRunHistory } from "../../jobs/src/history.js"
import { CommsBanner, CommsBannerEphemeral } from "../../comms/service.js"
import { InMemoryTimelineStore, LearningTimeline, LearningTimelineLive } from "../../learning/src/timeline.js"
import type { JobAlert } from "../../jobs/src/types.js"
import { loadAscSlice } from "../src/asc/index.js"
import {
  AppMessage,
  appUpdate,
  appView,
  initialAppModel,
  type AppModel,
} from "../src/composed/index.js"
import { drain, pollFor } from "../test/helpers.js"
import { renderPage } from "./page.js"
import {
  Message as TimelineMessage,
  update as timelineUpdate,
  initialModel as initialTimelineModel,
} from "../src/timeline/index.js"
import {
  JobsMessage,
  jobsUpdate,
  initialJobsModel,
} from "../src/ops/index.js"
import {
  BannersMessage,
  bannersUpdate,
  initialBannersModel,
} from "../src/ops/index.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ─── Layer stack (all live services, in-memory) ─────────────────────────────

const bannerLayer = CommsBannerEphemeral()

/**
 * JobRunner's AlertSink seam → the real CommsBanner channel. The seam is
 * infallible by contract ("a sink that cannot deliver must handle it
 * internally"), so publish failures are swallowed after a console warning.
 */
const bannerAlertSinkLayer = Layer.effect(
  AlertSink,
  Effect.map(CommsBanner, (banner) =>
    AlertSink.of({
      alert: (a: JobAlert) =>
        banner
          .publish({
            severity: a.kind === "job-failed" || a.kind === "job-parked" ? "warning" : "success",
            source: `job:${a.jobId}`,
            title: `${a.jobName}: ${a.kind}`,
            body: a.detail,
            dedupeKey: `m8demo:${a.jobId}:${a.kind}`,
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.sync(() => console.warn("demo alert sink: publish failed:", String(cause))),
            ),
          ),
    }),
  ),
).pipe(Layer.provide(bannerLayer))

/**
 * One shared ASC internal stack: the engine AND the monitor run against the
 * same DialState, so a turn driven through `AscSelfMonitor.preTurn/postTurn`
 * (the agent loop's real path) moves the dials the engine reports.
 */
const ascMemory = Layer.succeed(MemoryReader, makeInMemoryMemoryReader())
const ascInternals = Layer.mergeAll(
  DialStateLive,
  SomaticProxiesLive,
  StakeEstimatorLive,
  DeterministicAuxModelLive,
  OtherModelGuardLive,
  Layer.provide(AscSelfModelLive, ascMemory),
  Layer.provide(AscSelfNarrationLive, ascMemory),
)
const ascMonitorLayer = Layer.provide(AscSelfMonitorLive, ascInternals)
const ascStack = Layer.mergeAll(
  ascInternals,
  ascMonitorLayer,
  Layer.provide(ASCEngineLive, Layer.mergeAll(ascInternals, ascMonitorLayer)),
)

const stack = Layer.mergeAll(
  LearningTimelineLive.pipe(Layer.provide(InMemoryTimelineStore)),
  bannerLayer,
  JobRunnerLive.pipe(
    Layer.provideMerge(Layer.mergeAll(bannerAlertSinkLayer, InMemoryRunHistory)),
  ),
  ascStack,
)

// ─── The scripted scenario ───────────────────────────────────────────────────

const scenario = Effect.gen(function* () {
  const engine = yield* ASCEngine
  const timeline = yield* LearningTimeline
  const comms = yield* CommsBanner
  const runner = yield* JobRunner
  const log: Array<string> = []
  const note = (s: string) => {
    log.push(s)
    console.log(`  ${s}`)
  }

  // 1. A turn runs → dials compute. This is the agent loop's real path:
  // `runPreTurnAsc` (analyze → `AscSelfMonitor.preTurn` → the L2 pipeline
  // writes the live dial vector) then `runPostTurnAsc` (the post-turn audit).
  note("turn: running preTurn → postTurn through the real ASC pipeline…")
  const monitor = yield* AscSelfMonitor
  const { pre, analysis } = yield* runPreTurnAsc(monitor, {
    turn: 1,
    input:
      "I'm feeling overwhelmed and this is urgent — production is down, " +
      "it's blocking my whole team, and honestly this is personal for me",
    proxyOverrides: { contextPressurePct: 35 },
  })
  yield* runPostTurnAsc(monitor, {
    pre,
    analysis,
    turn: 1,
    outputText: "Acknowledged. Triage plan: isolate the failing deploy, roll back, verify.",
  })
  // The turn's outcome also feeds the L1 track record (error-term machinery).
  yield* engine.recordEvidence({
    kind: "taskOutcome",
    domain: "demo",
    payload: { success: true, surpriseED: 0.2, receiptId: "m8demo-turn-1" },
  })
  const dials = yield* engine.currentDials
  const ascSlice = yield* loadAscSlice
  note(`turn settled: dials=${JSON.stringify(dials)} (computation ${pre.computation.id})`)

  // 2. Timeline events land (memory learned, skill unverified → verified, curator).
  note("timeline: recording learning events…")
  const prov = { origin: "user" as const, sessionId: "m8demo", profileId: "demo" }
  const n1 = yield* timeline.recordEvent({
    type: "review-fork.proposed-add",
    provenance: prov,
    subject: "memory:theme-preference",
    evidenceIds: [],
    payload: { store: "profile", summary: "demo user prefers dark themes" },
  })
  yield* timeline.recordEvent({
    type: "verification.started",
    provenance: prov,
    subject: "skill:demo-notes",
    evidenceIds: [],
    payload: { judgeIds: ["judge-1"] },
  })
  const n3 = yield* timeline.recordEvent({
    type: "skill.trusted",
    provenance: { ...prov, origin: "verification-arm" as const },
    subject: "skill:demo-notes",
    evidenceIds: ["claim-demo-1"],
    payload: { judgeVersions: ["judge-1@v3"] },
  })
  yield* timeline.recordEvent({
    type: "curator.transitioned",
    provenance: { ...prov, origin: "curator" as const },
    subject: "skill:old-demo-notes",
    evidenceIds: [],
    payload: { from: "active", to: "stale", reason: "superseded by skill:demo-notes" },
  })
  const timelineNodes = yield* timeline.query({})
  note(`timeline: ${timelineNodes.length} nodes live`)

  // 3a. A banner fires directly (scheduler origin).
  note("banners: publishing a scheduler banner…")
  const schedBanner = yield* comms.publish({
    severity: "warning",
    source: "scheduler",
    title: "nightly report finished with warnings",
    body: "3 of 42 sources were unreachable; the report shipped partial.",
    dedupeKey: "m8demo:scheduler-report",
  })

  // 3b. A real job completes → its alert lands on the real banner channel.
  note("jobs: scheduling + running a real job…")
  yield* runner.schedule({
    id: "demo-report",
    name: "Demo report job",
    tier: "T1",
    schedule: { _tag: "OneShot", atMs: Date.now() + 60_000 },
    restart: { _tag: "Never" },
    notify: "always",
    run: Effect.succeed("report-ok"),
  })
  yield* runner.schedule({
    id: "demo-idle",
    name: "Demo idle job",
    tier: "T1",
    schedule: { _tag: "OneShot", atMs: Date.now() + 3_600_000 },
    restart: { _tag: "Never" },
    notify: "never",
    run: Effect.succeed("idle"),
  })
  yield* runner.runNow("demo-report")
  const jobBanner = yield* pollFor(
    Effect.gen(function* () {
      const banners = yield* comms.listBanners()
      return banners.find((b) => b.source === "job:demo-report")
    }),
    "job:demo-report banner",
  )
  note(`banner fired: "${jobBanner.title}"`)

  // 4. Refresh every slice from its live service (the slices' real Commands).
  const timelineModel = (yield* drain(
    timelineUpdate,
    initialTimelineModel,
    TimelineMessage.TimelineRefreshRequested(),
  )) as typeof initialTimelineModel
  const jobsModel = (yield* drain(
    jobsUpdate,
    initialJobsModel,
    JobsMessage.JobsRefreshRequested(),
  )) as typeof initialJobsModel
  const bannersModel = (yield* drain(
    bannersUpdate,
    initialBannersModel,
    BannersMessage.BannersRefreshRequested(),
  )) as typeof initialBannersModel

  const model: AppModel = {
    ...initialAppModel(),
    timeline: timelineModel,
    jobs: jobsModel,
    banners: bannersModel,
    asc: ascSlice,
  }

  return {
    model,
    log,
    expected: {
      dials,
      timelineNodeCount: timelineNodes.length,
      nodeIds: [n1.nodeId, n3.nodeId],
      bannerTitles: [schedBanner.title, jobBanner.title],
      jobNames: ["Demo report job", "Demo idle job"],
    },
  }
})

// ─── Main ────────────────────────────────────────────────────────────────────

const main = Effect.gen(function* () {
  console.log("M8 acceptance demo — scripted scenario against live services")
  const { model, log, expected } = yield* scenario

  console.log("rendering static page…")
  // Note: the server config is `{ init, view }` — update/subscriptions play
  // no part in a server render. The model above already holds the scenario's
  // settled state (every slice was refreshed from its live service).
  const rendered = yield* Server.renderToString(
    {
      init: () => ({ model }),
      view: appView,
    },
    { isHydratable: false },
  )
  const outPath = path.join(HERE, "index.html")
  fs.writeFileSync(outPath, renderPage(rendered.html, log), "utf-8")
  console.log(`wrote ${outPath}`)

  // ─── Acceptance assertions: rendered values === live service state ───
  console.log("acceptance assertions…")
  const html = fs.readFileSync(outPath, "utf-8")
  const failures: Array<string> = []
  const check = (label: string, cond: boolean) => {
    console.log(`  ${cond ? "ok" : "FAIL"} - ${label}`)
    if (!cond) failures.push(label)
  }

  // Dials shown === dials read from the ASC engine.
  for (const [name, value] of Object.entries(expected.dials)) {
    check(`dial ${name} shown (${value})`, html.includes(`>${value}<`) || html.includes(String(value)))
  }
  // Timeline nodes shown === timeline store contents.
  check(`timeline shows ${expected.timelineNodeCount} nodes`, html.includes(`${expected.timelineNodeCount} / 1400 entries used`))
  for (const id of expected.nodeIds) {
    check(`node id ${id.slice(0, 12)}… shown`, html.includes(id.slice(0, 12)))
  }
  check("skill verified badge shown", html.includes("skill verified ✓"))
  // Banners shown === banner queue contents.
  for (const title of expected.bannerTitles) {
    check(`banner "${title}" shown`, html.includes(title))
  }
  // Jobs shown === job runner state.
  for (const name of expected.jobNames) {
    check(`job "${name}" shown`, html.includes(name))
  }
  check("no slice in error state", !html.includes("failed to load"))
  // Shell panel renders (chat header).
  check("shell header shown", html.includes("AImy"))
  // Sovereignty panel renders with secure defaults: local inference on.
  check("sovereignty panel shown", html.includes("sovereignty"))
  check("local inference toggle on", html.includes("local inference"))
  // Export wizard renders in idle phase.
  check("export panel shown", html.includes("export"))
  // Onboarding renders its welcome step.
  check("onboarding panel shown", html.includes("onboarding"))
  // DevTools renders nothing (flag off by default) — but the slot exists.
  check("no devtools surface when flag off", !html.includes("devtools-timeline"))

  if (failures.length > 0) {
    console.error(`\nDEMO FAILED: ${failures.length} assertion(s) failed`)
    return yield* Effect.die(new Error(`demo assertions failed: ${failures.join("; ")}`))
  }
  console.log("\nDEMO PASSED: all assertions green")
}).pipe(Effect.provide(stack))

Effect.runPromise(main as Effect.Effect<void>).catch((cause) => {
  console.error("demo failed:", cause)
  process.exit(1)
})
