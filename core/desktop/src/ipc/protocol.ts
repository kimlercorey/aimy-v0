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

/** Result of a `chat.branch` fork: the new session's id. */
export interface ChatBranchResult {
  readonly newSessionId: string
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

/** Result of a `docs.save` write: the repo-relative path actually written. */
export interface DocsSaveResult {
  readonly path: string
}

/** Result of a `docs.load` read: the repo-relative path and its content. */
export interface DocsLoadResult {
  readonly path: string
  readonly content: string
}

/** One recent document for the drawer home panel (mtime-derived). */
export interface HomeRecentEntry {
  readonly path: string
  readonly title: string
  /** Epoch ms of the file's last modification. */
  readonly at: number
}

/** One pending capability request for the drawer home panel. */
export interface HomeRequestEntry {
  readonly capability: string
  readonly why: string
  /** ISO timestamp from the request record. */
  readonly at: string
}

/** One knowledge card for the drawer home panel. */
export interface HomeCardEntry {
  readonly slug: string
  readonly title: string
  readonly whenToUse: string
  readonly proven: number
  readonly updated: string
}

/** One asset registered in the active project (reference, not a copy). */
export interface HomeProjectAssetEntry {
  readonly kind: string
  readonly title: string
  readonly role: string
  readonly path?: string
  readonly addedAt: string
}

/** One research run in the active project (E16 run-record summary). */
export interface HomeResearchRunEntry {
  readonly runId: string
  readonly query: string
  readonly mode: string
  readonly depth: string
  /** scheduled | running | done | failed | unknown */
  readonly status: string
  readonly stage: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly counters: { searches: number; fetches: number; claims: number; clusters: number; rounds: number }
  /** Estimated ms remaining; null while the run is still estimating. */
  readonly etaMs: number | null
  readonly deliverableTitle: string
  readonly deliverablePath: string | null
  readonly termination?: string
}

/** The active project section of the home panel (2026-10-12, Projects v1). */
export interface HomeProjectSection {
  readonly id: string
  readonly name: string
  readonly purpose: string
  readonly isDefault: boolean
  readonly goals: ReadonlyArray<string>
  readonly assets: ReadonlyArray<HomeProjectAssetEntry>
  readonly runs: ReadonlyArray<HomeResearchRunEntry>
}

/** One project in the switcher list (2026-10-12, project UI). */
export interface HomeProjectListEntry {
  readonly id: string
  readonly name: string
  readonly isDefault: boolean
}

/** One widget setting, as presented to the user (HomeDash, 2026-10-13). */
export interface HomedashSettingEntry {
  readonly key: string
  /** "slider" | "toggle" | "select" | "number" — the control to render. */
  readonly type: string
  readonly label: string
  readonly value: string | number | boolean
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly step?: number | undefined
  readonly options?: ReadonlyArray<string> | undefined
}

/** One world event on the GlobeNews wire (2026-10-13). Mirrors the widget's NewsEvent. */
export interface HomedashNewsEvent {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly source: string
  readonly url: string
  readonly atMs: number
  readonly lat?: number | undefined
  readonly lon?: number | undefined
  readonly place?: string | undefined
  readonly summary?: string | undefined
  /** The event's own full text (API-native sources), capped at the attach point. */
  readonly detail?: string | undefined
  readonly read: boolean
}

/** One active voice alert (Threat Channel §8): a threat inside the risk circle, being announced until silenced. */
export interface HomedashVoiceAlert {
  readonly id: string
  readonly title: string
  readonly severity: "warning" | "critical"
}

/** One enabled HomeDash widget with its effective settings. */
export interface HomedashWidgetEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  /** Screen depth on the dash stage, 1–1000. Higher is on top. */
  readonly priority: number
  readonly settings: ReadonlyArray<HomedashSettingEntry>
  /** GlobeNews only: the widget's current world events (2026-10-13). */
  readonly news?: ReadonlyArray<HomedashNewsEvent> | undefined
  /** GlobeNews only: when the events store was last scanned, epoch ms. */
  readonly newsUpdatedAt?: number | undefined
  /** GlobeNews only: voice alerts currently repeating (2026-10-13). */
  readonly voiceAlerts?: ReadonlyArray<HomedashVoiceAlert> | undefined
}

export interface HomedashListResult {
  readonly widgets: ReadonlyArray<HomedashWidgetEntry>
}

/** A fetched news article, as markdown, for the drawer (2026-10-13). */
export interface NewsArticleResult {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly url: string
}

/** One past conversation, from its session record (Mirror Field, 2026-10-13). */
export interface HomeChatEntry {
  readonly id: string
  readonly subject: string
  readonly at: number
  readonly messages: number
}

/** One archived thread memory — what she kept of a past conversation. */
export interface HomeMemoryEntry {
  readonly sessionId: string
  readonly summary: string
  readonly messageCount: number
  readonly archivedAt: number
}

/** The journal's metadata for the dash: existence + freshness only. */
export interface HomeJournalEntry {
  readonly updatedAt: number
  readonly chars: number
}

/** Drawer home panel data: Project / Continue / Needs you / Knowledge. */
export interface HomeDataResult {
  readonly recents: ReadonlyArray<HomeRecentEntry>
  readonly requests: ReadonlyArray<HomeRequestEntry>
  readonly cards: ReadonlyArray<HomeCardEntry>
  /** Null when no projects store exists yet. */
  readonly project: HomeProjectSection | null
  /** Every project, for the switcher + move targets. */
  readonly projectList: ReadonlyArray<HomeProjectListEntry>
  /** Past conversations, newest first (Mirror Field chat nodes). */
  readonly chats: ReadonlyArray<HomeChatEntry>
  /** Archived thread memories, newest first (Mirror Field memory nodes). */
  readonly memories: ReadonlyArray<HomeMemoryEntry>
  /** Journal metadata, or null when no journal exists yet. */
  readonly journal: HomeJournalEntry | null
  /** His sent prompts, oldest first (2026-10-13: global composer history). */
  readonly promptHistory: ReadonlyArray<string>
}

/** projects.list result: every project plus which one is active. */
export interface ProjectsListResult {
  readonly activeProjectId: string
  readonly projects: ReadonlyArray<HomeProjectListEntry & { purpose: string; assetCount: number }>
}

export interface ProjectsCreateResult {
  readonly id: string
  readonly name: string
  readonly created: boolean
}

/** Full capability-request detail for turning a request into a build brief. */
export interface HomeRequestDetailResult {
  readonly capability: string
  readonly why: string
  readonly at: string
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

export interface TimelineNodeResult {
  readonly node: LearningNode
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
/** One image for a chat turn (2026-10-11: drag-and-drop vision). */
export interface ChatImageWire {
  readonly dataUrl: string
  readonly mimeType: string
  readonly name: string
}

export type IpcCommand =
  | { _tag: "chat.send"; sessionId: string; input: string; images?: ReadonlyArray<ChatImageWire> | undefined; promptText?: string | undefined }
  /** Fork a session at his Nth prompt (2026-10-13: edit-and-resend). The new session keeps the ancestor chain before that prompt. */
  | { _tag: "chat.branch"; sessionId: string; userOrdinal: number }
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
  /** Record one learning event as a timeline node (2026-10-13). The event is the learning module's LearningEvent as JSON; the service validates serializability and fingerprints it. */
  | { _tag: "timeline.record"; event: unknown }
  /** Archive (tombstone) a timeline node — never a delete (2026-10-13). Provenance is the learning module's Provenance as JSON. */
  | { _tag: "timeline.archive"; nodeId: string; reason: string; provenance: unknown }
  /** Lift a node's tombstone (2026-10-13). */
  | { _tag: "timeline.restore"; nodeId: string; reason: string; provenance: unknown }
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
  /** Write a markdown document to disk (2026-10-12: drawer save). Main validates the path (planning/ or docs/, no traversal) and resolves it against the repo root. */
  | { _tag: "docs.save"; path: string; content: string }
  /** Read a markdown document from disk (2026-10-12: drawer home panel "Continue"). Same path validation as docs.save. */
  | { _tag: "docs.load"; path: string }
  /** Open a library document in the OS default app (2026-10-13: Cmd-Opt-click on a document link). Same resolution as docs.load. */
  | { _tag: "docs.openExternal"; path: string }
  /** Drawer home panel data (2026-10-12): recents (mtime scan), pending capability requests, knowledge cards — all read from the user's own stores by main. */
  | { _tag: "home.data" }
  /** Read the full text of one pending capability request (2026-10-12): used to open it as a build brief without truncating the request detail. */
  | { _tag: "home.requestDetail"; capability: string; at: string }
  /** Dismiss one pending capability request (2026-10-12): matched by capability + timestamp; main marks it dismissed in the ledger. */
  | { _tag: "home.dismissRequest"; capability: string; at: string }
  /** HomeDash (2026-10-13): enabled widgets, their manifests and effective settings. Main seeds the widget folders on first call. */
  | { _tag: "homedash.list" }
  /** Persist one HomeDash widget setting (the reserved key "priority" sets screen depth 1–1000). */
  | { _tag: "homedash.setSetting"; widgetId: string; key: string; value: string | number | boolean }
  /** Mark one GlobeNews event read (2026-10-13): its dot gains the cyan ring. */
  | { _tag: "news.markRead"; id: string }
  /** Fetch (or recall from the widget cache) one event's article as markdown for the drawer. */
  | { _tag: "news.open"; id: string }
  /** Run the world-news scan now (the feed's "last updated" click). */
  | { _tag: "news.refresh" }
  /** Silence one repeating voice alert for good (Threat Channel §8). */
  | { _tag: "news.dismissVoiceAlert"; id: string }
  /** Every project + the active one (2026-10-12, project UI). */
  | { _tag: "projects.list" }
  /** Create a user-declared project and make it active (2026-10-12). */
  | { _tag: "projects.create"; name: string; purpose: string }
  /** Declare a different project active (2026-10-12). */
  | { _tag: "projects.setActive"; id: string }
  /** Move an asset record between projects (2026-10-12): files never move, only the binding. */
  | { _tag: "projects.moveAsset"; fromId: string; toId: string; kind: string; title: string; path?: string }
  /** Register an existing document into a project as a reference asset (2026-10-12). */
  | { _tag: "projects.addAsset"; projectId: string; path: string; title: string }
  | { _tag: "shell.openExternal"; url: string }
  /** Debug trace (2026-10-11): renderer forwards one trace event to the main-process writer. No-op unless debugTrace is on. */
  | { _tag: "trace.log"; trace: string; event: string; fields?: Record<string, unknown> }

/** The response type for each command tag (index for Track 2's handler table). */
export interface IpcResponse {
  "chat.send": ChatSendResult
  "chat.branch": ChatBranchResult
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
  "timeline.record": TimelineNodeResult
  "timeline.archive": TimelineNodeResult
  "timeline.restore": TimelineNodeResult
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
  "docs.save": DocsSaveResult
  "docs.load": DocsLoadResult
  "docs.openExternal": void
  "home.data": HomeDataResult
  "projects.list": ProjectsListResult
  "projects.create": ProjectsCreateResult
  "projects.setActive": { activeProjectId: string }
  "projects.moveAsset": { moved: boolean }
  "projects.addAsset": { added: boolean }
  "home.requestDetail": HomeRequestDetailResult
  "home.dismissRequest": void
  "homedash.list": HomedashListResult
  "homedash.setSetting": void
  "news.markRead": void
  "news.open": NewsArticleResult
  "news.refresh": void
  "news.dismissVoiceAlert": { voiceAlerts: ReadonlyArray<HomedashVoiceAlert> }
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
  /** One tool call completed in the loop (2026-10-12): the footer tag's outcome — ok/failed plus a conclusion (what the tool returned, never the request). */
  | { _tag: "chat.tool"; streamId: string; tool: string; ok: boolean; conclusion: string }
  | { _tag: "chat.done"; streamId: string; outputTokens: number }
  | { _tag: "chat.error"; streamId: string; error: string }
  | { _tag: "chat.channels"; channels: ChatChannelsResult }
  | { _tag: "chat.audioChunk"; streamId: string; sequence: number; audioBase64: string }
  | { _tag: "chat.audioDrained"; streamId: string }
  | { _tag: "tts.installProgress"; progress: TtsInstallProgressEvent }
  | { _tag: "stt.installProgress"; progress: SttInstallProgressEvent }
  | { _tag: "banner.published"; banner: Banner }
  | { _tag: "news.voiceAlerts"; alerts: ReadonlyArray<HomedashVoiceAlert> }
  | { _tag: "asc.dialsUpdated"; dials: DialVector }

/** The set of channel names the preload allowlists. Nothing else crosses. */
export const IPC_COMMAND_TAGS = [
  "chat.send",
  "chat.branch",
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
  "timeline.record",
  "timeline.archive",
  "timeline.restore",
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
  "messaging.testMessage",
  "docs.save",
  "docs.load",
  "docs.openExternal",
  "home.data",
  "home.requestDetail",
  "home.dismissRequest",
  "homedash.list",
  "homedash.setSetting",
  "news.markRead",
  "news.open",
  "news.refresh",
  "news.dismissVoiceAlert",
  "shell.openExternal",
  "projects.list",
  "projects.create",
  "projects.setActive",
  "projects.moveAsset",
  "projects.addAsset"
] as const

export const IPC_EVENT_TAGS = [
  "chat.token",
  "chat.tool",
  "chat.done",
  "chat.error",
  "chat.channels",
  "chat.audioChunk",
  "chat.audioDrained",
  "tts.installProgress",
  "stt.installProgress",
  "banner.published",
  "news.voiceAlerts",
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
