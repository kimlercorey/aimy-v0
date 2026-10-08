/**
 * desktop/src/ipc/handlers.ts — real IPC handler implementations (M10 Track 2).
 *
 * Wires every `IpcCommand` in `protocol.ts` to the `DesktopEngine` and the
 * real services:
 *
 * - `chat.send` / `chat.cancel`: `engine.chatStream` (AgentLoop) pumped as
 *   `chat.token` / `chat.done` / `chat.error` events to the requesting
 *   webContents. Cancel calls `return()` on the engine's AsyncIterator
 *   (fiber interrupt, no post-cancel side effects).
 * - `banners.*`: the real `CommsBanner` service (persistent log in the XDG
 *   state dir in production; publishes are forwarded as `banner.published`
 *   events to every live renderer).
 * - `asc.*`: the real `ASCEngine` — reads via `currentDials`, and `asc.tune`
 *   goes through `recordEvidence({ kind: "tuningChange", ... })`, the ONLY
 *   write on the ASC boundary (dials are computed, never set directly).
 * - `sovereignty.*`: the file-backed toggle store (`./sovereignty.ts`).
 * - `export.run`: the real `exportData` one-click export over the engine's
 *   MemoryService + ModuleHost plus the desktop's IdentityService,
 *   SecretLocker and LearningTimeline; the bundle is independently verified
 *   (`verifyBundle`) before its path is returned.
 * - `jobs.*`: the real `JobRunner` (cron supervision live; the JobRunner's
 *   AlertSink publishes into the same CommsBanner, so job alerts surface as
 *   `banner.published` events).
 * - `timeline.list`: the real `LearningTimeline`.
 * - `config.*`: `~/.aimy/desktop.json` (read via the engine module's reader;
 *   writes use the same 0600 semantics; a change takes effect on next launch).
 *
 * Error hygiene: every handler failure is rethrown as `new Error` with a
 * clean message — stack traces and typed-error internals never cross to the
 * renderer.
 *
 * Test seam: `registerIpcWithDeps` exposes the same wiring with injectable
 * services (used by `desktop/test/ipc.test.ts` with in-memory services).
 */
import { Context, Effect, Layer, Scope, Stream } from "effect"
import { dialog } from "electron"
import type { IpcMain, WebContents } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import type { ChatChunk } from "../../../agent-loop/src/index.js"
import {
  ASCEngine,
  ASCEngineFullLive,
  DIAL_NAMES,
  InMemoryMemoryReaderLive,
  type ASCEngineShape
} from "../../../asc-engine/index.js"
import {
  CommsBanner,
  CommsBannerLive,
  type BannerEvent,
  type CommsBannerShape
} from "../../../comms/index.js"
import { exportData, verifyBundle, type BannerLogProvider } from "../../../export/index.js"
import {
  IdentityService,
  IdentityServiceLive,
  ensureInstanceId,
  type IdentityServiceShape
} from "../../../identity/identity.js"
import { FileLockerLive, SecretLocker, type SecretLockerShape } from "../../../identity/locker.js"
import {
  AlertSink,
  JobRunner,
  JobRunnerLive,
  RunHistory,
  makeFileRunHistory,
  type JobRunnerService,
  type JobStatus
} from "../../../jobs/index.js"
import type { JobAlert } from "../../../jobs/src/types.js"
import {
  InMemoryTimelineStore,
  LearningTimeline,
  LearningTimelineLive,
  type LearningTimelineShape
} from "../../../learning/src/index.js"
import { ExportError } from "../../../substrate/errors.js"
import { resolvePaths, type AimyPaths } from "../../../substrate/config.js"
import { Redacted } from "../../../substrate/types.js"
import {
  desktopConfigPath,
  readDesktopConfig,
  type DesktopConfig,
  type DesktopEngine
} from "../main/engine.js"
import {
  IPC_COMMAND_TAGS,
  type IpcCommand,
  type IpcEvent,
  type IpcResponse
} from "./protocol.js"
import { loadSovereigntyStore, type SovereigntyStore } from "./sovereignty.js"
import { HttpClient } from "../../../web-retrieval/src/http.js"
import { makeMessagingGateway, type MessagingGateway } from "../main/messaging.js"
import { makeTtsEngine, type TtsEngine } from "../main/tts-engine.js"
import { fanOutChannels } from "../main/channels.js"
import type { ChatChannelsResult } from "./protocol.js"

// ── Error hygiene ───────────────────────────────────────────────────────────

/** Clean message for the renderer: never a stack trace, never internals. */
const toCleanMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message !== "" ? error.message : error.name
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

// ── Chat streaming ──────────────────────────────────────────────────────────

export interface ChatStreams {
  /**
   * Start pumping `engine.chatStream(sessionId, input)`: each `Token` chunk
   * becomes a `chat.token` event via `push`, then `chat.done`; a stream
   * failure becomes `chat.error` with a clean message. Returns the streamId.
   * The pump is detached — `start` returns as soon as the stream exists.
   *
   * When `onSettled` is provided, the full turn text is accumulated and the
   * callback's result (the simultaneous-channels payload) is pushed as a
   * `chat.channels` event right after `chat.done`. Channels never fail the
   * turn: an undefined result simply means no channels event.
   */
  readonly start: (
    sessionId: string,
    input: string,
    push: (evt: IpcEvent) => void
  ) => string
  /** Interrupt a live stream (`return()` on the engine iterator). Unknown ids throw. */
  readonly cancel: (streamId: string) => Promise<void>
  /** Live stream ids (introspection for tests). */
  readonly activeIds: () => ReadonlyArray<string>
}

export const createChatStreams = (
  engine: DesktopEngine,
  onSettled?: (streamId: string, text: string) => Promise<ChatChannelsResult | undefined>
): ChatStreams => {
  const active = new Map<string, AsyncIterator<ChatChunk>>()

  const start: ChatStreams["start"] = (sessionId, input, push) => {
    const streamId = randomUUID()
    if (active.has(streamId)) throw new Error(`chat stream id collision: ${streamId}`)
    const iterator = engine.chatStream(sessionId, input)[Symbol.asyncIterator]()
    active.set(streamId, iterator)
    void (async (): Promise<void> => {
      let text = ""
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) break
          if (next.value._tag === "Token") {
            text += next.value.delta
            push({ _tag: "chat.token", streamId, delta: next.value.delta })
          }
          // Non-token chunks (ToolCall, Done) have no IPC event — the
          // protocol carries tokens plus terminal state only.
        }
        // A cancelled stream is already gone from the map: no `done` after
        // a cancel, so the renderer never sees terminal state twice.
        if (active.has(streamId)) {
          push({ _tag: "chat.done", streamId })
          if (onSettled !== undefined) {
            const channels = await onSettled(streamId, text).catch(() => undefined)
            if (channels !== undefined) push({ _tag: "chat.channels", channels })
          }
        }
      } catch (error) {
        if (active.has(streamId)) {
          push({ _tag: "chat.error", streamId, error: toCleanMessage(error) })
        }
      } finally {
        active.delete(streamId)
      }
    })()
    return streamId
  }

  const cancel: ChatStreams["cancel"] = async (streamId) => {
    const iterator = active.get(streamId)
    if (iterator === undefined) throw new Error(`unknown chat stream: ${streamId}`)
    active.delete(streamId)
    await iterator.return?.()
  }

  return { start, cancel, activeIds: () => [...active.keys()] }
}

// ── Desktop services (booted once per main process) ─────────────────────────

export interface DesktopServices {
  readonly comms: CommsBannerShape
  readonly asc: ASCEngineShape
  readonly jobs: JobRunnerService
  readonly timeline: LearningTimelineShape
  readonly identity: IdentityServiceShape
  readonly locker: SecretLockerShape
  readonly paths: AimyPaths
  readonly instanceId: string
}

/**
 * The vault passphrase. Generated once (256-bit, mode 0600 at
 * `~/.aimy/locker-passphrase`) and reused afterwards.
 *
 * STAGING DECISION (flagged): a generated passphrase in a 0600 file is only
 * marginally better than no passphrase. Track 3 should move this to the OS
 * keychain (or a passphrase prompt at unlock) — until then one-click export
 * keeps working without inventing credentials the user never chose.
 */
const loadOrCreateLockerPassphrase = (): Redacted<string> => {
  const file = path.join(os.homedir(), ".aimy", "locker-passphrase")
  try {
    const raw = fs.readFileSync(file, "utf8").trim()
    if (raw !== "") return Redacted.make(raw)
  } catch {
    // Missing/unreadable — create below.
  }
  const fresh = Redacted.make(randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // reveal() at the single point of use: the passphrase is written once to a
  // 0600 file, then only ever passed to FileLockerLive as Redacted.
  fs.writeFileSync(file, `${fresh.reveal()}\n`, { mode: 0o600 })
  return fresh
}

/**
 * Boot the desktop-owned services ONCE. The engine's own layer (AgentLoop,
 * MemoryService, ModuleHost, …) is NOT rebuilt here — `engine.run` provides
 * it per command; these are the services the chat stack doesn't own.
 * Failures reject (never hang); the caller maps them to clean messages.
 */
export const bootDesktopServices = (): Promise<DesktopServices> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const paths = resolvePaths()
      const instanceId = yield* ensureInstanceId(paths)
      const passphrase = loadOrCreateLockerPassphrase()

      const commsLayer = CommsBannerLive({ paths, instanceId })

      // JobRunner alerts publish into the SAME CommsBanner the IPC serves,
      // so job completions surface as `banner.published` events. The sink
      // never fails (contract): a banner that can't publish is dropped with
      // a main-process log line, never a crash.
      const alertSinkLayer = Layer.effect(
        AlertSink,
        Effect.map(CommsBanner, (comms) =>
          AlertSink.of({
            alert: (a: JobAlert) =>
              Effect.catch(
                Effect.asVoid(
                  comms.publish({
                    severity: a.kind === "job-failed" || a.kind === "job-parked" ? "warning" : "success",
                    source: `job:${a.jobId}`,
                    title: `${a.jobName}: ${a.kind}`,
                    body: a.detail,
                    dedupeKey: `desktop:${a.jobId}:${a.kind}`
                  })
                ),
                (e) =>
                  Effect.sync(() => {
                    console.error(`[aimy] job alert banner dropped (${a.jobId}): ${e._tag}`)
                  })
              )
          })
        )
      )
      const jobsLayer = Layer.provideMerge(
        JobRunnerLive,
        Layer.mergeAll(
          Layer.provide(alertSinkLayer, commsLayer),
          Layer.succeed(RunHistory, makeFileRunHistory(paths.state, instanceId))
        )
      )

      const lockerLayer = FileLockerLive({ passphrase, instanceId, paths })

      // Process-lifetime scope: these services live until the app quits.
      const scope = Effect.runSync(Scope.make())
      const ctx = yield* Layer.build(
        Layer.mergeAll(
          commsLayer,
          Layer.provide(ASCEngineFullLive, InMemoryMemoryReaderLive),
          jobsLayer,
          Layer.provide(LearningTimelineLive, InMemoryTimelineStore),
          Layer.provide(IdentityServiceLive({ instanceId, paths }), lockerLayer),
          lockerLayer
        )
      ).pipe(Effect.provideService(Scope.Scope, scope))

      return {
        comms: Context.get(ctx, CommsBanner),
        asc: Context.get(ctx, ASCEngine),
        jobs: Context.get(ctx, JobRunner),
        timeline: Context.get(ctx, LearningTimeline),
        identity: Context.get(ctx, IdentityService),
        locker: Context.get(ctx, SecretLocker),
        paths,
        instanceId
      } satisfies DesktopServices
    })
  )

// ── Command table ───────────────────────────────────────────────────────────

export interface IpcWireDeps extends DesktopServices {
  readonly engine: DesktopEngine
  readonly chatStreams: ChatStreams
  readonly sovereignty: SovereigntyStore
  readonly messaging: MessagingGateway
  readonly tts: TtsEngine
}

export interface InvokeContext {
  /** The requesting renderer — chat events and `asc.dialsUpdated` go here. */
  readonly sender: Pick<WebContents, "send">
}

export type HandlerTable = {
  readonly [K in IpcCommand["_tag"]]: (
    payload: Extract<IpcCommand, { _tag: K }>,
    ctx: InvokeContext
  ) => Promise<IpcResponse[K]>
}

type FieldBag = { readonly [field: string]: unknown }

const reqString = (payload: FieldBag, field: string): string => {
  const value: unknown = payload[field]
  if (typeof value !== "string" || value === "") {
    throw new Error(`aimy: command field "${field}" must be a non-empty string`)
  }
  return value
}

const reqBoolean = (payload: FieldBag, field: string): boolean => {
  const value: unknown = payload[field]
  if (typeof value !== "boolean") throw new Error(`aimy: command field "${field}" must be a boolean`)
  return value
}

const reqNumber = (payload: FieldBag, field: string): number => {
  const value: unknown = payload[field]
  if (typeof value !== "number") throw new Error(`aimy: command field "${field}" must be a number`)
  return value
}

export const createHandlerTable = (
  deps: IpcWireDeps,
  broadcast: (evt: IpcEvent) => void
): HandlerTable => {
  const { engine } = deps
  return {
    "chat.send": async (payload, ctx) => {
      const sessionId = reqString(payload, "sessionId")
      const input = reqString(payload, "input")
      const streamId = deps.chatStreams.start(sessionId, input, (evt) =>
        ctx.sender.send("aimy:event", evt)
      )
      return { streamId }
    },
    "chat.cancel": async (payload) => {
      await deps.chatStreams.cancel(reqString(payload, "streamId"))
    },
    "banners.list": async () => ({
      banners: await engine.run(deps.comms.listBanners())
    }),
    "banners.dismiss": async (payload) => {
      await engine.run(deps.comms.dismiss(reqString(payload, "id")))
    },
    "asc.readDials": async () => engine.run(deps.asc.currentDials),
    "asc.tune": async (payload, ctx) => {
      const dial = reqString(payload, "dial")
      if (!(DIAL_NAMES as ReadonlyArray<string>).includes(dial)) {
        throw new Error(`unknown ASC dial: ${dial}`)
      }
      const target = reqNumber(payload, "target")
      if (!Number.isFinite(target) || target < 0 || target > 10) {
        throw new Error(`ASC tune target out of range [0, 10]: ${target}`)
      }
      const dials = await engine.run(
        Effect.gen(function* () {
          // The ONLY write on the ASC boundary: evidence in, computed dials out.
          yield* deps.asc.recordEvidence({
            kind: "tuningChange",
            domain: "desktop",
            payload: { dial, target }
          })
          return yield* deps.asc.currentDials
        })
      )
      ctx.sender.send("aimy:event", { _tag: "asc.dialsUpdated", dials })
      return dials
    },
    "sovereignty.list": async () => ({ toggles: deps.sovereignty.list() }),
    "sovereignty.set": async (payload) => {
      deps.sovereignty.set(reqString(payload, "key"), reqBoolean(payload, "value"))
    },
    "export.run": async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      const outDir = path.join(deps.paths.state, "exports", stamp)
      const bannerProvider: BannerLogProvider = {
        bundlePath: "banner/banner-log.json",
        readLog: () =>
          Effect.mapError(
            deps.comms.bannerLog(),
            (e) => new ExportError({ reason: `export:banners:${e._tag}` })
          )
      }
      // IdentityService/SecretLocker/LearningTimeline come from the desktop
      // services; MemoryService/ModuleHost come from the ENGINE's layer
      // (the real session memory and modules — never a second stack).
      const summary = await engine.run(
        exportData({ outDir }, bannerProvider).pipe(
          Effect.provideService(IdentityService, deps.identity),
          Effect.provideService(SecretLocker, deps.locker),
          Effect.provideService(LearningTimeline, deps.timeline)
        )
      )
      // Never claim a bundle that doesn't verify independently.
      await Effect.runPromise(verifyBundle(summary.outDir))
      // M10 Track 3: expose the verified receipt so the renderer can show it
      // without fabricating one (protocol ExportRunResult.receipt).
      return {
        bundlePath: summary.outDir,
        receipt: {
          exportedAt: summary.receipt.exportedAt,
          instanceId: summary.receipt.instanceId,
          exporterVersion: summary.receipt.exporterVersion,
          files: { ...summary.receipt.files },
          bundleHash: summary.receipt.bundleHash
        }
      }
    },
    "jobs.list": async () => {
      const jobs = await engine.run(deps.jobs.list())
      const statuses: Record<string, JobStatus> = {}
      for (const job of jobs) statuses[job.id] = job.status
      return { jobs, statuses }
    },
    "jobs.runNow": async (payload) => {
      await engine.run(deps.jobs.runNow(reqString(payload, "id")))
    },
    "timeline.list": async () => ({
      nodes: await engine.run(deps.timeline.query({}))
    }),
    "config.get": async () => {
      const config = readDesktopConfig()
      return { baseUrl: config.baseUrl, model: config.model }
    },
    "config.set": async (payload) => {
      // Same 0600 semantics as the engine module's writer. Takes effect on
      // next launch — the running engine keeps its boot config.
      const config: DesktopConfig = {
        baseUrl: reqString(payload, "baseUrl"),
        model: reqString(payload, "model")
      }
      const file = desktopConfigPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
    },
    "tts.health": async () => ({
      health: await engine.run(
        Effect.gen(function* () {
          const http = yield* HttpClient
          const svc = yield* deps.tts.ttsService(http)
          return yield* svc.health()
        })
      )
    }),
    "tts.voices": async () => ({
      voices: await engine.run(
        Effect.gen(function* () {
          const http = yield* HttpClient
          const svc = yield* deps.tts.ttsService(http)
          return yield* svc.voices()
        })
      )
    }),
    "tts.setVoice": async (payload) => {
      const voiceId = reqString(payload, "voiceId")
      await engine.run(
        Effect.gen(function* () {
          const http = yield* HttpClient
          const svc = yield* deps.tts.ttsService(http)
          yield* svc.setVoice(voiceId) // validates the id exists
        })
      )
      // Persisted to disk inside the engine holder: survives restarts and
      // applies to every future service, including the channels fan-out.
      deps.tts.setActiveVoice(voiceId)
    },
    "tts.addVoice": async (payload) => {
      const name = reqString(payload, "name")
      const audioBase64 = reqString(payload, "audioBase64")
      if (name.length > 80) throw new Error('aimy: command field "name" must be at most 80 characters')
      let bytes: Uint8Array
      try {
        bytes = Uint8Array.from(Buffer.from(audioBase64, "base64"))
      } catch {
        throw new Error('aimy: command field "audioBase64" is not valid base64')
      }
      // 25 MB cap: reference clips are seconds long; this is generous.
      if (bytes.length > 25 * 1024 * 1024) {
        throw new Error("aimy: voice reference audio too large (max 25 MB)")
      }
      const voice = await engine.run(
        Effect.gen(function* () {
          const http = yield* HttpClient
          const svc = yield* deps.tts.ttsService(http)
          return yield* svc.addVoice(name, bytes)
        })
      )
      return { voice }
    },
    "tts.pickVoiceFile": async () => {
      const picked = await dialog.showOpenDialog({
        title: "Choose a voice reference recording",
        filters: [{ name: "WAV audio", extensions: ["wav"] }],
        properties: ["openFile"]
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { cancelled: true }
      }
      const filePath = picked.filePaths[0]!
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(filePath)
      } catch {
        throw new Error("aimy: could not read the chosen file")
      }
      if (bytes.length > 25 * 1024 * 1024) {
        throw new Error("aimy: voice reference audio too large (max 25 MB)")
      }
      return {
        cancelled: false,
        name: path.basename(filePath, path.extname(filePath)),
        audioBase64: bytes.toString("base64")
      }
    },
    "tts.engineStatus": async () => {
      const s = deps.tts.status()
      return { state: s.state, ...(s.detail !== undefined ? { detail: s.detail } : {}) }
    },
    "tts.installEngine": async () => {
      const st = deps.tts.status()
      if (st.state === "installing" || st.state === "ready") {
        return { started: false }
      }
      // Fire-and-forget: progress streams back as tts.installProgress events.
      // Errors surface through the event's error phase, never as a rejection
      // here — the invoke itself only starts the job.
      void deps.tts
        .install((progress) => broadcast({ _tag: "tts.installProgress", progress }))
        .then(
          () => deps.tts.ensureServer().catch(() => undefined),
          () => undefined
        )
      return { started: true }
    },
    "messaging.status": async () => deps.messaging.status(),
    "messaging.validateToken": async (payload) => {
      const token = reqString(payload, "token")
      if (token.length > 200) throw new Error("aimy: token implausibly long")
      return deps.messaging.validateToken(token)
    },
    "messaging.issueCode": async () => deps.messaging.issueCode(),
    "messaging.checkPairing": async () => deps.messaging.checkPairing(),
    "messaging.getForwarding": async () => deps.messaging.getForwarding(),
    "messaging.setForwarding": async (payload) => {
      const kinds = payload["kinds"]
      if (!Array.isArray(kinds) || !kinds.every((k): k is string => typeof k === "string")) {
        throw new Error('aimy: command field "kinds" must be an array of strings')
      }
      await deps.messaging.setForwarding(kinds)
    },
    "messaging.testMessage": async () => deps.messaging.testMessage()
  }
}

// ── Banner forwarding ───────────────────────────────────────────────────────

const startBannerForwarding = (
  comms: CommsBannerShape,
  broadcast: (evt: IpcEvent) => void
): void => {
  const scope = Effect.runSync(Scope.make()) // process-lifetime
  void Effect.runPromise(Effect.provideService(comms.subscribe(), Scope.Scope, scope)).then(
    (stream) => {
      void Effect.runFork(
        Stream.runForEach(stream, (evt: BannerEvent) =>
          evt.type === "published"
            ? Effect.sync(() => broadcast({ _tag: "banner.published", banner: evt.banner }))
            : Effect.void
        )
      )
    },
    () => undefined
  )
}

// ── Registration ────────────────────────────────────────────────────────────

const tagOf = (payload: unknown): unknown =>
  typeof payload === "object" && payload !== null
    ? (payload as { readonly _tag?: unknown })._tag
    : undefined

/**
 * The wiring with injectable services. `registerIpc` delegates to this after
 * the real boot; tests call it directly with in-memory services.
 */
export const registerIpcWithDeps = (
  ipcMain: Electron.IpcMain,
  engine: DesktopEngine,
  getDeps: () => Promise<IpcWireDeps>
): void => {
  // Every live renderer we've heard from — `banner.published` broadcasts here.
  const senders = new Set<WebContents>()
  const broadcast = (evt: IpcEvent): void => {
    for (const sender of Array.from(senders)) {
      if (sender.isDestroyed()) {
        senders.delete(sender)
        continue
      }
      try {
        sender.send("aimy:event", evt)
      } catch {
        senders.delete(sender)
      }
    }
  }

  let depsPromise: Promise<IpcWireDeps> | undefined
  const getDepsOnce = (): Promise<IpcWireDeps> => (depsPromise ??= getDeps())

  // Banner forwarding starts as soon as the services are up (fire-and-forget).
  void getDepsOnce().then(
    (deps) => startBannerForwarding(deps.comms, broadcast),
    () => undefined
  )

  const ready: Promise<HandlerTable> = getDepsOnce().then(
    (deps) => createHandlerTable(deps, broadcast),
    (error: unknown) => {
      throw new Error(`aimy: services unavailable: ${toCleanMessage(error)}`)
    }
  )

  // Channels are registered SYNCHRONOUSLY so no invoke can arrive before its
  // channel exists; each invocation awaits the (already-started) boot.
  for (const tag of IPC_COMMAND_TAGS) {
    ipcMain.handle(`aimy:${tag}`, async (event, payload) => {
      const sender = event.sender as WebContents | undefined
      if (sender !== undefined && !sender.isDestroyed()) senders.add(sender)
      const table = await ready
      const actual = tagOf(payload)
      if (actual !== tag) {
        throw new Error(
          `aimy: rejected payload with _tag ${JSON.stringify(actual) ?? "missing"} on channel "aimy:${tag}"`
        )
      }
      try {
        const handler = table[tag] as unknown as (
          payload: unknown,
          ctx: InvokeContext
        ) => Promise<unknown>
        return await handler(payload, {
          sender: sender ?? { send: () => undefined }
        })
      } catch (error) {
        // Clean messages only — stack traces never cross to the renderer.
        throw new Error(toCleanMessage(error))
      }
    })
  }
}

/**
 * Register every IPC command on the real `ipcMain`, backed by the
 * `DesktopEngine` plus the desktop-owned services booted here. The
 * messaging gateway's runtime (inbound listener + banner forwarder)
 * starts on boot when a token and a paired chat exist; the TTS server
 * starts on boot when the voice engine is installed.
 *
 * Returns a cleanup handle: call `stop()` on app quit to stop the TTS
 * server child process.
 */
export const registerIpc: (
  ipcMain: Electron.IpcMain,
  engine: DesktopEngine
) => { readonly stop: () => void } = (ipcMain, engine) => {
  // tts-server.py ships in the bundle next to the compiled output
  // (desktop:assets copies it to dist/tts/server/).
  const here = path.dirname(fileURLToPath(import.meta.url))
  const serverPy = path.resolve(here, "..", "..", "..", "tts", "server", "tts-server.py")
  let tts: TtsEngine | undefined

  registerIpcWithDeps(ipcMain, engine, async () => {
    const services = await bootDesktopServices()
    tts = makeTtsEngine({ serverPy })
    const chatStreams = createChatStreams(engine, (streamId, text) =>
      fanOutChannels({ engine, asc: services.asc, tts: tts! }, streamId, text)
    )
    const messaging = makeMessagingGateway({
      engine,
      locker: services.locker,
      comms: services.comms,
      paths: services.paths
    })
    messaging.startRuntime()
    // Voice server autostart: silent when the engine was never installed.
    if (tts.status().state === "ready") {
      void tts.ensureServer().catch(() => undefined)
    }
    return {
      ...services,
      engine,
      chatStreams,
      sovereignty: loadSovereigntyStore(),
      messaging,
      tts
    }
  })

  return {
    stop: () => {
      try { tts?.stopServer() } catch { /* ignore */ }
    }
  }
}
