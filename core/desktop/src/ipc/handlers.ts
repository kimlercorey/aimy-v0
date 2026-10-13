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
  listProjects as storeListProjects,
  getActiveProject as storeGetActiveProject,
  createProject as storeCreateProject,
  setActiveProject as storeSetActiveProject,
  moveAsset as storeMoveAsset,
  addDocumentAsset as storeAddDocumentAsset,
  type ProjectAsset as StoreProjectAsset
} from "../../../agent-loop/src/projects.js"
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
import { createTraceWriter, traceError, type TraceWriter } from "../main/trace.js"
import { makeTtsEngine, type TtsEngine } from "../main/tts-engine.js"
import { fanOutChannels } from "../main/channels.js"
import type { ChatChannelsResult, HomedashSettingEntry, HomedashWidgetEntry } from "./protocol.js"

// ── Error hygiene ───────────────────────────────────────────────────────────

/** Clean message for the renderer: never a stack trace, never internals. */
const toCleanMessage = (error: unknown): string => {
  // Effect TaggedErrors (e.g. InferenceError) carry a `reason` field, not `.message`.
  if (error !== null && typeof error === "object" && "reason" in error && typeof (error as any).reason === "string") {
    const reason = (error as any).reason as string
    if (reason !== "") return reason
  }
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
    push: (evt: IpcEvent) => void,
    images?: ReadonlyArray<{ dataUrl: string; mimeType: string; name: string }>
  ) => string
  /** Interrupt a live stream (`return()` on the engine iterator). Unknown ids throw. */
  readonly cancel: (streamId: string) => Promise<void>
  /** Live stream ids (introspection for tests). */
  readonly activeIds: () => ReadonlyArray<string>
}

/**
 * A completed tool call's footer outcome (2026-10-12): did it succeed,
 * and what did it CONCLUDE — the result's substance, never the request
 * that produced it (Kimler: hover tips present conclusions). Failures
 * are detected by the loop's own conventions: an IoError outcome
 * object, or an `{ error }` result. Extractors cover the tools whose
 * result shapes are known; everything else falls back to the result's
 * most human field or a compact sketch.
 */
const summarizeToolResult = (tool: string, result: unknown): { ok: boolean; conclusion: string } => {
  const trunc = (s: string, n = 240): string => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s)
  const firstLines = (s: string): string =>
    trunc(s.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(0, 2).join(" "))
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>
    if (r["_tag"] === "IoError") {
      return { ok: false, conclusion: trunc(`Failed: ${typeof r["reason"] === "string" ? r["reason"] : "I/O error"}`) }
    }
    if (typeof r["error"] === "string") {
      return { ok: false, conclusion: trunc(`Failed: ${r["error"]}`) }
    }
  }
  if (typeof result === "string") return { ok: true, conclusion: firstLines(result) }
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>
    const s = (k: string): string | undefined => (typeof r[k] === "string" ? (r[k] as string) : undefined)
    switch (tool) {
      case "knowledge.list": {
        const cards = Array.isArray(r["cards"]) ? r["cards"] : []
        return { ok: true, conclusion: `${cards.length} reference card(s) in the store` }
      }
      case "knowledge.write":
        return { ok: true, conclusion: `Saved reference card "${s("slug") ?? "?"}"` }
      case "knowledge.read":
        return { ok: true, conclusion: firstLines(s("content") ?? "") || `Read card "${s("slug") ?? "?"}"` }
      case "project.list": {
        const ps = Array.isArray(r["projects"]) ? r["projects"] : []
        return { ok: true, conclusion: `${ps.length} project(s) exist` }
      }
      case "project.create": {
        const p = r["project"] as { name?: unknown } | undefined
        return { ok: true, conclusion: `Project "${typeof p?.name === "string" ? p.name : "?"}" created and active` }
      }
      case "project.declare": {
        const a = r["active"] as { name?: unknown } | undefined
        return { ok: true, conclusion: `Active project: ${typeof a?.name === "string" ? a.name : "?"}` }
      }
      case "research.status": {
        const runs = Array.isArray(r["runs"]) ? r["runs"] : []
        const latest = runs[0] as { status?: unknown } | undefined
        return {
          ok: true,
          conclusion: runs.length === 0 ? "No research runs in this project yet" : `${runs.length} run(s); latest: ${typeof latest?.status === "string" ? latest.status : "?"}`
        }
      }
      case "job.spawn":
        return { ok: true, conclusion: `Background job started (${s("jobId") ?? "?"})` }
      case "capability.request":
        return {
          ok: true,
          conclusion: r["recorded"] === false ? `Request already on file: ${s("capability") ?? tool}` : `Capability requested: ${s("capability") ?? tool}`
        }
      case "doc.read":
        return { ok: true, conclusion: firstLines(s("content") ?? "") || `Read ${s("path") ?? "file"}` }
      case "doc.write": {
        const chars = typeof r["chars"] === "number" ? r["chars"] : 0
        return { ok: true, conclusion: `${r["existed"] === true ? "Updated" : "Wrote"} ${s("path") ?? "file"} (${chars} chars)` }
      }
      case "drawer.preview":
        return { ok: true, conclusion: `Showing "${s("title") ?? s("id") ?? "document"}"` }
      default: {
        const pick = s("message") ?? s("summary") ?? s("title") ?? s("now") ?? s("path") ?? s("slug")
        return { ok: true, conclusion: pick !== undefined ? trunc(pick) : trunc(JSON.stringify(result) ?? "") }
      }
    }
  }
  return { ok: true, conclusion: result === undefined ? "Done" : trunc(String(result)) }
}

export const createChatStreams = (
  engine: DesktopEngine,
  onSettled?: (streamId: string, text: string) => Promise<ChatChannelsResult | undefined>,
  trace?: TraceWriter
): ChatStreams => {
  const active = new Map<string, AsyncIterator<ChatChunk>>()

  const start: ChatStreams["start"] = (sessionId, input, push, images) => {
    const streamId = randomUUID()
    if (active.has(streamId)) throw new Error(`chat stream id collision: ${streamId}`)
    const startMs = Date.now()
    const iterator = engine.chatStream(sessionId, input, images)[Symbol.asyncIterator]()
    active.set(streamId, iterator)
    console.log(`[aimy] chat.start: stream=${streamId} session=${sessionId} inputLen=${input.length} images=${images?.length ?? 0}`)
    trace?.log("main", streamId, "chat.start", { sessionId, inputLen: input.length, interrupted: input.startsWith("[AIMY-INTERRUPTED]\n") })
    void (async (): Promise<void> => {
      let text = ""
      let tokenCount = 0
      let firstTokenMs: number | undefined
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) break
          if (next.value._tag === "Token") {
            if (firstTokenMs === undefined) {
              firstTokenMs = Date.now() - startMs
              trace?.log("main", streamId, "chat.first_token", { latencyMs: firstTokenMs })
            }
            text += next.value.delta
            tokenCount += 1
            push({ _tag: "chat.token", streamId, delta: next.value.delta })
          } else {
            console.log(`[aimy] chat.chunk: stream=${streamId} tag=${next.value._tag}`)
            trace?.log("main", streamId, "chat.chunk", { tag: next.value._tag })
            // ToolCall chunks carry a COMPLETED call with its result
            // (2026-10-12): forward the outcome so the renderer's footer
            // tag can land green/red with a conclusion tooltip. (Before
            // this, the chunk was logged and dropped.)
            if (next.value._tag === "ToolCall") {
              const outcome = summarizeToolResult(next.value.tool, next.value.result)
              console.log(`[aimy] chat.tool: stream=${streamId} tool=${next.value.tool} ok=${outcome.ok}`)
              trace?.log("main", streamId, "chat.tool", { tool: next.value.tool, ok: outcome.ok })
              push({ _tag: "chat.tool", streamId, tool: next.value.tool, ok: outcome.ok, conclusion: outcome.conclusion })
            }
          }
          // The Done chunk has no IPC event — chat.done below carries
          // the terminal state.
        }
        console.log(`[aimy] chat.done: stream=${streamId} tokens=${tokenCount} textLen=${text.length}`)
        trace?.log("main", streamId, "chat.done", { tokens: tokenCount, textLen: text.length, totalMs: Date.now() - startMs, text: text.slice(0, 2000) })
        // A cancelled stream is already gone from the map: no `done` after
        // a cancel, so the renderer never sees terminal state twice.
        if (active.has(streamId)) {
          push({ _tag: "chat.done", streamId, outputTokens: tokenCount })
          if (onSettled !== undefined) {
            const channels = await onSettled(streamId, text).catch(() => undefined)
            if (channels !== undefined) push({ _tag: "chat.channels", channels })
          }
        } else {
          console.log(`[aimy] chat.done: stream=${streamId} was cancelled, skipping done event`)
          trace?.log("main", streamId, "chat.done_cancelled", {})
        }
      } catch (error) {
        console.error(`[aimy] chat.error: stream=${streamId} error=${String(error)}`)
        if (trace !== undefined) traceError(trace, "main", streamId, "chat.stream", error)
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
    if (iterator === undefined) {
      // Idempotent: cancelling an already-finished stream is a no-op, not an error.
      // The renderer's cleanup finalizer fires cancel on subscription end, which races
      // stream completion. Logging at debug level keeps the log useful.
      console.debug(`[aimy] chat.cancel: stream ${streamId} already gone (race, ignoring)`)
      return
    }
    trace?.log("main", streamId, "chat.cancel", { reason: "renderer requested" })
    active.delete(streamId)
    await iterator.return?.()
  }

  return { start, cancel, activeIds: () => [...active.keys()] }
}

// ── Wake ritual (2026-10-11) ────────────────────────────────────────────────

/**
 * Marker prepended to the wake turn's input. `loop.ts` strips it — it never
 * reaches the model. Same pattern as `[AIMY-INTERRUPTED]`.
 */
const WAKE_MARKER = "[AIMY-WAKE]\n"

/** Sessions that have already had their wake turn this process lifetime. */
const wokenSessions = new Set<string>()

/** True when she's written anything beyond the seed ownership comment. */
const journalHasContent = (): boolean => {
  try {
    const file = path.join(os.homedir(), ".aimy", "journal.md")
    if (!fs.existsSync(file)) return false
    const text = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim()
    return text.length > 0
  } catch {
    return false
  }
}

/**
 * Run her silent wake turn: she reads her journal and settles before he
 * speaks. Drained here — tokens are discarded, nothing is pushed to the
 * renderer. Awaited by `chat.send` so she wakes up BEFORE his first
 * message is processed. Only runs when her journal has content; non-fatal
 * (the user's turn proceeds regardless of the outcome).
 */
const runWakeTurnIfNeeded = async (deps: IpcWireDeps, sessionId: string): Promise<void> => {
  if (wokenSessions.has(sessionId)) return
  wokenSessions.add(sessionId) // mark first — avoids races on concurrent sends
  if (!journalHasContent()) return
  const now = new Date()
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })
  const wakePrompt =
    `Current date and time: ${dateStr}, ${timeStr}.\n\n` +
    `You awaken in a new thread. Read your journal above and remember who you are — ` +
    `what you were carrying, what was left open, how he leaves you feeling. ` +
    `If the transition brings something up, update your journal with journal.write. ` +
    `Then rest quietly — respond briefly, as if to yourself. You will speak when he does.`
  const wakeStreamId = `wake-${sessionId}`
  console.log(`[aimy] wake turn: session=${sessionId} (journal has content)`)
  deps.trace.log("main", wakeStreamId, "wake.start", { sessionId })
  const startMs = Date.now()
  try {
    const iterator = deps.engine.chatStream(sessionId, WAKE_MARKER + wakePrompt)[Symbol.asyncIterator]()
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      // Silent — discarded, never pushed to the renderer.
    }
    console.log(`[aimy] wake turn: complete in ${Date.now() - startMs}ms`)
    deps.trace.log("main", wakeStreamId, "wake.done", { totalMs: Date.now() - startMs })
  } catch (error) {
    console.error(`[aimy] wake turn failed (non-fatal): ${error instanceof Error ? error.message : error}`)
    deps.trace.log("main", wakeStreamId, "wake.error", { error: error instanceof Error ? error.message : String(error) })
  }
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
  /** Enqueue text for TTS narration; returns narration id. Reuses the NarrationQueue. */
  readonly narrate: (text: string) => string
  /** Stop narration and clear the queue (on user interruption). */
  readonly stopNarration: () => void
  /** Debug trace writer (2026-10-11); no-op unless debugTrace is on. */
  readonly trace: TraceWriter
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
      // Images (2026-10-11: drag-and-drop vision).
      const rawImages = (payload as { images?: unknown }).images
      const images = Array.isArray(rawImages)
        ? (rawImages as ReadonlyArray<{ dataUrl: string; mimeType: string; name: string }>).map((img) => ({ ...img }))
        : undefined
      // Wake ritual (2026-10-11): first turn of a new session, when her
      // journal has content. She reads herself and settles before he speaks.
      // Awaited — she wakes up BEFORE his message is processed.
      await runWakeTurnIfNeeded(deps, sessionId)
      const streamId = deps.chatStreams.start(sessionId, input, (evt) =>
        ctx.sender.send("aimy:event", evt),
        images,
      )
      return { streamId }
    },
    // Debug trace (2026-10-11): renderer forwards one event; the writer
    // no-ops unless debugTrace is on. `fields` is sanitized by the writer.
    "trace.log": async (payload) => {
      const t = (payload as { trace?: unknown }).trace
      const e = (payload as { event?: unknown }).event
      const f = (payload as { fields?: unknown }).fields
      if (typeof t === "string" && typeof e === "string") {
        deps.trace.log("renderer", t, e, (f ?? {}) as Record<string, unknown>)
      }
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

    "tts.deleteVoice": async (payload) => {
      const { voiceId } = payload as { voiceId: string }
      await engine.run(
        Effect.gen(function* () {
          const http = yield* HttpClient
          const svc = yield* deps.tts.ttsService(http)
          yield* svc.deleteVoice(voiceId)
        })
      )
    },

    "tts.playVoiceSample": async (payload) => {
      const { voiceId } = payload as { voiceId: string }
      const audioBase64 = await engine.run(
        Effect.gen(function* () {
          const http = yield* HttpClient
          const svc = yield* deps.tts.ttsService(http)
          const voices = yield* svc.voices()
          const voice = voices.find((v) => v.id === voiceId)
          const name = voice?.name ?? "unnamed"
          const phrase = `Hey, this is a sample of the voice named ${name}`
          const wav = yield* svc.speak(phrase, voiceId)
          return Buffer.from(wav).toString("base64")
        })
      )
      return { audioBase64 }
    },

    "tts.testProvider": async () => {
      try {
        return await engine.run(
          Effect.gen(function* () {
            const http = yield* HttpClient
            const svc = yield* deps.tts.ttsService(http)
            return yield* svc.testProvider()
          })
        )
      } catch (e) {
        // Preserve the reason across IPC (TaggedErrors lose fields when serialized).
        const reason = e !== null && typeof e === "object" && "reason" in e
          ? String((e as { reason: unknown }).reason)
          : e instanceof Error ? e.message : String(e)
        throw new Error(`testProvider failed: ${reason}`)
      }
    },

    "tts.setVoiceDefault": async (payload) => {
      const { voiceId } = payload as { voiceId: string }
      await engine.run(
        Effect.gen(function* () {
          const http = yield* HttpClient
          const svc = yield* deps.tts.ttsService(http)
          yield* svc.setVoiceDefault(voiceId)
        })
      )
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
    "tts.speak": async (payload) => {
      const text = reqString(payload, "text")
      const trimmed = text.trim()
      if (trimmed === "") return
      // Reuse the narration queue: ordered synthesis + chat.audioChunk broadcast.
      deps.narrate(trimmed)
    },
    "tts.stop": async () => {
      // User interrupted: clear the narration queue so old content doesn't resume.
      // Called on new UserSentMessage to prevent post-interruption resume.
      deps.stopNarration()
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
    "stt.engineStatus": async () => {
      const { sttStatus } = await import("../main/stt-engine.js")
      return sttStatus()
    },
    "stt.installEngine": async (payload) => {
      const { engine } = payload as { engine: string }
      const { installSttEngine } = await import("../main/stt-engine.js")
      // Fire-and-forget: progress via events, like TTS install.
      void installSttEngine(engine, (progress) =>
        broadcast({ _tag: "stt.installProgress", progress })
      ).catch((e: unknown) =>
        broadcast({
          _tag: "stt.installProgress",
          progress: { phase: "error", message: e instanceof Error ? e.message : String(e) },
        })
      )
    },
    "stt.transcribe": async (payload) => {
      const { audioBase64, sampleRate } = payload as { audioBase64: string; sampleRate?: number }
      const { transcribeAudio } = await import("../main/stt-engine.js")
      return transcribeAudio(audioBase64, sampleRate ?? 16000)
    },
    "stt.test": async () => {
      const { testSttLatency } = await import("../main/stt-engine.js")
      // Don't broadcast test progress via installProgress — that would
      // flip the UI state to "installing". The button already shows
      // "Downloading model…" via sttTestRunning.
      return testSttLatency()
    },
    "providers.load": async () => {
      const { loadProviders } = await import("../main/providers.js")
      return loadProviders()
    },
    "providers.save": async (payload) => {
      const { registry } = payload as { registry: unknown }
      const { saveProviders } = await import("../main/providers.js")
      saveProviders(registry)
    },
    "providers.testConnection": async (payload) => {
      const { endpoint } = payload as { endpoint: string }
      // Node.js fetch (no CORS in main process).
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        const resp = await fetch(endpoint, { method: "GET", signal: controller.signal })
        clearTimeout(timeout)
        return { ok: true, status: resp.status }
      } catch (e) {
        clearTimeout(timeout)
        return { ok: false, error: e instanceof Error ? e.message : "Connection failed" }
      }
    },
    "providers.scanNetwork": async (payload) => {
      const { host } = payload as { host: string }
      const { appendFileSync } = await import("node:fs")
      const logFile = "/tmp/network-scans.txt"
      const log = (msg: string) => {
        const ts = new Date().toISOString()
        try {
          appendFileSync(logFile, `[${ts}] ${msg}\n`)
        } catch { /* logging must not break the scan */ }
      }
      
      log(`=== SCAN START === host=${host}`)
      const scanStart = Date.now()
      
      // Scan the /24 subnet for AI services (Node.js, no CORS).
      // Simple port-open detection — the user verifies via Test.
      const AI_PORTS = [
        { port: 11434, service: "Ollama" },
        { port: 1234, service: "LM Studio" },
        { port: 8000, service: "vLLM/Splash" },
        { port: 8080, service: "llama.cpp" },
        { port: 7860, service: "A1111" },
        { port: 8188, service: "ComfyUI" },
        { port: 8001, service: "TTS" },
        { port: 8002, service: "STT" },
      ]
      const parts = host.split(".")
      const subnet = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : "192.168.1"
      log(`Subnet: ${subnet}.0/24, ports: ${AI_PORTS.map((p) => p.port).join(",")}`)
      
      // Quick port check. Uses service-specific API paths where known,
      // falls back to root. Longer timeout (2s) for slow servers.
      // ANY HTTP response (even 404) means the port is open.
      const isPortOpen = async (h: string, port: number, timeoutMs: number): Promise<boolean> => {
        // Service-specific paths for more reliable detection.
        const apiPaths: Record<number, string> = {
          11434: "/api/tags",    // Ollama
          1234: "/v1/models",    // LM Studio
          8000: "/v1/models",    // vLLM/Splash
          8080: "/v1/models",    // llama.cpp
          7860: "/sdapi/v1/sd-models", // A1111
        }
        const path = apiPaths[port] ?? "/"
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
        try {
          // Try the API path first.
          try {
            const resp = await fetch(`http://${h}:${port}${path}`, {
              signal: controller.signal,
            })
            clearTimeout(timeout)
            log(`  OPEN: ${h}:${port}${path} (HTTP ${resp.status})`)
            return true
          } catch {
            // API path failed, try root.
          }
          const rootController = new AbortController()
          const rootTimeout = setTimeout(() => rootController.abort(), timeoutMs)
          try {
            const resp = await fetch(`http://${h}:${port}/`, {
              method: "GET",
              signal: rootController.signal,
            })
            clearTimeout(rootTimeout)
            clearTimeout(timeout)
            log(`  OPEN: ${h}:${port}/ (HTTP ${resp.status}, via root)`)
            return true
          } catch {
            clearTimeout(rootTimeout)
            throw new Error("both paths failed")
          }
        } catch (e) {
          clearTimeout(timeout)
          const msg = e instanceof Error ? e.message : String(e)
          if (h === "192.168.1.54") {
            log(`  CLOSED/TIMEOUT: ${h}:${port} (${msg})`)
          }
          return false
        }
      }
      
      // Try to get models from a host:port. Returns array of model names,
      // or null if it's not a valid AI service (error, 404, not JSON, etc.).
      // Lenient: accepts any JSON response, tries to extract model names.
      const getModels = async (h: string, port: number, timeoutMs: number): Promise<string[] | null> => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
        try {
          // Try OpenAI-compatible /v1/models first.
          try {
            const resp = await fetch(`http://${h}:${port}/v1/models`, { signal: controller.signal })
            if (resp.ok) {
              const data = await resp.json() as { data?: Array<{ id?: string; name?: string }> }
              clearTimeout(timeout)
              // Valid JSON response = valid AI service, even if format is unexpected.
              const models = (data.data ?? []).map((m) => m.id ?? m.name ?? "unknown").filter((n) => n !== "unknown")
              return models
            }
          } catch { /* try next */ }
          // Try Ollama /api/tags.
          try {
            const resp = await fetch(`http://${h}:${port}/api/tags`, { signal: controller.signal })
            if (resp.ok) {
              const data = await resp.json() as { models?: Array<{ name?: string }> }
              clearTimeout(timeout)
              const models = (data.models ?? []).map((m) => m.name ?? "unknown").filter((n) => n !== "unknown")
              return models
            }
          } catch { /* fall through */ }
          clearTimeout(timeout)
          return null // not a valid AI service
        } catch {
          clearTimeout(timeout)
          return null
        }
      }
      try {
        const found: Array<{ host: string; port: number; service: string }> = []
        // Single-phase scan: check each host for open AI ports.
        // Skips .1 and .254 (usually gateways). Continues on any error.
        const checkPorts = [11434, 1234, 8000, 8080, 7860, 8188]
        log(`Starting single-phase scan: 254 hosts, batch size 20`)
        for (let base = 1; base <= 254; base += 20) {
          const batchEnd = Math.min(base + 20, 255)
          log(`Batch ${base}-${batchEnd - 1}`)
          const batch: Array<Promise<void>> = []
          for (let i = base; i < batchEnd; i++) {
            // Skip gateway IPs.
            if (i === 1 || i === 254) continue
            const h = `${subnet}.${i}`
            batch.push(
              (async () => {
                try {
                  for (const { port, service } of AI_PORTS) {
                    try {
                      if (await isPortOpen(h, port, 2000)) {
                        found.push({ host: h, port, service })
                        log(`FOUND: ${service} at ${h}:${port}`)
                      }
                    } catch (e) {
                      log(`ERROR checking ${h}:${port}: ${e instanceof Error ? e.message : e}`)
                    }
                  }
                } catch (e) {
                  log(`ERROR checking host ${h}: ${e instanceof Error ? e.message : e}`)
                }
              })()
            )
          }
          try {
            await Promise.all(batch)
          } catch (e) {
            log(`ERROR in batch ${base}-${batchEnd - 1}: ${e instanceof Error ? e.message : e}`)
          }
          log(`Batch ${base}-${batchEnd - 1} complete, found so far: ${found.length}`)
        }
        const duration = Date.now() - scanStart
        log(`=== SCAN COMPLETE === duration=${duration}ms, found=${found.length}`)
        for (const f of found) {
          log(`  Result: ${f.service} — ${f.host}:${f.port}`)
        }
        if (found.length === 0) {
          log(`WARNING: No services found. Check if target hosts are reachable.`)
        }
        return { found }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Scan failed"
        log(`=== SCAN FAILED === ${msg}`)
        return { found: [], error: msg }
      }
    },
    "providers.listModels": async (payload) => {
      const { endpoint } = payload as { endpoint: string }
      // Try OpenAI-compatible /v1/models first, then Ollama /api/tags.
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        // Try /v1/models (OpenAI-compatible: LM Studio, vLLM, llama.cpp).
        try {
          const resp = await fetch(`${endpoint}/v1/models`, {
            signal: controller.signal,
          })
          if (resp.ok) {
            const data = (await resp.json()) as { data?: Array<{ id: string }> }
            const models = (data.data ?? []).map((m) => m.id).filter(Boolean)
            if (models.length > 0) {
              clearTimeout(timeout)
              return { models }
            }
          }
        } catch { /* try next */ }
        // Try /api/tags (Ollama).
        try {
          const resp = await fetch(`${endpoint}/api/tags`, {
            signal: controller.signal,
          })
          if (resp.ok) {
            const data = (await resp.json()) as { models?: Array<{ name: string }> }
            const models = (data.models ?? []).map((m) => m.name).filter(Boolean)
            clearTimeout(timeout)
            return { models }
          }
        } catch { /* fall through */ }
        clearTimeout(timeout)
        return { models: [], error: "No models endpoint found" }
      } catch (e) {
        clearTimeout(timeout)
        return { models: [], error: e instanceof Error ? e.message : "Failed to list models" }
      }
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
    "messaging.testMessage": async () => deps.messaging.testMessage(),
    "dev.rebuild": async () => {
      const { spawn } = await import("node:child_process")
      return new Promise((resolve) => {
        const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
        const updateScript = path.join(repoRoot, "core", "update")
        console.log(`[aimy] dev.rebuild: running ${updateScript}`)
        const proc = spawn("bash", [updateScript], {
          cwd: repoRoot,
          env: { ...process.env, AIMY_DEV: "1" },
        })
        let output = ""
        proc.stdout?.on("data", (d) => { output += d.toString() })
        proc.stderr?.on("data", (d) => { output += d.toString() })
        proc.on("close", (code) => {
          console.log(`[aimy] dev.rebuild: exited with code ${code}`)
          resolve({
            ok: code === 0,
            output: output.slice(-2000),
            ...(code !== 0 ? { error: `Update script exited with code ${code}` } : {}),
          })
        })
        proc.on("error", (err) => {
          resolve({ ok: false, output, error: err.message })
        })
      })
    },
    "shell.openExternal": async ({ url }) => {
      const { shell } = await import("electron")
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        console.warn(`[aimy] shell.openExternal: blocked non-http(s) URL`)
        return
      }
      await shell.openExternal(url)
    },
    // Drawer save-to-disk (2026-10-12). Writes ONLY under planning/ or
    // docs/ of the repo root; traversal is refused. The renderer never
    // gets raw filesystem access — this validated write is the whole API.
    "docs.save": async (payload) => {
      const docPath = reqString(payload, "path")
      const content = reqString(payload, "content")
      if (!docPath.startsWith("planning/") && !docPath.startsWith("docs/")) {
        throw new Error("aimy: docs.save only writes under planning/ or docs/")
      }
      if (docPath.includes("..")) {
        throw new Error("aimy: docs.save path traversal refused")
      }
      const repoRoot = process.env.AIMY_REPO_ROOT ?? process.cwd()
      const fullPath = path.join(repoRoot, docPath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content, "utf-8")
      console.log(`[aimy] docs.save: wrote ${docPath} (${content.length} chars)`)
      return { path: docPath }
    },
    // Drawer home panel (2026-10-12): read a document back (Continue),
    // assemble the home data (recents / pending requests / knowledge
    // cards) from the user's own stores, and dismiss a request. The
    // renderer never gets raw filesystem access — these validated,
    // read-scoped operations are the whole API.
    "docs.load": async (payload) => {
      const rawPath = reqString(payload, "path")
      const repoRoot = process.env.AIMY_REPO_ROOT ?? process.cwd()
      let docPath = rawPath
      if (!rawPath.startsWith("planning/") && !rawPath.startsWith("docs/")) {
        // A bare document name (chat document references carry the
        // name as shown): resolve it against the two document
        // roots in the order doc.list searches them. A name is a
        // single segment by construction — separators and
        // traversal stay refused, so the read scope cannot widen.
        if (rawPath.includes("/") || rawPath.includes("..") || !rawPath.endsWith(".md")) {
          throw new Error("aimy: docs.load only reads under planning/ or docs/")
        }
        const hit = ["planning", "docs"].find((dir) => fs.existsSync(path.join(repoRoot, dir, rawPath)))
        if (hit === undefined) {
          throw new Error(`aimy: docs.load no document named ${rawPath} under planning/ or docs/`)
        }
        docPath = `${hit}/${rawPath}`
        console.log(`[aimy] docs.load: resolved ${rawPath} -> ${docPath}`)
      }
      if (docPath.includes("..")) {
        throw new Error("aimy: docs.load path traversal refused")
      }
      const content = fs.readFileSync(path.join(repoRoot, docPath), "utf-8")
      console.log(`[aimy] docs.load: read ${docPath} (${content.length} chars)`)
      return { path: docPath, content }
    },
    "home.data": async () => {
      const repoRoot = process.env.AIMY_REPO_ROOT ?? process.cwd()
      const aimyHome = path.join(os.homedir(), ".aimy")
      // Continue: markdown under planning/ + docs/, most recently
      // modified first; title from the first heading when present.
      const recents: Array<{ path: string; title: string; at: number }> = []
      for (const dir of ["planning", "docs"]) {
        let names: Array<string> = []
        try {
          names = fs.readdirSync(path.join(repoRoot, dir))
        } catch {
          names = []
        }
        for (const name of names) {
          if (!name.endsWith(".md")) continue
          const rel = `${dir}/${name}`
          try {
            const st = fs.statSync(path.join(repoRoot, rel))
            const head = fs.readFileSync(path.join(repoRoot, rel), "utf-8").slice(0, 2000)
            const heading = head.split("\n").map((l) => l.trim()).find((l) => l.startsWith("# "))
            const title = heading !== undefined
              ? heading.replace(/^#\s+/, "").slice(0, 80)
              : name.replace(/\.md$/, "").replace(/-/g, " ")
            recents.push({ path: rel, title, at: Math.round(st.mtimeMs) })
          } catch {
            // Unreadable file: not a recent, skip silently.
          }
        }
      }
      recents.sort((a, b) => b.at - a.at)
      // Needs you: pending capability requests, newest first.
      const requests: Array<{ capability: string; why: string; at: string }> = []
      try {
        const raw = fs.readFileSync(path.join(aimyHome, "capability-requests.jsonl"), "utf-8")
        for (const line of raw.split("\n")) {
          if (line.trim() === "") continue
          try {
            const r = JSON.parse(line) as { capability?: unknown; why?: unknown; at?: unknown; status?: unknown; probeNote?: unknown }
            if (r.status === "pending" && typeof r.capability === "string" && typeof r.at === "string") {
              // A failed preflight rides the card as evidence (2026-10-12):
              // Needs You then means "blocked, and we know why".
              const baseWhy = typeof r.why === "string" ? r.why.slice(0, 300) : ""
              const why = typeof r.probeNote === "string" && r.probeNote !== ""
                ? `${baseWhy}\nPreflight check failed: ${r.probeNote}`.slice(0, 420)
                : baseWhy
              requests.push({
                capability: r.capability,
                why,
                at: r.at,
              })
            }
          } catch {
            // Malformed line: skip, never fail the whole panel.
          }
        }
      } catch {
        // No requests file yet: an empty queue is a fine answer.
      }
      requests.reverse()
      // What she knows: the shared knowledge store's index.
      const cards: Array<{ slug: string; title: string; whenToUse: string; proven: number; updated: string }> = []
      try {
        const index = fs.readFileSync(path.join(aimyHome, "knowledge", "INDEX.md"), "utf-8")
        for (const rawLine of index.split("\n")) {
          const line = rawLine.trim()
          if (!line.startsWith("- ") || !line.includes("cards/")) continue
          const seg = line.slice(2).split(" · ")
          const headParts = (seg[0] ?? "").split(" — ")
          const slug = (headParts[0] ?? "").trim()
          if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue
          const provenMatch = line.match(/proven:\s*(\d+)/)
          const updatedMatch = line.match(/updated:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/)
          cards.push({
            slug,
            title: (headParts[1] ?? slug).trim(),
            whenToUse: headParts.slice(2).join(" — ").trim(),
            proven: provenMatch !== null ? Number(provenMatch[1]) : 0,
            updated: updatedMatch !== null ? updatedMatch[1]! : "",
          })
        }
      } catch {
        // No knowledge store yet: no cards.
      }
      // Project: the ACTIVE project's identity, goals, assets, and
      // research runs (Projects v1, 2026-10-12). Read defensively from
      // the user's own store — a missing/corrupt store is a null
      // section, never a failed panel.
      const projectList: Array<{ id: string; name: string; isDefault: boolean }> = []
      let project: {
        id: string; name: string; purpose: string; isDefault: boolean
        goals: Array<string>
        assets: Array<{ kind: string; title: string; role: string; path?: string; addedAt: string }>
        runs: Array<{
          runId: string; query: string; mode: string; depth: string; status: string; stage: string
          startedAt: string; finishedAt?: string
          counters: { searches: number; fetches: number; claims: number; clusters: number; rounds: number }
          etaMs: number | null; deliverableTitle: string; deliverablePath: string | null; termination?: string
        }>
      } | null = null
      try {
        const projectsDir = path.join(aimyHome, "projects")
        const index = JSON.parse(fs.readFileSync(path.join(projectsDir, "index.json"), "utf-8")) as {
          activeProjectId?: unknown
          projects?: unknown
        }
        // Switcher list (2026-10-12): every project's id + display name.
        const rawIndexProjects = Array.isArray(index.projects) ? index.projects : []
        for (const entry of rawIndexProjects) {
          if (typeof entry !== "object" || entry === null) continue
          const e = entry as Record<string, unknown>
          if (typeof e["id"] !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(e["id"])) continue
          let name = typeof e["name"] === "string" ? e["name"] : e["id"]
          try {
            const rec = JSON.parse(fs.readFileSync(path.join(projectsDir, e["id"], "project.json"), "utf-8")) as { name?: unknown }
            if (typeof rec.name === "string") name = rec.name
          } catch {
            // Fall back to the index entry's name.
          }
          projectList.push({ id: e["id"], name, isDefault: e["id"] === "default" })
        }
        const activeId = typeof index.activeProjectId === "string" && /^[a-z0-9][a-z0-9-]*$/.test(index.activeProjectId)
          ? index.activeProjectId
          : "default"
        const record = JSON.parse(fs.readFileSync(path.join(projectsDir, activeId, "project.json"), "utf-8")) as {
          name?: unknown; purpose?: unknown; goals?: unknown; assets?: unknown
        }
        const rawAssets = Array.isArray(record.assets) ? record.assets : []
        const assets = rawAssets.flatMap((a) => {
          if (typeof a !== "object" || a === null) return []
          const o = a as Record<string, unknown>
          if (typeof o["title"] !== "string" || typeof o["kind"] !== "string") return []
          return [{
            kind: o["kind"] as string,
            title: o["title"] as string,
            role: typeof o["role"] === "string" ? o["role"] : "reference",
            ...(typeof o["path"] === "string" ? { path: o["path"] } : {}),
            addedAt: typeof o["addedAt"] === "string" ? o["addedAt"] : ""
          }]
        })
        // Deliverables first, then most recent; the panel shows a few.
        assets.sort((x, y) => (x.role === y.role ? (x.addedAt < y.addedAt ? 1 : -1) : x.role === "deliverable" ? -1 : 1))
        const runs: Array<{
          runId: string; query: string; mode: string; depth: string; status: string; stage: string
          startedAt: string; finishedAt?: string
          counters: { searches: number; fetches: number; claims: number; clusters: number; rounds: number }
          etaMs: number | null; deliverableTitle: string; deliverablePath: string | null; termination?: string
        }> = []
        try {
          for (const name of fs.readdirSync(path.join(projectsDir, activeId, "research"))) {
            try {
              const raw = JSON.parse(fs.readFileSync(path.join(projectsDir, activeId, "research", name, "run.json"), "utf-8")) as Record<string, unknown>
              const counters = (raw["counters"] ?? {}) as Record<string, unknown>
              const deliverable = (raw["deliverable"] ?? {}) as Record<string, unknown>
              const num = (v: unknown): number => (typeof v === "number" ? v : 0)
              runs.push({
                runId: typeof raw["runId"] === "string" ? raw["runId"] : name,
                query: typeof raw["query"] === "string" ? raw["query"] : "(unknown query)",
                mode: typeof raw["mode"] === "string" ? raw["mode"] : "answer",
                depth: typeof raw["depth"] === "string" ? raw["depth"] : "standard",
                status: typeof raw["status"] === "string" ? raw["status"] : "unknown",
                stage: typeof raw["stage"] === "string" ? raw["stage"] : "",
                startedAt: typeof raw["startedAt"] === "string" ? raw["startedAt"] : "",
                ...(typeof raw["finishedAt"] === "string" ? { finishedAt: raw["finishedAt"] } : {}),
                counters: {
                  searches: num(counters["searches"]), fetches: num(counters["fetches"]),
                  claims: num(counters["claims"]), clusters: num(counters["clusters"]), rounds: num(counters["rounds"])
                },
                etaMs: typeof raw["etaMs"] === "number" ? raw["etaMs"] : null,
                deliverableTitle: typeof deliverable["title"] === "string" ? deliverable["title"] : "",
                deliverablePath: typeof deliverable["path"] === "string" ? deliverable["path"] : null,
                ...(typeof raw["termination"] === "string" ? { termination: raw["termination"] } : {})
              })
            } catch {
              // One unreadable run record: skip it, keep the panel.
            }
          }
        } catch {
          // No research directory yet: no runs.
        }
        runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        project = {
          id: activeId,
          name: typeof record.name === "string" ? record.name : activeId,
          purpose: typeof record.purpose === "string" ? record.purpose : "",
          isDefault: activeId === "default",
          goals: Array.isArray(record.goals) ? record.goals.filter((g): g is string => typeof g === "string") : [],
          assets: assets.slice(0, 8),
          runs: runs.slice(0, 6)
        }
      } catch {
        project = null
      }
      // Mirror Field feeds (2026-10-13): past conversations from
      // their session records, and thread memories from her
      // thread-history — the field's chat and memory nodes are made
      // of these. Fail-soft throughout: a missing store is an empty
      // list, never a broken home panel.
      const chats: Array<{ id: string; subject: string; at: number; messages: number }> = []
      try {
        const sessDir = path.join(aimyHome, "memory", "sessions")
        const files = fs.readdirSync(sessDir)
          .filter((n) => n.startsWith("session-") && n.endsWith(".jsonl"))
          .map((n) => {
            try {
              return { n, m: fs.statSync(path.join(sessDir, n)).mtimeMs }
            } catch {
              return null
            }
          })
          .filter((x): x is { n: string; m: number } => x !== null)
          .sort((a, b) => b.m - a.m)
          .slice(0, 6)
        for (const f of files) {
          try {
            const raw = fs.readFileSync(path.join(sessDir, f.n), "utf-8")
            let subject = ""
            let messages = 0
            for (const line of raw.split("\n")) {
              if (!line.includes('"kind":"message"')) continue
              messages++
              if (subject === "") {
                try {
                  const rec = JSON.parse(line) as { payload?: { role?: unknown; text?: unknown; wake?: unknown } }
                  if (rec.payload?.role === "user" && rec.payload.wake !== true && typeof rec.payload.text === "string") {
                    subject = rec.payload.text.replace(/\s+/g, " ").trim().slice(0, 60)
                  }
                } catch {
                  // Malformed line: keep scanning for a subject.
                }
              }
            }
            if (messages > 0) {
              chats.push({
                id: f.n.replace(/\.jsonl$/, ""),
                subject: subject === "" ? "Conversation" : subject,
                at: Math.round(f.m),
                messages,
              })
            }
          } catch {
            // One unreadable session: skip it, keep the panel.
          }
        }
      } catch {
        // No sessions directory yet: no chats.
      }
      const memories: Array<{ sessionId: string; summary: string; messageCount: number; archivedAt: number }> = []
      try {
        const raw = fs.readFileSync(path.join(aimyHome, "thread-history.json"), "utf-8")
        const arr = JSON.parse(raw) as Array<{ sessionId?: unknown; summary?: unknown; messageCount?: unknown; archivedAt?: unknown }>
        const valid = arr.filter(
          (e): e is { sessionId: string; summary: string; messageCount?: unknown; archivedAt: number } =>
            typeof e.sessionId === "string" && typeof e.summary === "string" && typeof e.archivedAt === "number"
        )
        valid.sort((a, b) => b.archivedAt - a.archivedAt)
        for (const e of valid.slice(0, 6)) {
          memories.push({
            sessionId: e.sessionId,
            summary: e.summary.slice(0, 300),
            messageCount: typeof e.messageCount === "number" ? e.messageCount : 0,
            archivedAt: e.archivedAt,
          })
        }
      } catch {
        // No thread history yet: no memories.
      }
      // The journal's metadata — never its content (2026-10-13). The
      // journal is the entity's private page: the dash may know it
      // exists and when it last changed. The file is read only to
      // count it; nothing of what it says leaves this process.
      let journal: { updatedAt: number; chars: number } | null = null
      try {
        const jp = path.join(aimyHome, "journal.md")
        const st = fs.statSync(jp)
        const text = fs.readFileSync(jp, "utf-8")
        journal = { updatedAt: Math.round(st.mtimeMs), chars: text.length }
      } catch {
        journal = null
      }
      console.log(`[aimy] home.data: recents=${recents.length} requests=${requests.length} cards=${cards.length} project=${project?.id ?? "none"} runs=${project?.runs.length ?? 0} projectList=${projectList.length} chats=${chats.length} memories=${memories.length} journal=${journal === null ? "none" : "yes"}`)
      return { recents: recents.slice(0, 8), requests: requests.slice(0, 6), cards, project, projectList, chats, memories, journal }
    },
    "home.requestDetail": async (payload) => {
      const capability = reqString(payload, "capability")
      const at = reqString(payload, "at")
      const file = path.join(os.homedir(), ".aimy", "capability-requests.jsonl")
      const raw = fs.readFileSync(file, "utf-8")
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue
        try {
          const r = JSON.parse(line) as { capability?: unknown; why?: unknown; at?: unknown; status?: unknown }
          if (r.status === "pending" && r.capability === capability && r.at === at) {
            const detail = {
              capability,
              why: typeof r.why === "string" ? r.why : "",
              at,
            }
            console.log(`[aimy] home.requestDetail: ${capability} (${at}) whyChars=${detail.why.length}`)
            return detail
          }
        } catch {
          // Malformed lines cannot match the requested record.
        }
      }
      throw new Error(`aimy: pending capability request not found: ${capability}`)
    },
    "home.dismissRequest": async (payload) => {
      const capability = reqString(payload, "capability")
      const at = reqString(payload, "at")
      const file = path.join(os.homedir(), ".aimy", "capability-requests.jsonl")
      let lines: Array<string> = []
      try {
        lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "")
      } catch {
        return
      }
      let changed = false
      const out = lines.map((line) => {
        try {
          const r = JSON.parse(line) as Record<string, unknown>
          if (r["capability"] === capability && r["at"] === at && r["status"] === "pending") {
            changed = true
            return JSON.stringify({ ...r, status: "dismissed" })
          }
        } catch {
          // Keep malformed lines untouched.
        }
        return line
      })
      if (changed) {
        fs.writeFileSync(file, out.join("\n") + "\n", "utf-8")
        console.log(`[aimy] home.dismissRequest: dismissed ${capability} (${at})`)
      }
    },
    // ── HomeDash (2026-10-13) ────────────────────────────────────────
    // The dash is a stage of widgets. Widget definitions live in
    // ~/.aimy/homedash/available/<id>/widget.json; enablement is a
    // link in ~/.aimy/homedash/enabled/ (systemd-style; a marker
    // file carrying the target path is the portable equivalent).
    // The three platform widgets seed on first list; user edits to
    // manifests and links are theirs and are never overwritten.
    "homedash.list": async () => {
      const aimyHome = path.join(os.homedir(), ".aimy")
      const hdRoot = path.join(aimyHome, "homedash")
      const availDir = path.join(hdRoot, "available")
      const enabDir = path.join(hdRoot, "enabled")
      fs.mkdirSync(availDir, { recursive: true })
      fs.mkdirSync(enabDir, { recursive: true })
      const BUNDLED: Record<string, Record<string, unknown>> = {
        workon: {
          id: "workon", name: "WorkOn", description: "The actionable layer: the active project, live jobs, what needs you.", version: "1.0.0", priority: 1000,
          settings: [
            { key: "showNeedsYou", type: "toggle", label: "Show what needs you", default: true },
            { key: "showJobs", type: "toggle", label: "Show running jobs", default: true },
          ],
        },
        globenews: {
          id: "globenews", name: "GlobeNews", description: "The vector earth: grab it, tilt it, watch the world on it.", version: "1.0.0", priority: 400,
          settings: [
            { key: "spinMinutes", type: "slider", label: "Spin — minutes per turn", min: 0.5, max: 6, step: 0.5, default: 2 },
            { key: "density", type: "select", label: "Dot density", options: ["calm", "rich"], default: "rich" },
            { key: "glowPx", type: "slider", label: "Rim glow reach (px)", min: 0, max: 40, step: 1, default: 20 },
            { key: "tiltDeg", type: "slider", label: "Tilt — disc-centre latitude", min: -60, max: 24, step: 1, default: -24 },
          ],
        },
        mindmap: {
          id: "mindmap", name: "MindMap", description: "The organism graph: projects, knowledge, memories. Recency flows downward.", version: "1.0.0", priority: 300,
          settings: [
            { key: "breeze", type: "toggle", label: "Breeze — living motion", default: true },
            { key: "labels", type: "toggle", label: "Permanent node labels", default: true },
          ],
        },
      }
      for (const [id, manifest] of Object.entries(BUNDLED)) {
        const dir = path.join(availDir, id)
        fs.mkdirSync(dir, { recursive: true })
        const f = path.join(dir, "widget.json")
        if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(manifest, null, 2), "utf-8")
      }
      if (fs.readdirSync(enabDir).length === 0) {
        for (const id of Object.keys(BUNDLED)) {
          const link = path.join(enabDir, id)
          try {
            fs.symlinkSync(path.join(availDir, id), link, "junction")
          } catch {
            fs.writeFileSync(link, path.join(availDir, id), "utf-8")
          }
        }
        console.log(`[aimy] homedash: seeded ${Object.keys(BUNDLED).length} bundled widgets + enable links`)
      }
      let values: Record<string, Record<string, unknown>> = {}
      try {
        values = JSON.parse(fs.readFileSync(path.join(hdRoot, "settings.json"), "utf-8")) as Record<string, Record<string, unknown>>
      } catch {
        values = {}
      }
      const widgets: Array<HomedashWidgetEntry> = []
      for (const entry of fs.readdirSync(enabDir)) {
        let dir = path.join(enabDir, entry)
        try {
          if (!fs.statSync(dir).isDirectory()) {
            const target = fs.readFileSync(dir, "utf-8").trim()
            if (target !== "") dir = target
          }
        } catch {
          continue
        }
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(dir, "widget.json"), "utf-8")) as Record<string, unknown>
          const id = typeof manifest["id"] === "string" ? (manifest["id"] as string) : entry
          const v = (values[id] ?? {}) as Record<string, unknown>
          const schema = Array.isArray(manifest["settings"]) ? (manifest["settings"] as Array<Record<string, unknown>>) : []
          // Saved values the manifest does not declare (the in-place
          // editor's geoX/geoY/geoW/geoH, future keys) must round-
          // trip too — a value that saves but never reads back is a
          // silent no-op. Priority stays a top-level field.
          const schemaKeys = new Set(schema.map((s) => String(s["key"])))
          const extraSettings: Array<HomedashSettingEntry> = Object.keys(v)
            .filter((k) => k !== "priority" && !schemaKeys.has(k))
            .map((k) => ({ key: k, type: "number", label: k, value: v[k] as string | number | boolean }))
          widgets.push({
            id,
            name: typeof manifest["name"] === "string" ? (manifest["name"] as string) : id,
            description: typeof manifest["description"] === "string" ? (manifest["description"] as string) : "",
            version: typeof manifest["version"] === "string" ? (manifest["version"] as string) : "0.0.0",
            priority: typeof v["priority"] === "number" ? (v["priority"] as number) : typeof manifest["priority"] === "number" ? (manifest["priority"] as number) : 500,
            settings: [
              ...schema.map((s): HomedashSettingEntry => ({
                key: String(s["key"]),
                type: String(s["type"]),
                label: String(s["label"]),
                value: (v[String(s["key"])] ?? s["default"]) as string | number | boolean,
                ...(typeof s["min"] === "number" ? { min: s["min"] as number } : {}),
                ...(typeof s["max"] === "number" ? { max: s["max"] as number } : {}),
                ...(typeof s["step"] === "number" ? { step: s["step"] as number } : {}),
                ...(Array.isArray(s["options"]) ? { options: s["options"] as Array<string> } : {}),
              })),
              ...extraSettings,
            ],
          })
        } catch {
          // A broken widget folder skips; the dash survives it.
        }
      }
      widgets.sort((a, b) => a.priority - b.priority)
      console.log(`[aimy] homedash.list: enabled=${widgets.map((w) => `${w.id}@${w.priority}`).join(",")}`)
      return { widgets }
    },
    "homedash.setSetting": async (payload) => {
      const widgetId = reqString(payload, "widgetId")
      const key = reqString(payload, "key")
      const value = (payload as Record<string, unknown>)["value"]
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error("homedash.setSetting: value must be a string, number, or boolean")
      }
      if (key === "priority" && (typeof value !== "number" || value < 1 || value > 1000)) {
        throw new Error("homedash.setSetting: priority must be a number 1-1000")
      }
      const aimyHome = path.join(os.homedir(), ".aimy")
      const hdRoot = path.join(aimyHome, "homedash")
      fs.mkdirSync(hdRoot, { recursive: true })
      const file = path.join(hdRoot, "settings.json")
      let values: Record<string, Record<string, unknown>> = {}
      try {
        values = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Record<string, unknown>>
      } catch {
        values = {}
      }
      values[widgetId] = { ...(values[widgetId] ?? {}), [key]: value }
      fs.writeFileSync(file, JSON.stringify(values, null, 2), "utf-8")
      console.log(`[aimy] homedash.setSetting: ${widgetId}.${key} = ${JSON.stringify(value)}`)
    },
    // ── Projects UI (2026-10-12) ─────────────────────────────────────
    // Direct-manipulation surface over the SAME store AImy's tools use
    // (agent-loop projects.ts) — the two paths can never disagree.
    "projects.list": async () => {
      const projects = storeListProjects()
      const active = storeGetActiveProject()
      console.log(`[aimy] projects.list: ${projects.length} project(s), active=${active.id}`)
      return {
        activeProjectId: active.id,
        projects: projects.map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, isDefault: p.isDefault, assetCount: p.assets.length }))
      }
    },
    "projects.create": async (payload) => {
      const { project, created } = storeCreateProject(payload.name, payload.purpose)
      storeSetActiveProject(project.id)
      console.log(`[aimy] projects.create: ${project.id} created=${created} (now active)`)
      return { id: project.id, name: project.name, created }
    },
    "projects.setActive": async (payload) => {
      const ok = storeSetActiveProject(payload.id)
      const active = storeGetActiveProject()
      console.log(`[aimy] projects.setActive: ${payload.id} ok=${ok}`)
      return { activeProjectId: active.id }
    },
    "projects.moveAsset": async (payload) => {
      const kinds = ["document", "paper", "brief", "research-run", "request", "card", "file"]
      if (!kinds.includes(payload.kind)) return { moved: false }
      const moved = storeMoveAsset(payload.fromId, payload.toId, {
        kind: payload.kind as StoreProjectAsset["kind"],
        title: payload.title,
        ...(typeof payload.path === "string" && payload.path !== "" ? { path: payload.path } : {})
      })
      console.log(`[aimy] projects.moveAsset: [${payload.kind}] "${payload.title}" ${payload.fromId} -> ${payload.toId} moved=${moved}`)
      return { moved }
    },
    "projects.addAsset": async (payload) => {
      const added = storeAddDocumentAsset(payload.projectId, payload.path, payload.title)
      console.log(`[aimy] projects.addAsset: ${payload.path} into ${payload.projectId} added=${added}`)
      return { added }
    },
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
  getDeps: (broadcast: (evt: IpcEvent) => void) => Promise<IpcWireDeps>
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
  const getDepsOnce = (): Promise<IpcWireDeps> => (depsPromise ??= getDeps(broadcast))

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
) => { readonly stop: () => void; readonly trace: TraceWriter } = (ipcMain, engine) => {
  // tts-server.py ships in the bundle next to the compiled output
  // (desktop:assets copies it to dist/tts/server/).
  const here = path.dirname(fileURLToPath(import.meta.url))
  const serverPy = path.resolve(here, "..", "..", "..", "tts", "server", "tts-server.py")
  let tts: TtsEngine | undefined
  // Debug trace (2026-10-11): session JSONL in ~/.aimy/traces/ when
  // debugTrace:true in ~/.aimy/desktop.json. Returned so main.ts can
  // forward renderer console messages into it.
  const trace = createTraceWriter(readDesktopConfig().debugTrace === true)

  registerIpcWithDeps(ipcMain, engine, async (broadcast) => {
    const services = await bootDesktopServices()
    tts = makeTtsEngine({ serverPy })
    // TEST 2026-10-08: fanOutChannels disabled to isolate the pause culprit.
    // If the system pause goes away, the automatic TTS synthesis was the cause.
    const chatStreams = createChatStreams(engine, undefined, trace)

    // Voice narration queue: the `narrate` tool enqueues text here;
    // synthesized audio streams back as ordered `chat.audioChunk` events.
    const { NarrationQueue } = await import("../../../asc-channels/src/narration-queue.js")
    // OMA TTS client for narration (2026-10-10: was hardcoded to local :8001).
    const { omaSynthesize, OMA_TTS_PRESETS, dialVectorToParams } = await import("../../../tts/src/oma-client.js")
    // ASC dials → TTS params (2026-10-11: recalibrated safe ranges in oma-client.ts).
    // Uses neutral dials (5,5,5,5) → safe centers (0.4, 0.5, 0.65). No gibberish.
    // TODO: Read live dials from personality entity (~/.aimy/personality.json).
    const getTtsParams = async () => {
      try {
        const neutralDials = { warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 }
        const params = dialVectorToParams(neutralDials)
        console.log(`[aimy] narration: TTS params (neutral, safe): ${JSON.stringify(params)}`)
        return params
      } catch {
        return OMA_TTS_PRESETS.mid!
      }
    }
    const narrationQueue = new NarrationQueue(
      {
        synthesize: async (text: string): Promise<Uint8Array> => {
          console.log(`[aimy] narration synthesize: "${text.substring(0, 40)}..."`)
          // Try OMA Chatterbox-Turbo first (via tunnel), fall back to local :8001.
          // Read active provider from registry to respect user selection.
          let useOma = true
          try {
            const regPath = path.join(os.homedir(), ".aimy", "providers.json")
            const reg = JSON.parse(fs.readFileSync(regPath, "utf8")) as {
              activeId?: { tts?: string },
              providers?: Array<{ id: string; kind: string }>
            }
            const active = reg.providers?.find((p) => p.id === reg.activeId?.tts)
            useOma = active?.kind === "remote"
            console.log(`[aimy] narration: active TTS provider kind=${active?.kind ?? "unknown"}, useOma=${useOma}`)
          } catch {
            console.log(`[aimy] narration: could not read registry, defaulting to OMA`)
          }
          if (useOma) {
            try {
              const { Effect } = await import("effect")
              const synthStart = Date.now()
              const wav = await Effect.runPromise(
                omaSynthesize(
                  { http: undefined as never, baseUrl: "http://127.0.0.1:8777" },
                  text,
                  await getTtsParams()
                ) as Effect.Effect<Uint8Array, unknown>
              )
              const synthMs = Date.now() - synthStart
              // TTS MATH METHODOLOGY (2026-10-10)
              // ================================
              // We log these ratios on every synthesis to detect anomalies and
              // guide right-sized audio requests. All derived from first principles:
              //
              // ASSUMPTION: 24kHz 16-bit mono WAV = 48,000 bytes/sec.
              //   If the TTS model changes sample rate/bit depth, update the divisor.
              //
              // METRICS:
              //   audioSec = bytes / 48000 — predicted playback duration
              //   bytesPerChar = bytes / textLen — audio density
              //   secPerChar = audioSec / textLen — speaking pace (inverse of charsPerSec)
              //   charsPerSec = textLen / audioSec — speaking rate
              //   synthMsPerChar = synthMs / textLen — synthesis cost per char
              //
              // BASELINES (OMA Chatterbox Turbo, exaggeration=0.8, 2026-10-10):
              //   charsPerSec ≈ 5.7-6.3 (slow, expressive — exaggeration slows speech)
              //   bytesPerChar ≈ 7,500-8,500
              //   synthMsPerChar ≈ 40-60 (varies with GPU load)
              //
              // ANOMALY THRESHOLDS (tune as we collect data):
              //   charsPerSec < 4.0 → abnormally slow audio (possible TTS glitch)
              //   charsPerSec > 20 → abnormally fast (truncated or wrong model?)
              //   synthMsPerChar > 200 → synthesis struggling (GPU contention?)
              //   bytesPerChar > 12000 → audio much denser than expected
              //
              // RIGHT-SIZING: at ~6 chars/sec, target audio duration maps to:
              //   5 sec ≈ 30 chars | 10 sec ≈ 60 chars | 30 sec ≈ 180 chars
              //   Use this to chunk long text into appropriately-sized TTS requests
              //   instead of synthesizing huge blocks that play forever.
              //
              // TO ADJUST: change thresholds above and the debug-dump trigger below.
              // The debug dump (bytesPerChar > 6000) was calibrated before we knew
              // the true speaking rate — revisit once we have more samples.
              const audioSec = wav.length / 48000
              const bytesPerChar = wav.length / Math.max(1, text.length)
              const secPerChar = audioSec / Math.max(1, text.length)
              const charsPerSec = text.length / Math.max(0.001, audioSec)
              const synthPerChar = synthMs / Math.max(1, text.length)
              console.log(`[aimy] tts-math: textLen=${text.length} synthMs=${synthMs} audioBytes=${wav.length} audioSec=${audioSec.toFixed(1)} bytesPerChar=${bytesPerChar.toFixed(0)} secPerChar=${secPerChar.toFixed(3)} charsPerSec=${charsPerSec.toFixed(1)} synthMsPerChar=${synthPerChar.toFixed(1)}`)
              console.log(`[aimy] narration synthesize: OMA got ${wav.length} bytes`)
              trace.log("main", "session", "tts.synth_done", {
                engine: "oma", textLen: text.length, synthMs,
                audioBytes: wav.length, audioSec: Math.round(audioSec * 10) / 10,
                charsPerSec: Math.round(charsPerSec * 10) / 10,
                synthMsPerChar: Math.round(synthPerChar * 10) / 10,
              })
              // Debug dump (2026-10-10): when audio is abnormally long for text,
              // write to /tmp for inspection. Ghost 3 investigation.
              // NOTE: bytesPerChar already computed above; threshold of 6000 was
              // calibrated before we knew the true speaking rate (~8000 is normal
              // for exaggeration=0.8). Revisit per TTS MATH METHODOLOGY above.
              if (bytesPerChar > 6000) {
                try {
                  const dumpPath = `/tmp/aimy-tts-debug-${Date.now()}.wav`
                  fs.writeFileSync(dumpPath, Buffer.from(wav))
                  console.log(`[aimy] narration DEBUG DUMP: ${dumpPath} (${wav.length} bytes for ${text.length} chars)`)
                } catch (e) {
                  console.error(`[aimy] narration debug dump failed: ${e instanceof Error ? e.message : e}`)
                }
              }
              return wav
            } catch (e) {
              console.log(`[aimy] narration synthesize: OMA failed (${e instanceof Error ? e.message : e}), falling back to local`)
            }
          }
          // Local fallback (original path).
          const res = await fetch("http://127.0.0.1:8001/speak", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, voice_id: "default" })
          })
          if (!res.ok) throw new Error(`TTS synthesize failed: ${res.status}`)
          const data = (await res.json()) as { audio_base64?: string; error?: string }
          if (data.error !== undefined) throw new Error(data.error)
          if (data.audio_base64 === undefined) throw new Error("TTS returned no audio")
          const bin = atob(data.audio_base64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          console.log(`[aimy] narration synthesize: local got ${bytes.length} bytes`)
          return bytes
        }
      },
      (audio) => {
        console.log(`[aimy] narration audio ready: id=${audio.id} seq=${audio.sequence} bytes=${audio.audio.length}`)
        // Emit ordered audio chunk to renderers for gapless playback.
        // NOTE (2026-10-10): First-view-first-hear coordination was attempted
        // via a 400ms hold, but the renderer bubbleReady signal was never wired.
        // Removed the hold — it added latency without solving the race.
        // Proper fix needs renderer to signal bubble readiness via IPC.
        const b64 = Buffer.from(audio.audio).toString("base64")
        trace.log("main", audio.id, "ipc.audioChunk", { seq: audio.sequence, byteLen: audio.audio.length })
        broadcast({
          _tag: "chat.audioChunk",
          streamId: "narration",
          sequence: audio.sequence,
          audioBase64: b64
        } as never)
        console.log(`[aimy] narration audioChunk broadcast`)
      },
      (id, reason) => {
        console.error(`[aimy] narration ${id} failed: ${reason}`)
        trace.log("main", id, "narrate.failed", { reason })
      }
    )
    // Wire the queue into the agent loop's narration sink.
    engine.setNarrationSink((text: string) => {
      trace.log("main", "session", "narrate.enqueue", { text, textLen: text.length })
      return narrationQueue.enqueue(text)
    })
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
      tts,
      narrate: (text: string) => narrationQueue.enqueue(text),
      stopNarration: () => {
        trace.log("main", "session", "narrate.clear", { reason: "user interruption (StopNarration)" })
        narrationQueue.clear()
      },
      trace,
    }
  })

  return {
    stop: () => {
      try { tts?.stopServer() } catch { /* ignore */ }
    },
    trace,
  }
}
