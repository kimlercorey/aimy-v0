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
import type { AUFrame } from "../../../asc-channels/src/index.js"
import type { TtsHealth, Voice } from "../../../tts/src/index.js"

// ── Commands (renderer → main, request/response) ────────────────────────────

export interface ChatSendResult {
  readonly streamId: string
}

/** One FACS keyframe, JSON-safe for the bridge. */
export interface ExpressionCueWire {
  readonly atMs: number
  readonly frame: AUFrame
}

/** The simultaneous-channels payload for one settled turn. */
export interface ChatChannelsResult {
  readonly streamId: string
  /** Speakable text (markdown stripped), for captioning. */
  readonly spoken: string
  /** WAV bytes as base64; absent when TTS was unavailable. */
  readonly audioBase64?: string | undefined
  /** Set exactly when audioBase64 is absent: why. */
  readonly audioUnavailableReason?: string | undefined
  readonly expressions: ReadonlyArray<ExpressionCueWire>
  readonly durationMs: number
}

export interface TtsHealthResult {
  readonly health: TtsHealth
}

export interface TtsVoicesResult {
  readonly voices: ReadonlyArray<Voice>
}

export type TtsEngineStateWire = "missing" | "installing" | "ready" | "failed"

export interface TtsEngineStatusResult {
  readonly state: TtsEngineStateWire
  readonly detail?: string | undefined
}

export interface TtsInstallResult {
  readonly started: boolean
}

export interface SttEngineStatusResult {
  readonly state: "unknown" | "missing" | "installing" | "ready" | "failed"
  readonly detail?: string | undefined
  readonly engine?: string | undefined
}

export interface SttInstallProgressEvent {
  readonly phase: string
  readonly message: string
  readonly downloadedMb?: number | undefined
  readonly totalMb?: number | undefined
  readonly percent?: number | undefined
}

export interface SttTranscribeResult {
  readonly text: string
  readonly latencyMs: number
}

export interface SttTestResult {
  readonly latencyMs: number
  readonly modelSizeMb: number
}

export interface TtsAddVoiceResult {
  readonly voice: Voice
}

export interface TtsTestProviderResult {
  readonly latencyMs: number
  readonly modelSizeMb: number
  readonly throughputCharsPerSec: number
}

export interface TtsPlaySampleResult {
  readonly audioBase64: string
}

export interface TtsPickVoiceFileResult {
  readonly cancelled: boolean
  readonly name?: string | undefined
  readonly audioBase64?: string | undefined
}

export interface TtsInstallProgressEvent {
  readonly phase: "python" | "venv" | "deps" | "verify" | "done" | "error"
  readonly message: string
}

export interface MessagingStatusResult {
  readonly configured: boolean
  readonly botUsername?: string | undefined
  readonly paired: boolean
  readonly forwardingKinds: ReadonlyArray<string>
}

export interface MessagingValidateResult {
  readonly ok: boolean
  readonly botUsername?: string | undefined
  readonly error?: string | undefined
}

export interface MessagingCodeResult {
  readonly code: string
  readonly expiresAt: string
}

export interface MessagingPairingResult {
  readonly paired: boolean
}

export interface MessagingForwardingResult {
  readonly kinds: ReadonlyArray<string>
}

export interface MessagingTestResult {
  readonly ok: boolean
  readonly error?: string | undefined
}

export interface DevRebuildResult {
  readonly ok: boolean
  readonly output: string
  readonly error?: string | undefined
}

export interface BannersListResult {
  readonly banners: ReadonlyArray<Banner>
}

export interface ProvidersTestConnectionResult {
  readonly ok: boolean
  readonly status?: number | undefined
  readonly error?: string | undefined
}

export interface ProvidersScanNetworkResult {
  readonly found: ReadonlyArray<{
    readonly host: string
    readonly port: number
    readonly service: string
  }>
  readonly error?: string | undefined
}

export interface ProvidersListModelsResult {
  readonly models: ReadonlyArray<string>
  readonly error?: string | undefined
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
  | { _tag: "tts.health" }
  | { _tag: "tts.voices" }
  | { _tag: "tts.setVoice"; voiceId: string }
  | { _tag: "tts.engineStatus" }
  | { _tag: "tts.installEngine" }
  | { _tag: "tts.addVoice"; name: string; audioBase64: string }
  | { _tag: "tts.deleteVoice"; voiceId: string }
  | { _tag: "tts.playVoiceSample"; voiceId: string }
  | { _tag: "tts.testProvider" }
  | { _tag: "tts.setVoiceDefault"; voiceId: string }
  | { _tag: "tts.pickVoiceFile" }
  | { _tag: "tts.speak"; text: string }
  | { _tag: "tts.stop" }
  | { _tag: "stt.engineStatus" }
  | { _tag: "stt.installEngine"; engine: string }
  | { _tag: "stt.transcribe"; audioBase64: string; sampleRate?: number }
  | { _tag: "stt.test" }
  | { _tag: "providers.load" }
  | { _tag: "providers.save"; registry: unknown }
  | { _tag: "providers.testConnection"; endpoint: string }
  | { _tag: "providers.scanNetwork"; host: string }
  | { _tag: "providers.listModels"; endpoint: string }
  | { _tag: "messaging.status" }
  | { _tag: "messaging.validateToken"; token: string }
  | { _tag: "messaging.issueCode" }
  | { _tag: "messaging.checkPairing" }
  | { _tag: "messaging.getForwarding" }
  | { _tag: "messaging.setForwarding"; kinds: ReadonlyArray<string> }
  | { _tag: "messaging.testMessage" }
  | { _tag: "dev.rebuild" }
  | { _tag: "shell.openExternal"; url: string }
  /** Debug trace (2026-10-11): renderer forwards one trace event to the main-process writer. No-op unless debugTrace is on. */
  | { _tag: "trace.log"; trace: string; event: string; fields?: Record<string, unknown> }

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
  "tts.health": TtsHealthResult
  "tts.voices": TtsVoicesResult
  "tts.setVoice": void
  "tts.engineStatus": TtsEngineStatusResult
  "tts.installEngine": TtsInstallResult
  "tts.addVoice": TtsAddVoiceResult
  "tts.deleteVoice": void
  "tts.playVoiceSample": TtsPlaySampleResult
  "tts.testProvider": TtsTestProviderResult
  "tts.setVoiceDefault": void
  "stt.engineStatus": SttEngineStatusResult
  "stt.installEngine": void
  "stt.transcribe": SttTranscribeResult
  "stt.test": SttTestResult
  "tts.pickVoiceFile": TtsPickVoiceFileResult
  "tts.speak": void
  "tts.stop": void
  "messaging.status": MessagingStatusResult
  "messaging.validateToken": MessagingValidateResult
  "messaging.issueCode": MessagingCodeResult
  "messaging.checkPairing": MessagingPairingResult
  "messaging.getForwarding": MessagingForwardingResult
  "messaging.setForwarding": void
  "messaging.testMessage": MessagingTestResult
  "dev.rebuild": DevRebuildResult
  "shell.openExternal": void
  "trace.log": void
  "providers.load": unknown
  "providers.save": void
  "providers.testConnection": ProvidersTestConnectionResult
  "providers.scanNetwork": ProvidersScanNetworkResult
  "providers.listModels": ProvidersListModelsResult
}

/** Helper: response type for a given command. */
export type IpcCommandResult<C extends IpcCommand> = IpcResponse[C["_tag"]]

// ── Events (main → renderer, pushed) ────────────────────────────────────────

export type IpcEvent =
  | { _tag: "chat.token"; streamId: string; delta: string }
  | { _tag: "chat.done"; streamId: string; outputTokens: number }
  | { _tag: "chat.error"; streamId: string; error: string }
  | { _tag: "chat.channels"; channels: ChatChannelsResult }
  | { _tag: "chat.audioChunk"; streamId: string; sequence: number; audioBase64: string }
  | { _tag: "chat.audioDrained"; streamId: string }
  | { _tag: "tts.installProgress"; progress: TtsInstallProgressEvent }
  | { _tag: "stt.installProgress"; progress: SttInstallProgressEvent }
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
  "config.set",
  "tts.health",
  "tts.voices",
  "tts.setVoice",
  "tts.engineStatus",
  "tts.installEngine",
  "tts.addVoice",
  "tts.deleteVoice",
  "tts.playVoiceSample",
  "tts.testProvider",
  "tts.setVoiceDefault",
  "tts.pickVoiceFile",
  "tts.speak",
  "tts.stop",
  "stt.engineStatus",
  "stt.installEngine",
  "stt.transcribe",
  "stt.test",
  "providers.load",
  "providers.save",
  "providers.testConnection",
  "providers.scanNetwork",
  "providers.listModels",
  "messaging.status",
  "messaging.validateToken",
  "messaging.issueCode",
  "messaging.checkPairing",
  "messaging.getForwarding",
  "messaging.setForwarding",
  "messaging.testMessage"
] as const

export const IPC_EVENT_TAGS = [
  "chat.token",
  "chat.done",
  "chat.error",
  "chat.channels",
  "chat.audioChunk",
  "chat.audioDrained",
  "tts.installProgress",
  "stt.installProgress",
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
