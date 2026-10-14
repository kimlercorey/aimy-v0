/**
 * ui/src/messages.ts — the MVP message vocabulary for the shell track.
 *
 * Architecture ground truth: architecture.md §3.2. Session + permission
 * messages are this track's; the union stays closed to this track on purpose —
 * the later integration pass composes it with the other tracks' unions via
 * `foldkit/update`'s `foldChild` (each track's messages ride in a `Got*`
 * envelope). Adding another track's variant here would break that contract,
 * so it is documented and NOT done.
 *
 * STRUCTURAL RULE (§3.2, §3.9): there is NO dial-setting message variant.
 * Dials are write-only from the ASC pipeline. Any message attempting dial
 * mutation — a `DialsSetDirectly`-shaped object arriving over DevTools/MCP —
 * fails Schema decode and is rejected + logged by `update` (see update.ts),
 * never applied.
 */
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { ChatDocument, ChatImage, HomeCard, HomeChat, HomeJournal, HomeMemory, HomeProject, HomeProjectListEntry, HomeRecent, HomeRequest, HomedashWidget } from "./model.js"

/** Token usage incl. reasoning tokens (Pi #9409); optional until the loop reports it. */
export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.Number,
})
export type Usage = typeof Usage.Type

export const Message = defineMessageUnion({
  /* -- session (owned) ------------------------------------------- */

  ComposerDraftChanged: { text: Schema.String },
  ComposerHistoryStepped: { text: Schema.String, index: Schema.Number },
  StreamStopRequested: {},
  UserMessageEditRequested: { id: Schema.String },
  UserMessageEditCancelled: {},
  EditBranchReady: { newSessionId: Schema.String },
  EditBranchFailed: { reason: Schema.String },

  UserSentMessage: {
    /** Also the correlation id for the SendToInference command it produces. */
    id: Schema.String,
    text: Schema.String,
    /** Epoch millis, set by the dispatcher — update never calls Date.now for replay state. */
    at: Schema.Number,
    /** Images attached via drag-and-drop (2026-10-11). */
    images: Schema.optional(Schema.Array(ChatImage)),
    /** Documents attached via drag-and-drop (2026-10-13). */
    documents: Schema.optional(Schema.Array(ChatDocument)),
  },

  /** An image was dropped onto the chat (2026-10-11). */
  ImageDropped: {
    id: Schema.String,
    dataUrl: Schema.String,
    name: Schema.String,
    mimeType: Schema.String,
  },

  /** A document was dropped onto the chat (2026-10-13). */
  DocumentDropped: {
    id: Schema.String,
    name: Schema.String,
    text: Schema.String,
  },

  /** Remove a staged attachment from the composer (2026-10-11). */
  AttachmentRemoved: {
    id: Schema.String,
  },

  /** Dispatched by the SendToInference command; arms the streaming state. */
  StreamStarted: {
    streamId: Schema.String,
    sessionId: Schema.String,
    input: Schema.String,
    at: Schema.Number,
    voiceEnabled: Schema.Boolean,
    viaVoice: Schema.Boolean,
    /** True if this turn barged in on a previous response (2026-10-11). */
    interrupted: Schema.optional(Schema.Boolean),
    /** Images attached via drag-and-drop (2026-10-11). */
    images: Schema.optional(Schema.Array(ChatImage)),
  },

  /** One streamed delta. update appends it to streaming.text — nothing else. */
  StreamChunkReceived: {
    streamId: Schema.String,
    delta: Schema.String,
  },

  /** The agent loop executed a tool call mid-turn; rendered as a tool row. */
  StreamToolCallObserved: {
    streamId: Schema.String,
    tool: Schema.String,
    resultSummary: Schema.String,
    /** Full args for drawer tools (Phase I 2026-10-12). */
    args: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  },
  /**
   * A tool call completed in the loop (2026-10-12): forwarded by main as
   * the `chat.tool` IPC event. Lands on the ACTIVE stream's activity
   * list (single-stream UI; streamId carried for diagnosis) so the
   * footer tag can flip from spinner to green/red with a conclusion.
   */
  StreamToolActivity: {
    streamId: Schema.String,
    tool: Schema.String,
    ok: Schema.Boolean,
    conclusion: Schema.String,
  },

  /** The turn settled (§4.2): post-turn audit complete, text final. */
  StreamSettled: {
    streamId: Schema.String,
    text: Schema.String,
    at: Schema.Number,
    usage: Schema.optional(Usage),
  },

  /** A failed command produces a Message, never a silent drop (§3.3). */
  StreamFailed: {
    streamId: Schema.String,
    reason: Schema.String,
  },

  /** Voice channel: the user toggled auto-play of turn audio. */
  VoiceToggled: { enabled: Schema.Boolean },
  /** The `chat.channels` event landed for a settled turn. */
  ChannelsReceived: {
    streamId: Schema.String,
    audioBase64: Schema.optional(Schema.String),
    audioUnavailableReason: Schema.optional(Schema.String),
    expressions: Schema.Array(
      Schema.Struct({
        atMs: Schema.Number,
        frame: Schema.Record(Schema.String, Schema.Number),
      })
    ),
  },
  /** An ordered narration audio chunk arrived (from `narrate` tool). */
  AudioChunkReceived: {
    streamId: Schema.String,
    sequence: Schema.Number,
    audioBase64: Schema.String,
  },
  /** No more audio chunks will arrive for this stream. */
  AudioDrainedReceived: {
    streamId: Schema.String,
  },
  /** The audio chunk pump finished playing a batch — remove them. */
  AudioChunksConsumed: {
    streamId: Schema.String,
    sequences: Schema.Array(Schema.Number),
  },
  /** TTS speak request completed (fire-and-forget, no UI effect). */
  TtsSpoken: {},
  /** Speech started / ended (drives the speaking indicator). */
  SpeechStarted: { streamId: Schema.String },
  SpeechEnded: { streamId: Schema.String },
  /** Mic pre-roll capture status changed (warming/ready/unavailable). */
  MicPreRollChanged: {
    status: Schema.Literals(["warming", "ready", "unavailable"]),
  },
  /** The voice subscription took (or skipped) the pending channels. */
  ChannelsConsumed: { streamId: Schema.String },

  /* -- voice panel (engine install + voice clones) ---------------- */

  /** The user opened/closed the voice settings panel. */
  VoicePanelToggled: { open: Schema.Boolean },
  /** Button intents — each runs its IPC command. */
  TtsInstallRequested: {},
  VoicesRefreshRequested: {},
  VoiceSelectRequested: { voiceId: Schema.String },
  VoiceFilePickRequested: {},
  VoiceDeleteRequested: { voiceId: Schema.String },
  VoiceDeleteConfirmed: {},
  VoiceDeleteCancelled: {},
  VoiceSampleRequested: { voiceId: Schema.String },
  VoiceNameChanged: { name: Schema.String },
  /** Engine install state from main. */
  TtsEngineStatusReceived: {
    state: Schema.Literals(["missing", "installing", "ready", "failed"]),
    detail: Schema.optional(Schema.String),
  },
  TtsEngineStatusFailed: { reason: Schema.String },
  /** The install job started in main (progress follows via events). */
  TtsInstallStarted: {},
  TtsInstallFailed: { reason: Schema.String },
  /** One installer progress line from the `tts.installProgress` event. */
  TtsInstallProgressReceived: {
    phase: Schema.String,
    message: Schema.String,
  },
  /** Voice list from the server. */
  VoicesReceived: {
    voices: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        isDefault: Schema.Boolean,
      })
    ),
  },
  VoicesFailed: { reason: Schema.String },
  /** A voice was selected (persisted server-side). */
  VoiceSelected: { voiceId: Schema.String },
  VoiceSelectFailed: { reason: Schema.String },
  /** Native file picker returned a WAV for cloning. */
  VoiceFilePicked: { name: Schema.String, audioBase64: Schema.String },
  VoiceFilePickCancelled: {},
  VoiceFilePickFailed: { reason: Schema.String },
  /** The clone was stored server-side. */
  VoiceAdded: {
    id: Schema.String,
    name: Schema.String,
    isDefault: Schema.Boolean,
  },
  VoiceAddFailed: { reason: Schema.String },
  VoiceDeleted: { voiceId: Schema.String },
  VoiceDeleteFailed: { reason: Schema.String },
  VoiceSamplePlayed: { voiceId: Schema.String },
  VoiceSampleFailed: { reason: Schema.String },
  VoiceErrorDismissed: {},
  ProviderTestRequested: {},
  ProviderTestCompleted: {
    latencyMs: Schema.Number,
    modelSizeMb: Schema.Number,
    throughputCharsPerSec: Schema.Number,
    coldMs: Schema.optional(Schema.Number),
    p50Ms: Schema.optional(Schema.Number),
    p95Ms: Schema.optional(Schema.Number),
    allLatenciesMs: Schema.optional(Schema.Array(Schema.Number)),
  },
  ProviderTestFailed: { reason: Schema.String },
  VoiceSetDefaultRequested: { voiceId: Schema.String },
  VoiceDefaultSet: { voiceId: Schema.String },
  VoiceDefaultSetFailed: { reason: Schema.String },
  /** STT setup dialog. */
  SttSetupOpened: {},
  SttSetupClosed: {},
  /** User picked an STT engine to install. */
  SttInstallRequested: { engine: Schema.String },
  /** User changed the model size for an STT engine. */
  SttModelSizeChanged: { engine: Schema.String, size: Schema.String },
  SttInstallFailed: { reason: Schema.String },
  /** STT latency test requested (not yet implemented — placeholder). */
  SttTestRequested: {},
  SttTestCompleted: {
    latencyMs: Schema.Number,
    modelSizeMb: Schema.Number,
  },
  SttTestFailed: { reason: Schema.String },
  /** STT engine status from main (startup hydration). */
  SttEngineStatusReceived: {
    state: Schema.String,
    engine: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  },
  /** Mic recording controls. */
  MicRecordToggled: {},
  MicRecordingStarted: {},
  MicRecordingStopped: { audioBase64: Schema.String },
  MicTranscribed: { text: Schema.String },
  MicFailed: { reason: Schema.String },
  /** Voice draft UX: click-to-send / right-click-to-discard. */
  VoiceDraftSent: {},
  VoiceDraftDiscarded: {},
  /** Global click confirmed the voice draft (sends current draft). */
  VoiceDraftConfirmed: {},
  /* ── Provider registry ─────────────────────────────────────────── */
  /** Providers loaded from disk on startup. */
  ProvidersLoaded: {
    registry: Schema.Unknown,
  },
  /** Open/close the providers settings panel. */
  ProvidersOpened: {},
  ProvidersClosed: {},
  /** Switch the providers tab (llm/vision/tts/stt/image). */
  ProviderTabChanged: { tab: Schema.String },
  /** Add a new provider (from the add form). */
  ProviderAdded: {
    name: Schema.String,
    category: Schema.String,
    kind: Schema.String,
    engine: Schema.optional(Schema.String),
    endpoint: Schema.optional(Schema.String),
  },
  /** Update an existing provider's name/endpoint/config. */
  ProviderUpdated: {
    id: Schema.String,
    name: Schema.String,
    endpoint: Schema.optional(Schema.String),
    engine: Schema.optional(Schema.String),
    config: Schema.Record(Schema.String, Schema.String),
  },
  /** Delete a provider. */
  ProviderDeleted: { id: Schema.String },
  /** Open the edit form for a provider. */
  ProviderEditOpened: { id: Schema.String },
  /** Close the edit form. */
  ProviderEditClosed: {},
  /** Update a field in the edit form draft. */
  ProviderEditDraftChanged: { field: Schema.String, value: Schema.String },
  /** Open the add-provider form. */
  ProviderAddOpened: {},
  /** Close the add-provider form. */
  ProviderAddClosed: {},
  /** Update a field in the add form draft. */
  ProviderAddDraftChanged: { field: Schema.String, value: Schema.String },
  /** Create a provider from the add form draft. */
  ProviderCreateFromDraft: { category: Schema.String },
  /** Scan a host for known AI services (auto-detect). */
  ProviderScanRequested: { host: Schema.String },
  ProviderScanProgress: { scanned: Schema.Number, total: Schema.Number },
  ProviderScanCompleted: { host: Schema.String, found: Schema.Array(Schema.Struct({ host: Schema.String, port: Schema.Number, service: Schema.String })) },
  ProviderScanFailed: { reason: Schema.String },
  /** User picked a scan result (fills host + port). */
  ProviderScanResultSelected: { host: Schema.String, port: Schema.Number, service: Schema.String },
  /** Request the model list for a provider. */
  ProviderModelsRequested: { id: Schema.String },
  /** Models loaded for a provider. */
  ProviderModelsLoaded: { id: Schema.String, models: Schema.Array(Schema.String) },
  /** Select the active model for a provider. */
  ProviderModelSelected: { id: Schema.String, model: Schema.String },
  /** Toggle streaming for a provider (disable for broken SSE implementations). */
  ProviderStreamingToggled: { id: Schema.String, streaming: Schema.Boolean },
  /** Enable/disable a provider. */
  ProviderToggled: { id: Schema.String, enabled: Schema.Boolean },
  /** Set the active provider for a category. */
  ProviderSetActive: { category: Schema.String, id: Schema.String },
  /** Benchmark a provider (runs performance test). */
  ProviderBenchmarkRequested: { id: Schema.String },
  /** Test a provider's connection (quick health check). */
  ProviderConnectionTestRequested: { id: Schema.String },
  ProviderConnectionTestCompleted: { id: Schema.String, detail: Schema.String },
  ProviderConnectionTestFailed: { id: Schema.String, reason: Schema.String },
  ProviderBenchmarkCompleted: {
    id: Schema.String,
    latencyMs: Schema.Number,
    throughput: Schema.optional(Schema.Number),
    modelSizeMb: Schema.optional(Schema.Number),
  },
  ProviderBenchmarkFailed: { id: Schema.String, reason: Schema.String },
  /** Push-to-talk key configuration. */
  PushToTalkKeyChanged: { key: Schema.String, useMouse: Schema.Boolean },
  /** Microphone device selection. */
  MicDeviceChanged: { deviceId: Schema.String },
  MicDevicesRequested: {},
  MicDevicesReceived: {
    devices: Schema.Array(Schema.Struct({
      deviceId: Schema.String,
      label: Schema.String,
    })),
  },
  SttInstallProgressReceived: { message: Schema.String },

  SessionBranched: {
    fromId: Schema.String,
    newSessionId: Schema.String,
  },

  /** Virtualized-list scroll position; drives the render window. */
  ChatListScrolled: { scrollTop: Schema.Number },

  /* -- permissions (owned) --------------------------------------- */

  /**
   * Emitted by the RequestPermission command when the kernel answers "ask".
   * The prompt is UI; the gate is the kernel (Pi #10426).
   */
  PermissionRequested: {
    requestId: Schema.String,
    tool: Schema.String,
    argsSummary: Schema.String,
    riskTier: Schema.Literals(["T0", "T1", "T2", "T3"]),
    context: Schema.String,
    at: Schema.Number,
  },

  /** Kernel answered "allow": no prompt, recorded for the audit trail. */
  PermissionAutoAllowed: { requestId: Schema.String, at: Schema.Number },

  /**
   * Kernel check failed. `denied: true` means the kernel denied the intent
   * (terminal for the session); `false` means a transport/config error.
   */
  PermissionCheckFailed: {
    requestId: Schema.String,
    denied: Schema.Boolean,
    reason: Schema.String,
    at: Schema.Number,
  },

  /** The user clicked allow-once / allow-always in the prompt surface. */
  PermissionGranted: {
    requestId: Schema.String,
    scope: Schema.Literals(["once", "always"]),
    at: Schema.Number,
  },

  /**
   * The user clicked deny: the intent is dropped and the agent loop is
   * structurally barred from re-attempting it (§4.1, Hermes #65592).
   */
  PermissionDenied: { requestId: Schema.String, at: Schema.Number },

  /* -- memory persistence (owned) -------------------------------- */

  MemoryPersisted: { correlationId: Schema.String },

  MemoryPersistFailed: {
    correlationId: Schema.String,
    reason: Schema.String,
  },

  /* -- drawer (right-hand collaboration spaces, Phase I 2026-10-12) -- */

  DrawerToggled: { open: Schema.Boolean },

  /** Refresh the drawer home data without touching drawer state —
   *  the composed Projects destination loads through this (2026-10-12). */
  HomeDataRefreshRequested: {},

  DrawerSpaceOpened: {
    id: Schema.String,
    title: Schema.String,
    kind: Schema.String,
    content: Schema.String,
  },

  DrawerSpaceClosed: { id: Schema.String },

  DrawerSpaceSelected: { id: Schema.String },

  DrawerSpaceUpdated: {
    id: Schema.String,
    content: Schema.String,
  },

  /** User dragged a space resize handle — update height ratios. */
  DrawerSpaceResized: {
    aboveId: Schema.String,
    belowId: Schema.String,
    /** New flex-grow ratio for the above space. */
    aboveRatio: Schema.Number,
    /** New flex-grow ratio for the below space. */
    belowRatio: Schema.Number,
  },

  /** User clicked the save button on a space (2026-10-12). */
  DrawerSaveRequested: { id: Schema.String },

  /** The space's content was written to disk (SaveDocument command). */
  DrawerSpaceSaved: {
    id: Schema.String,
    path: Schema.String,
    content: Schema.String,
  },

  /** Saving a space to disk failed. */
  DrawerSpaceSaveFailed: {
    id: Schema.String,
    reason: Schema.String,
  },

  /** User toggled a space's history list open/closed (2026-10-12). */
  DrawerHistoryToggled: { id: Schema.String },
  DrawerRawToggled: { id: Schema.String },
  HomeDataLoaded: {
    recents: Schema.Array(HomeRecent),
    requests: Schema.Array(HomeRequest),
    cards: Schema.Array(HomeCard),
    project: Schema.NullOr(HomeProject),
    projectList: Schema.Array(HomeProjectListEntry),
    chats: Schema.Array(HomeChat),
    memories: Schema.Array(HomeMemory),
    journal: Schema.NullOr(HomeJournal),
    promptHistory: Schema.Array(Schema.String),
  },
  /** HomeDash (2026-10-13): enabled widgets + settings arrived. */
  HomedashLoaded: { widgets: Schema.Array(HomedashWidget) },
  HomedashFailed: { reason: Schema.String },
  HomedashRefreshRequested: {},
  /** A widget setting was adjusted (Settings transposition). The
   * reserved key "priority" sets the widget's screen depth. */
  HomedashSettingChanged: {
    widgetId: Schema.String,
    key: Schema.String,
    value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  },
  /** GlobeNews (2026-10-13): an event was read (feed click) — its dot gains the cyan ring. */
  NewsReadRequested: { id: Schema.String },
  /** GlobeNews (2026-10-13): an event was clicked — its article should open in the drawer. */
  NewsOpenRequested: { id: Schema.String },
  /** Threat Channel (2026-10-13): the desk/lower-third focus moved.
   * kind: "selected" | "featured"; an empty id clears the focus
   * (the update handler only lets it clear a director feature, so
   * a feature ending never erases a user selection). */
  NewsFocusChanged: { id: Schema.String, kind: Schema.String },
  VoiceAlertsChanged: {
    alerts: Schema.Array(
      Schema.Struct({ id: Schema.String, title: Schema.String, severity: Schema.String })
    ),
  },
  VoiceAlertDismissRequested: { id: Schema.String },
  /** The article arrived (markdown) — open it as a drawer space. */
  NewsArticleLoaded: {
    id: Schema.String,
    title: Schema.String,
    content: Schema.String,
    url: Schema.String,
  },
  NewsArticleFailed: { id: Schema.String, reason: Schema.String },
  /** GlobeNews (2026-10-13): the feed's "last updated" label was clicked — scan now. */
  NewsRefreshRequested: {},
  /** GlobeNews feed region toggle: "world" | "usa". */
  NewsRegionToggled: { region: Schema.String },
  HomeDataFailed: { reason: Schema.String },
  HomeRecentClicked: { path: Schema.String },
  /** Project UI (2026-10-12): switcher, new-project form, asset moves. */
  HomeProjectSwitchClicked: { id: Schema.String },
  HomeProjectNewClicked: {},
  HomeProjectFormCancelled: {},
  HomeProjectDraftNameChanged: { value: Schema.String },
  HomeProjectDraftPurposeChanged: { value: Schema.String },
  HomeProjectCreateSubmitted: {},
  HomeProjectActionDone: {},
  HomeAssetMoveMenuToggled: { key: Schema.String },
  HomeAssetMoveTargetClicked: {
    fromId: Schema.String,
    toId: Schema.String,
    kind: Schema.String,
    title: Schema.String,
    path: Schema.optional(Schema.String),
  },
  HomeRecentAddToProjectClicked: { path: Schema.String, title: Schema.String },
  HomeDocumentLoaded: { path: Schema.String, content: Schema.String },
  HomeDocumentLoadFailed: { path: Schema.String, reason: Schema.String },
  DocLinkClicked: { path: Schema.String, mode: Schema.String, spaceId: Schema.String },
  LinkedDocumentLoaded: {
    path: Schema.String,
    content: Schema.String,
    mode: Schema.String,
    spaceId: Schema.String,
  },
  LinkedDocumentLoadFailed: { path: Schema.String, reason: Schema.String },
  HomeRequestBuildBriefClicked: { capability: Schema.String, at: Schema.String },
  HomeRequestBriefLoaded: { capability: Schema.String, why: Schema.String, at: Schema.String },
  HomeRequestBriefLoadFailed: { capability: Schema.String, reason: Schema.String },
  HomeRequestDismissClicked: { capability: Schema.String, at: Schema.String },
  HomeRequestDismissed: { capability: Schema.String },
  HomeRequestDismissFailed: { reason: Schema.String },

  /** User picked a version from a space's history to restore (2026-10-12). */
  DrawerVersionRestored: {
    id: Schema.String,
    /** Index into the space's history array. */
    index: Schema.Number,
  },

  /** User clicked the edit (pencil) button on a space — enter edit mode. */
  DrawerEditStarted: { id: Schema.String },

  /** The edit textarea changed. */
  DrawerEditDraftChanged: { text: Schema.String },

  /** User confirmed the edit (check button) — apply the draft. */
  DrawerEditApplied: { id: Schema.String },

  /** User cancelled editing — discard the draft. */
  DrawerEditCancelled: { id: Schema.String },

  /**
   * A validator result for a drawer space's rendered blocks (2026-10-12,
   * design: planning/knowledge-and-validation-design.md). Dispatched by
   * the desktop renderer (mermaid render success/failure) via the
   * `aimy:validation` DOM event + subscription. update.ts diffs it
   * against DrawerState.validationIssues and turns failures/recoveries
   * into change notes for her next turn.
   */
  DrawerValidationReported: {
    spaceId: Schema.String,
    lang: Schema.String,
    ok: Schema.Boolean,
    error: Schema.optional(Schema.String),
  },
})
export type Message = typeof Message.Type

/** Every tag in this track's vocabulary, for the exhaustiveness tests. */
export const MESSAGE_TAGS = [
  "ComposerDraftChanged",
  "ComposerHistoryStepped",
  "StreamStopRequested",
  "UserMessageEditRequested",
  "UserMessageEditCancelled",
  "EditBranchReady",
  "EditBranchFailed",
  "UserSentMessage",
  "ImageDropped",
  "DocumentDropped",
  "AttachmentRemoved",
  "StreamStarted",
  "StreamChunkReceived",
  "StreamToolCallObserved",
  "StreamToolActivity",
  "StreamSettled",
  "StreamFailed",
  "SessionBranched",
  "ChatListScrolled",
  "PermissionRequested",
  "PermissionAutoAllowed",
  "PermissionCheckFailed",
  "PermissionGranted",
  "PermissionDenied",
  "MemoryPersisted",
  "MemoryPersistFailed",
  "MicPreRollChanged",
  "DrawerToggled",
  "HomeDataRefreshRequested",
  "DrawerSpaceOpened",
  "DrawerSpaceClosed",
  "DrawerSpaceSelected",
  "DrawerSpaceUpdated",
  "DrawerSpaceResized",
  "DrawerSaveRequested",
  "DrawerSpaceSaved",
  "DrawerSpaceSaveFailed",
  "DrawerHistoryToggled",
  "DrawerRawToggled",
  "HomeDataLoaded",
  "HomeDataFailed",
  "HomeRecentClicked",
  "HomeProjectSwitchClicked",
  "HomeProjectNewClicked",
  "HomeProjectFormCancelled",
  "HomeProjectDraftNameChanged",
  "HomeProjectDraftPurposeChanged",
  "HomeProjectCreateSubmitted",
  "HomeProjectActionDone",
  "HomeAssetMoveMenuToggled",
  "HomeAssetMoveTargetClicked",
  "HomeRecentAddToProjectClicked",
  "HomeDocumentLoaded",
  "HomeDocumentLoadFailed",
  "DocLinkClicked",
  "LinkedDocumentLoaded",
  "LinkedDocumentLoadFailed",
  "HomeRequestBuildBriefClicked",
  "HomeRequestBriefLoaded",
  "HomeRequestBriefLoadFailed",
  "HomeRequestDismissClicked",
  "HomeRequestDismissed",
  "HomeRequestDismissFailed",
  "DrawerVersionRestored",
  "DrawerEditStarted",
  "DrawerEditDraftChanged",
  "DrawerEditApplied",
  "DrawerEditCancelled",
  "DrawerValidationReported",
  "HomedashLoaded",
  "HomedashFailed",
  "HomedashRefreshRequested",
  "HomedashSettingChanged",
  "NewsReadRequested",
  "NewsOpenRequested",
  "NewsArticleLoaded",
  "NewsArticleFailed",
  "NewsRefreshRequested",
  "NewsRegionToggled",
  "NewsFocusChanged",
  "VoiceAlertsChanged",
  "VoiceAlertDismissRequested",
] as const
