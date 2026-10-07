/**
 * desktop/src/renderer/resources.ts — the IPC-backed interpreter.
 *
 * The M8 composed app (`ui/src/composed`) is pure: its update returns
 * Commands whose Effects require `AppServices` (the union exported from
 * `composed/update.ts`). The demo ran those Commands against in-process
 * Effect services; this module provides the SAME services with their
 * implementations forwarded through the preload bridge (`window.aimy`).
 *
 * This is the "IPC-backed interpreter" — no fork of the ui/ sources, just
 * a `Layer` the foldkit runtime provides at the boundary:
 *
 *   Runtime.makeApplication({ ..., resources: ipcResources })
 *
 * Coverage map (renderer → main over the protocol in `ipc/protocol.ts`):
 * - ASCEngine.currentDials / recordEvidence(tuningChange) → asc.readDials / asc.tune
 * - CommsBanner.listBanners / dismiss → banners.list / banners.dismiss
 * - JobRunner.list / runNow → jobs.list / jobs.runNow
 * - LearningTimeline.query → timeline.list
 * - ExportInterpreter.run → export.run (receipt shown ONLY when the main
 *   side returns one — never fabricated)
 * - OnboardingPersistence.apply → config.get (preserve model) + config.set
 * - DevtoolsRelay.publish → fail-closed (relay is loopback-gated and off)
 *
 * Honest gaps (fail with typed errors → the slices' commands surface them
 * as failure Messages; never silent, never fabricated):
 * - SafetyKernel: the renderer cannot gate tool execution — the main-process
 *   kernel is the enforcement point (Pi #10426). Nothing in the UI
 *   dispatches RequestPermission today; the adapter is inert and fail-closed.
 * - MemoryService: no renderer-side memory backend; the engine persists the
 *   session transcript in the main process.
 * - JobRunner pause/resume/cancel + RunHistory: not exposed by the IPC
 *   contract v1 (protocol has jobs.list/jobs.runNow only).
 * - LearningTimeline archive/restore/edit/record: not exposed by IPC v1.
 */
import { Effect, Layer, Stream } from "effect"

import { ASCEngine, type ASCEngineShape } from "../../../asc-engine/engine.js"
import { ascError } from "../../../asc-engine/errors-shim.js"
import type { Evidence } from "../../../asc-engine/engine.js"
import { CommsBanner, type CommsBannerShape } from "../../../comms/service.js"
import { BannerLogError } from "../../../comms/errors.js"
import type { Banner, BannerEvent, BannerFilter } from "../../../comms/types.js"
import { JobRunner, type JobRunnerService } from "../../../jobs/src/runner.js"
import { InvalidJobSpec, JobNotFound } from "../../../jobs/src/errors.js"
import type { JobDescriptor } from "../../../jobs/src/index.js"
import { RunHistory, type RunHistoryService } from "../../../jobs/src/history.js"
import { JobStoreError } from "../../../jobs/src/errors.js"
import type { RunRecord } from "../../../jobs/src/types.js"
import { LearningTimeline, type LearningTimelineShape } from "../../../learning/src/timeline.js"
import { LearningStoreError } from "../../../learning/src/errors.js"
import type { LearningNode } from "../../../learning/src/index.js"
import { MemoryService, type MemoryServiceShape } from "../../../memory/service.js"
import { MemoryStoreError, PermissionDenied } from "../../../substrate/errors.js"
import { SafetyKernel, type SafetyKernelService } from "../../../permission-kernel/index.js"
import { ExportInterpreter, type ExportInterpreterShape } from "../../../ui/src/export/seam.js"
import { ExportError } from "../../../substrate/errors.js"
import type { ExportReceipt } from "../../../export/bundle.js"
import {
  OnboardingError,
  OnboardingPersistence,
  type OnboardingPersistenceShape
} from "../../../ui/src/onboarding/seam.js"
import type { InitialConfig } from "../../../ui/src/onboarding/model.js"
import { DevtoolsRelay, DevtoolsError, type DevtoolsRelayShape } from "../../../ui/src/devtools/seam.js"
import { MCP_BIND_HOST } from "../../../ui/src/devtools/model.js"
import type { AppServices } from "../../../ui/src/composed/index.js"
import type { IpcCommand, IpcCommandResult } from "../ipc/protocol.js"

import { getAimy } from "./ipc.js"

/** One IPC round-trip as an Effect; transport rejections become `Error`. */
const invokeIpc = <C extends IpcCommand>(cmd: C): Effect.Effect<IpcCommandResult<C>, Error> =>
  Effect.tryPromise({
    try: () => getAimy().invoke(cmd),
    catch: (error) => (error instanceof Error ? error : new Error(String(error)))
  })

// ─── SafetyKernel: inert + fail-closed ───────────────────────────────────────
// The renderer never executes tools; the main-process kernel is the gate.
// Nothing in the UI dispatches RequestPermission — if anything ever does,
// denial is the only safe answer from this side of the bridge.

const ipcSafetyKernel: SafetyKernelService = {
  check: (intent) =>
    Effect.fail(
      new PermissionDenied({
        tool: String(intent.tool),
        tier: intent.tier,
        reason:
          "renderer-side kernel is advisory-only: tool execution is gated by the main-process SafetyKernel (Pi #10426)"
      })
    ),
  execute: (_intent, _run) =>
    Effect.fail(
      new PermissionDenied({
        tool: "unknown",
        tier: "T3",
        reason: "the renderer never executes tools; execution lives in the main process"
      })
    ),
  approve: (intent) =>
    Effect.fail(
      new PermissionDenied({
        tool: String(intent.tool),
        tier: intent.tier,
        reason: "approvals are granted in the main process, not the renderer"
      })
    )
}

// ─── MemoryService: no renderer-side backend ─────────────────────────────────
// The engine (main process) persists the session transcript itself. The
// shell slice's PersistMemory is fire-and-forget; its failure message is
// non-fatal by design.

const noMemoryBackend = (op: string) =>
  Effect.fail(
    new MemoryStoreError({
      store: "renderer",
      reason: `memory:${op} has no renderer-side backend over IPC; the engine persists the session transcript in the main process`
    })
  )

const ipcMemoryService: MemoryServiceShape = {
  append: (sessionId, _input) => noMemoryBackend(`append(${sessionId})`),
  read: (sessionId) => noMemoryBackend(`read(${sessionId})`),
  branch: (sessionId, _fromId) => noMemoryBackend(`branch(${sessionId})`),
  fork: (sessionId, _newSessionId) => noMemoryBackend(`fork(${sessionId})`),
  get: (ns, key) => noMemoryBackend(`get(${String(ns)}:${key})`),
  set: (ns, key, _value) => noMemoryBackend(`set(${String(ns)}:${key})`),
  listSessions: () => noMemoryBackend("listSessions"),
  listKeys: (ns) => noMemoryBackend(`listKeys(${String(ns)})`)
}

// ─── ASCEngine over IPC ─────────────────────────────────────────────────────
// Reads: asc.readDials. Writes: exactly one — recordEvidence with kind
// "tuningChange" → asc.tune (the frozen tuning seam, same as in-process).
// Every other evidence kind is rejected: the renderer may not invent
// task outcomes or surprise entries.

const toAscError = (error: Error) => ascError(`ipc: ${error.message}`)

const ipcAscEngine: ASCEngineShape = {
  currentDials: invokeIpc({ _tag: "asc.readDials" }).pipe(Effect.mapError(toAscError)),
  dialHistory: (_limit) =>
    Effect.fail(ascError("ipc: dial history is not exposed over the IPC contract v1")),
  errorTermFirings: (_limit) =>
    Effect.fail(ascError("ipc: error-term firings are not exposed over the IPC contract v1")),
  guardFlags: (_limit) =>
    Effect.fail(ascError("ipc: guard flags are not exposed over the IPC contract v1")),
  narrative: (_limit) =>
    Effect.fail(ascError("ipc: narrative entries are not exposed over the IPC contract v1")),
  capabilityMap: Effect.fail(ascError("ipc: the capability map is not exposed over the IPC contract v1")),
  interfaceVersion: Effect.succeed("1.0.0" as const),
  recordEvidence: (evidence: Evidence) => {
    if (evidence.kind !== "tuningChange") {
      return Effect.fail(
        ascError(
          `ipc: evidence kind "${evidence.kind}" cannot be recorded from the renderer — only the tuningChange seam crosses the bridge`
        )
      )
    }
    const payload = evidence.payload as { readonly parameter?: unknown; readonly to?: unknown }
    if (typeof payload.parameter !== "string" || typeof payload.to !== "number") {
      return Effect.fail(ascError("ipc: tuningChange evidence needs { parameter: string, to: number }"))
    }
    return invokeIpc({ _tag: "asc.tune", dial: payload.parameter, target: payload.to }).pipe(
      Effect.asVoid,
      Effect.mapError(toAscError)
    )
  }
}

// ─── CommsBanner over IPC ────────────────────────────────────────────────────

const toBannerError = (op: string, error: Error) =>
  new BannerLogError({ reason: `ipc: banners.${op} failed: ${error.message}` })

const ipcCommsBanner: CommsBannerShape = {
  publish: (_input, _capability) =>
    Effect.fail(new BannerLogError({ reason: "ipc: publishing banners from the renderer is not in the IPC contract v1" })),
  subscribe: () =>
    // The error channel is `never`: banner events reach the renderer as
    // window.aimy 'banner.published' events (see subscriptions.ts), never
    // through this in-process hub subscription.
    Effect.succeed(Stream.empty as Stream.Stream<BannerEvent>),
  listBanners: (_filter?: BannerFilter) =>
    invokeIpc({ _tag: "banners.list" }).pipe(
      Effect.map((result): ReadonlyArray<Banner> => result.banners),
      Effect.mapError((error) => toBannerError("list", error))
    ),
  dismiss: (id: string) =>
    Effect.gen(function* () {
      const before = yield* invokeIpc({ _tag: "banners.list" }).pipe(
        Effect.mapError((error) => toBannerError("list", error))
      )
      const banner = before.banners.find((b) => b.id === id)
      if (banner === undefined) {
        return yield* Effect.fail(new BannerLogError({ reason: `ipc: banner ${id} not present in banners.list` }))
      }
      yield* invokeIpc({ _tag: "banners.dismiss", id }).pipe(
        Effect.mapError((error) => toBannerError("dismiss", error))
      )
      return banner
    }),
  bannerLog: () =>
    Effect.fail(new BannerLogError({ reason: "ipc: the banner audit log is not in the IPC contract v1" }))
}

// ─── JobRunner + RunHistory over IPC ─────────────────────────────────────────

const ipcJobRunner: JobRunnerService = {
  schedule: (_spec) =>
    Effect.fail(
      new InvalidJobSpec({ jobId: "(schedule)", reason: "scheduling jobs from the renderer is not in the IPC contract v1" })
    ),
  list: (): Effect.Effect<ReadonlyArray<JobDescriptor>, never> =>
    // `list`'s error channel is `never`: a transport failure cannot be
    // typed here, so it surfaces as an empty list. Documented v1 gap —
    // the whole app is unusable if the main process is unreachable anyway.
    Effect.promise(() => getAimy().invoke({ _tag: "jobs.list" })).pipe(
      Effect.map((result) => result.jobs),
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<JobDescriptor>))
    ),
  enable: (jobId) => Effect.fail(new JobNotFound({ jobId })),
  disable: (jobId) => Effect.fail(new JobNotFound({ jobId })),
  remove: (jobId) => Effect.fail(new JobNotFound({ jobId })),
  runNow: (jobId) =>
    invokeIpc({ _tag: "jobs.runNow", id: jobId }).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.fail(new JobNotFound({ jobId })))
    )
}

/**
 * Run history is not in the IPC contract v1 (`jobs.list` returns jobs +
 * statuses only). The documented v1 gap: the panel shows jobs without
 * history rather than failing the whole refresh.
 */
const ipcRunHistory: RunHistoryService = {
  append: (_record) =>
    Effect.fail(new JobStoreError({ reason: "appending run history from the renderer is not in the IPC contract v1" })),
  list: (_jobId: string): Effect.Effect<ReadonlyArray<RunRecord>, JobStoreError> => Effect.succeed([])
}

// ─── LearningTimeline over IPC ───────────────────────────────────────────────

const toTimelineError = (operation: string, error: Error) =>
  new LearningStoreError({ operation, reason: `ipc: ${error.message}` })

const timelineUnsupported = (operation: string) =>
  Effect.fail(new LearningStoreError({ operation, reason: "not in the IPC contract v1" }))

const ipcLearningTimeline: LearningTimelineShape = {
  recordEvent: (_event) => timelineUnsupported("recordEvent"),
  getNode: (_nodeId) => Effect.succeed(undefined),
  query: (_q) =>
    invokeIpc({ _tag: "timeline.list" }).pipe(
      Effect.map((result): ReadonlyArray<LearningNode> => result.nodes),
      Effect.mapError((error) => toTimelineError("query", error))
    ),
  archiveNode: (nodeId, _request) => timelineUnsupported(`archiveNode(${nodeId})`),
  restoreNode: (nodeId, _request) => timelineUnsupported(`restoreNode(${nodeId})`),
  editNode: (nodeId, _payload, _provenance) => timelineUnsupported(`editNode(${nodeId})`)
}

// ─── ExportInterpreter over IPC ──────────────────────────────────────────────
// The main side runs the real export and (when it exposes one) returns the
// verified receipt. The renderer shows a receipt ONLY when the main side
// provided it — a missing receipt is ExportFailed, never a fabricated one.

const ipcExportInterpreter: ExportInterpreterShape = {
  run: (destination: string) =>
    Effect.gen(function* () {
      if (destination.trim().length === 0) {
        return yield* Effect.fail(new ExportError({ reason: "export: empty destination" }))
      }
      const result = yield* invokeIpc({ _tag: "export.run" }).pipe(
        Effect.mapError((error) => new ExportError({ reason: `ipc: ${error.message}` }))
      )
      const receipt = result.receipt
      if (receipt === undefined) {
        return yield* Effect.fail(
          new ExportError({
            reason: `export: the main process wrote ${result.bundlePath} but returned no integrity receipt over IPC — refusing to claim a verified export`
          })
        )
      }
      const out: ExportReceipt = {
        version: 1,
        exportedAt: receipt.exportedAt,
        instanceId: receipt.instanceId,
        exporterVersion: receipt.exporterVersion,
        files: receipt.files,
        bundleHash: receipt.bundleHash
      }
      return out
    })
}

// ─── OnboardingPersistence over IPC ──────────────────────────────────────────
// The slice collects the endpoint URL (no model-name field — the slice is
// untouched). The current model name is preserved from config.get.

const ipcOnboardingPersistence: OnboardingPersistenceShape = {
  apply: (config: InitialConfig) =>
    Effect.gen(function* () {
      const current = yield* invokeIpc({ _tag: "config.get" }).pipe(
        Effect.mapError((error) => new OnboardingError({ reason: `ipc: config.get failed: ${error.message}` }))
      )
      yield* invokeIpc({
        _tag: "config.set",
        baseUrl: config.endpointBaseUrl,
        model: current.model
      }).pipe(
        Effect.mapError((error) => new OnboardingError({ reason: `ipc: config.set failed: ${error.message}` }))
      )
    })
}

// ─── DevtoolsRelay: fail-closed ──────────────────────────────────────────────
// The relay is loopback-bound and the DevTools slice's flag is off by
// default; the renderer never publishes.

const ipcDevtoolsRelay: DevtoolsRelayShape = {
  bindHost: MCP_BIND_HOST,
  publish: (_entries) =>
    Effect.fail(new DevtoolsError({ reason: "devtools: publishing from the renderer is disabled (relay not bound)" }))
}

/** The full IPC-backed service set for the composed app. */
export const ipcResources: Layer.Layer<AppServices> = Layer.mergeAll(
  Layer.succeed(SafetyKernel, ipcSafetyKernel),
  Layer.succeed(MemoryService, ipcMemoryService),
  Layer.succeed(ASCEngine, ipcAscEngine),
  Layer.succeed(CommsBanner, ipcCommsBanner),
  Layer.succeed(JobRunner, ipcJobRunner),
  Layer.succeed(RunHistory, ipcRunHistory),
  Layer.succeed(LearningTimeline, ipcLearningTimeline),
  Layer.succeed(ExportInterpreter, ipcExportInterpreter),
  Layer.succeed(OnboardingPersistence, ipcOnboardingPersistence),
  Layer.succeed(DevtoolsRelay, ipcDevtoolsRelay)
)
