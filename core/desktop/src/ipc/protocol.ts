/**
 * desktop/src/ipc/protocol.ts — THE IPC contract. Shared by main, preload,
 * and the renderer. Track 1 defines it; Track 2 implements the handlers and
 * the preload against it.
 *
 * Conventions:
 * - Commands are renderer→main request/response (one response per command).
 * - Streaming (chat) is by `streamId` + events: `chat.send` returns a
 *   `streamId`; tokens arrive as `chat.token` events; terminal state as
 *   `chat.done` / `chat.error`. `chat.cancel` interrupts the stream — the
 *   main side implements it by calling `return()` on the engine's
 *   `AsyncIterable` (fiber interrupt, no post-cancel side effects).
 * - Payload types are the REAL service types wherever the service exports
 *   them (`Banner`, `DialVector`, `LearningNode`, `JobDescriptor`) —
 *   never hand-rolled placeholders.
 * - Everything crossing the bridge must be JSON-serializable (Electron
 *   structured clone handles the rest).
 */
import type { Banner } from "../../../comms/index.js"
import type { DialVector } from "../../../asc-engine/index.js"
import type { LearningNode } from "../../../learning/src/index.js"
import type { JobDescriptor, JobStatus } from "../../../jobs/src/index.js"

// ── Commands (renderer → main, request/response) ────────────────────────────

export interface ChatSendResult {
  readonly streamId: string
}

export interface BannersListResult {
  readonly banners: ReadonlyArray<Banner>
}

export interface SovereigntyToggle {
  readonly key: string
  readonly enabled: boolean
}

export interface SovereigntyListResult {
  readonly toggles: ReadonlyArray<SovereigntyToggle>
}

export interface JobsListResult {
  readonly jobs: ReadonlyArray<JobDescriptor>
  readonly statuses: Record<string, JobStatus>
}

export interface TimelineListResult {
  readonly nodes: ReadonlyArray<LearningNode>
}

export interface DesktopConfigView {
  readonly baseUrl: string
  readonly model: string
}

export interface ExportRunResult {
  /** Where the export bundle was written (Track 2 resolves the path). */
  readonly bundlePath: string
  /**
   * The integrity receipt the main side produced and verified (SHA-256 per
   * file + verifyBundle re-read), when the handler exposes it. M10 Track 3
   * addition (2026-10-07): optional so existing handlers keep compiling —
   * the renderer shows the receipt ONLY when present and fails closed
   * ("receipt not exposed over IPC") when absent, never a fabricated one.
   */
  readonly receipt?: ExportReceiptShape | undefined
}

/** The receipt fields the renderer needs to display a verified export. */
export interface ExportReceiptShape {
  readonly exportedAt: string
  readonly instanceId: string
  readonly exporterVersion: string
  readonly files: Record<string, string>
  readonly bundleHash: string
}

/**
 * Commands the renderer may invoke. Each variant's `_tag` is the IPC channel
 * name; the response is the paired `*Result` (or `void`) below.
 */
export type IpcCommand =
  | { _tag: "chat.send"; sessionId: string; input: string }
  | { _tag: "chat.cancel"; streamId: string }
  | { _tag: "banners.list" }
  | { _tag: "banners.dismiss"; id: string }
  | { _tag: "asc.readDials" }
  | { _tag: "asc.tune"; dial: string; target: number }
  | { _tag: "sovereignty.list" }
  | { _tag: "sovereignty.set"; key: string; value: boolean }
  | { _tag: "export.run" }
  | { _tag: "jobs.list" }
  | { _tag: "jobs.runNow"; id: string }
  | { _tag: "timeline.list" }
  | { _tag: "config.get" }
  | { _tag: "config.set"; baseUrl: string; model: string }

/** The response type for each command tag (index for Track 2's handler table). */
export interface IpcResponse {
  "chat.send": ChatSendResult
  "chat.cancel": void
  "banners.list": BannersListResult
  "banners.dismiss": void
  "asc.readDials": DialVector
  "asc.tune": DialVector
  "sovereignty.list": SovereigntyListResult
  "sovereignty.set": void
  "export.run": ExportRunResult
  "jobs.list": JobsListResult
  "jobs.runNow": void
  "timeline.list": TimelineListResult
  "config.get": DesktopConfigView
  "config.set": void
}

/** Helper: response type for a given command. */
export type IpcCommandResult<C extends IpcCommand> = IpcResponse[C["_tag"]]

// ── Events (main → renderer, pushed) ────────────────────────────────────────

export type IpcEvent =
  | { _tag: "chat.token"; streamId: string; delta: string }
  | { _tag: "chat.done"; streamId: string }
  | { _tag: "chat.error"; streamId: string; error: string }
  | { _tag: "banner.published"; banner: Banner }
  | { _tag: "asc.dialsUpdated"; dials: DialVector }

/** The set of channel names the preload allowlists. Nothing else crosses. */
export const IPC_COMMAND_TAGS = [
  "chat.send",
  "chat.cancel",
  "banners.list",
  "banners.dismiss",
  "asc.readDials",
  "asc.tune",
  "sovereignty.list",
  "sovereignty.set",
  "export.run",
  "jobs.list",
  "jobs.runNow",
  "timeline.list",
  "config.get",
  "config.set"
] as const

export const IPC_EVENT_TAGS = [
  "chat.token",
  "chat.done",
  "chat.error",
  "banner.published",
  "asc.dialsUpdated"
] as const

// ── Bridge (preload ↔ renderer) ─────────────────────────────────────────────

/**
 * The EXACT `window.aimy` API the preload exposes (Track 2). The renderer
 * gets this and nothing else: `invoke` for request/response commands,
 * `subscribe` for pushed events. Both sides (preload.ts, ipc/client.ts)
 * type against this — never a hand-rolled duplicate.
 */
export interface AimyBridgeApi {
  readonly invoke: <C extends IpcCommand>(cmd: C) => Promise<IpcCommandResult<C>>
  readonly subscribe: (handler: (evt: IpcEvent) => void) => () => void
}

/** `window` shape the renderer sees after the preload runs. */
export interface WindowAimy {
  readonly aimy: AimyBridgeApi
}
