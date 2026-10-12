/**
 * ui/src/model.ts — the Foldkit top-level Model for Track 1 of M8 (app shell core).
 *
 * Architecture ground truth: architecture.md §3.1. This file owns the slices the
 * shell track renders — `session` (message list, streaming state, context meter)
 * and `permissions` (pending prompts) — plus the `rejections` audit trail that
 * gives §3.2's "no dial-setting message" rule its teeth. Every other track's
 * slice is present as a Schema.Struct placeholder with a `_tag` discriminator;
 * the owning tracks flesh them out, and this track's `update` never touches them.
 *
 * The Model is Schema-defined end to end, so it stays a valid `Model` codec for
 * `Runtime.makeApplication` and remains replayable in DevTools (§3.9).
 */
import { Schema } from "effect"

/* ------------------------------------------------------------------ */
/* session slice (owned by this track)                                 */
/* ------------------------------------------------------------------ */

/** One image attached to a message (2026-10-11: drag-and-drop vision). */
export const ChatImage = Schema.Struct({
  id: Schema.String,
  /** Base64 data URL (downscaled client-side, max 1568px longest edge). */
  dataUrl: Schema.String,
  /** Original filename for display. */
  name: Schema.String,
  mimeType: Schema.String,
})
export type ChatImage = typeof ChatImage.Type

/** One transcript row. `role: "tool"` rows are rendered from observed tool calls. */
export const ChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "tool"]),
  text: Schema.String,
  /** Epoch millis. Monotonic within a session; display-only. */
  at: Schema.Number,
  /**
   * Tool names used to produce this message (e.g. ["narrate"]).
   * Rendered as faint right-aligned indicator below the bubble.
   * Extracted from text tool-call JSON at message creation time.
   */
  toolsUsed: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Spoken texts from `narrate` tool calls, in order (2026-10-11 debug aid).
   * Parallel to the "narrate" entries in toolsUsed — the k-th "narrate"
   * tag's hover tooltip shows narratedTexts[k].
   */
  narratedTexts: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Images attached to this message (2026-10-11: drag-and-drop).
   * Rendered as thumbnails in the bubble; sent to vision-capable models.
   */
  images: Schema.optional(Schema.Array(ChatImage)),
})
export type ChatMessage = typeof ChatMessage.Type

/**
 * The in-progress assistant turn. Chunks append to `text` ONLY (never re-parse
 * the whole transcript per chunk — see rendering.ts, Pi #6665).
 */
export const StreamingState = Schema.Struct({
  active: Schema.Boolean,
  /** Correlation id of the SendToInference command that opened this stream. */
  streamId: Schema.String,
  /** The raw in-progress text; the tail segment is the only re-rendered part. */
  text: Schema.String,
  startedAt: Schema.Number,
  /** Whether the input came via voice (STT) — response should use voice. */
  viaVoice: Schema.optional(Schema.Boolean),
  /**
   * True if this turn barged in on a previous turn/response (2026-10-11).
   * The renderer forwards it to the loop so the model knows it was cut off
   * and can weave the unfinished thought into its reply.
   */
  interrupted: Schema.optional(Schema.Boolean),
})
export type StreamingState = typeof StreamingState.Type

/**
 * Context meter readings (architecture §4.2, Pi #9409). Values are true usage
 * *including* reasoning tokens, read from the InferencePool's accounting.
 * `null` means "not yet reported" — the UI shows "unknown", never a zero.
 */
export const ContextMeter = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  reasoningTokens: Schema.NullOr(Schema.Number),
  /** The model's hard ceiling; sessions must never wedge silently at it. */
  ceiling: Schema.Number,
  /** The compaction threshold is marked on the meter. */
  compactionThreshold: Schema.Number,
})
export type ContextMeter = typeof ContextMeter.Type

/* ------------------------------------------------------------------ */
/* provider registry (unified LLM / vision / TTS / STT / image)        */
/* ------------------------------------------------------------------ */

/** Provider categories. */
export const ProviderCategory = Schema.Literals(["llm", "vision", "tts", "stt", "image"])
export type ProviderCategory = typeof ProviderCategory.Type

/** Local engine or remote endpoint. */
export const ProviderKind = Schema.Literals(["local", "remote"])
export type ProviderKind = typeof ProviderKind.Type

/** Benchmark stats for a provider (from real runs on the user's hardware). */
export const ProviderStats = Schema.Struct({
  latencyMs: Schema.optional(Schema.Number),
  /** Tokens/sec (LLM), chars/sec (TTS), etc. */
  throughput: Schema.optional(Schema.Number),
  modelSizeMb: Schema.optional(Schema.Number),
  lastTestedAt: Schema.optional(Schema.Number),
  testCount: Schema.Number,
})
export type ProviderStats = typeof ProviderStats.Type

/** A configured provider (LLM, vision, TTS, STT, or image generation). */
export const Provider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  category: ProviderCategory,
  kind: ProviderKind,
  enabled: Schema.Boolean,
  /** Local engine identifier (e.g., "parakeet-mlx-0.6b-v2"). */
  engine: Schema.optional(Schema.String),
  /** Remote endpoint URL (e.g., "http://192.168.1.10:8000"). */
  endpoint: Schema.optional(Schema.String),
  /** Extra config: API keys, model params, etc. (values are strings). */
  config: Schema.Record(Schema.String, Schema.String),
  stats: ProviderStats,
  /** Whether this provider has vision capability (for LLM category). */
  hasVision: Schema.optional(Schema.Boolean),
})
export type Provider = typeof Provider.Type

/** The registry: all providers + active selection per category. */
export const ProviderRegistry = Schema.Struct({
  providers: Schema.Array(Provider),
  /** Active provider ID per category (undefined = none selected). */
  activeId: Schema.Struct({
    llm: Schema.optional(Schema.String),
    vision: Schema.optional(Schema.String),
    tts: Schema.optional(Schema.String),
    stt: Schema.optional(Schema.String),
    image: Schema.optional(Schema.String),
  }),
})
export type ProviderRegistry = typeof ProviderRegistry.Type

export const initialProviderRegistry = (): ProviderRegistry => ({
  providers: [],
  activeId: {},
})

/** Windowing state for the virtualized transcript (Pi #7730). */
export const ListWindow = Schema.Struct({
  /** Index of the first rendered row. */
  anchorIndex: Schema.Number,
  /** Rows rendered around the anchor (overscan above and below). */
  overscan: Schema.Number,
})
export type ListWindow = typeof ListWindow.Type

export const SessionSlice = Schema.Struct({
  _tag: Schema.Literal("session"),
  sessionId: Schema.String,
  /** Session-tree leaf position (branch id), per Pi session-tree philosophy. */
  branchId: Schema.String,
  /** Current subject from AImy's perspective — derived from recent conversation. */
  subject: Schema.String,
  messages: Schema.Array(ChatMessage),
  /**
   * Thread history: summaries of previous conversation threads (2026-10-10).
   * When a thread is archived (new chat started or auto-compacted), its
   * essence is preserved here as a one-line summary. This gives continuity
   * without the 500-message bloat — the AI knows what was discussed
   * without loading every message.
   */
  threadHistory: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      summary: Schema.String,
      messageCount: Schema.Number,
      archivedAt: Schema.Number,
    })
  ),
  streaming: StreamingState,
  contextMeter: ContextMeter,
  composer: Schema.Struct({
    draft: Schema.String,
    /** Images staged for the next message (2026-10-11: drag-and-drop). */
    attachments: Schema.Array(ChatImage),
  }),
  listWindow: ListWindow,
  /**
   * Mic pre-roll status (2026-10-11): is the 500ms lead-in buffer capturing?
   * warming = capture starting, ready = pre-roll active, unavailable = denied/failed.
   */
  micPreRoll: Schema.Literals(["warming", "ready", "unavailable"]),
  /**
   * Voice channel: when true, settled assistant turns auto-play their TTS
   * audio (the `chat.channels` event). Off by default — voice is opt-in.
   */
  voiceEnabled: Schema.Boolean,
  /** Id of the turn currently speaking, if any (speaking indicator). */
  speakingStreamId: Schema.optional(Schema.String),
  /**
   * The last `chat.channels` payload awaiting playback. Transient: cleared
   * when speech starts (or when voice is off). Audio is base64 WAV.
   */
  pendingChannels: Schema.optional(
    Schema.Struct({
      streamId: Schema.String,
      audioBase64: Schema.optional(Schema.String),
      audioUnavailableReason: Schema.optional(Schema.String),
      expressions: Schema.Array(
        Schema.Struct({
          atMs: Schema.Number,
          frame: Schema.Record(Schema.String, Schema.Number),
        })
      ),
    })
  ),
  /**
   * Ordered narration audio chunks awaiting gapless playback.
   * From the `narrate` tool via `chat.audioChunk` events.
   * Each entry: { streamId, sequence, audioBase64 }.
   */
  pendingAudioChunks: Schema.Array(
    Schema.Struct({
      streamId: Schema.String,
      sequence: Schema.Number,
      audioBase64: Schema.String,
    })
  ),
  /** Set when `chat.audioDrained` arrives (no more chunks for the stream). */
  audioDrainedStreamIds: Schema.Array(Schema.String),
  /** Voice settings panel (engine install + voice clone management). */
  voicePanelOpen: Schema.Boolean,
  /** Pending name for a new custom voice (typed before file pick). */
  pendingVoiceName: Schema.String,
  /** Voice ID awaiting delete confirmation (undefined = no pending delete). */
  pendingDeleteVoiceId: Schema.String.pipe(Schema.optional),
  /** Last provider test error (set on failure, cleared on success). Drives the health dot. */
  providerLastError: Schema.optional(Schema.String),
  /** Voice ID currently playing a sample (for button feedback). */
  playingSampleVoiceId: Schema.optional(Schema.String),
  /** STT setup dialog open. */
  sttSetupOpen: Schema.Boolean,
  /** Selected STT model size per engine (e.g. "tiny", "base"). */
  sttModelSizes: Schema.Record(Schema.String, Schema.String),
  /** STT engine install state. */
  sttEngine: Schema.Struct({
    state: Schema.Literals(["unknown", "missing", "installing", "ready", "failed"]),
    detail: Schema.optional(Schema.String),
    progressMessage: Schema.optional(Schema.String),
    engine: Schema.optional(Schema.String),
  }),
  /** STT latency test in progress. */
  sttTestRunning: Schema.Boolean,
  /** Last STT test results. */
  sttTestResults: Schema.Struct({
    latencyMs: Schema.Number,
    modelSizeMb: Schema.Number,
  }).pipe(Schema.optional),
  /** Mic recording state. */
  micRecording: Schema.Boolean,
  /** Mic is transcribing (recording stopped, waiting for STT). */
  micTranscribing: Schema.Boolean,
  /** Draft came from voice transcription (enables click-to-send / right-click-to-discard). */
  voiceDraft: Schema.Boolean,
  /** Unified provider registry (LLM, vision, TTS, STT, image). */
  providers: ProviderRegistry,
  /** Providers panel open. */
  providersOpen: Schema.Boolean,
  /** Active providers tab. */
  providerTab: Schema.String,
  /** ID of the provider being edited (form open). */
  editingProviderId: Schema.optional(Schema.String),
  /** Draft values for the provider edit form. */
  editingDraft: Schema.Struct({
    name: Schema.String,
    endpoint: Schema.String,
    engine: Schema.String,
  }),
  /** Add-provider form open (for the given category tab). */
  addingProvider: Schema.Boolean,
  /** Draft values for the add-provider form. */
  addDraft: Schema.Struct({
    name: Schema.String,
    kind: Schema.String,
    engine: Schema.String,
    host: Schema.String,
    port: Schema.String,
  }),
  /** Connection test results per provider ID. */
  providerTestResults: Schema.Record(Schema.String, Schema.String),
  /** Network scan in progress. */
  providerScanRunning: Schema.Boolean,
  /** Host being scanned. */
  providerScanHost: Schema.String,
  /** Last scan results: list of {host, port, service}. */
  providerScanResults: Schema.Array(
    Schema.Struct({ host: Schema.String, port: Schema.Number, service: Schema.String })
  ),
  /** Scan progress (hosts scanned / total). */
  providerScanProgress: Schema.Struct({
    scanned: Schema.Number,
    total: Schema.Number,
  }).pipe(Schema.optional),
  /** Last scan error. */
  providerScanError: Schema.optional(Schema.String),
  /** Available models per provider ID (from /v1/models or /api/tags). */
  providerModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** Push-to-talk key (KeyboardEvent.code) or mouse button. */
  pushToTalkKey: Schema.String,
  /** Push-to-talk uses mouse button instead of keyboard. */
  pushToTalkUseMouse: Schema.Boolean,
  /** Selected microphone device ID (empty = default). */
  micDeviceId: Schema.String,
  /** Available microphone devices (from enumerateDevices). */
  micDevices: Schema.Array(Schema.Struct({
    deviceId: Schema.String,
    label: Schema.String,
  })),
  /**
   * TTS engine install state. `unknown` until first status fetch;
   * `progress` carries the latest installer line while installing.
   */
  ttsEngine: Schema.Struct({
    state: Schema.Literals(["unknown", "missing", "installing", "ready", "failed"]),
    detail: Schema.optional(Schema.String),
    progressPhase: Schema.optional(Schema.String),
    progressMessage: Schema.optional(Schema.String),
  }),
  /** Voices known to the TTS server (empty until fetched). */
  voices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      isDefault: Schema.Boolean,
    })
  ),
  /** The selected voice id (persists server-side via tts.setVoice). */
  activeVoiceId: Schema.optional(Schema.String),
  /** Transient voice-panel error line. */
  voiceError: Schema.optional(Schema.String),
})
export type SessionSlice = typeof SessionSlice.Type

/* ------------------------------------------------------------------ */
/* permissions slice (owned by this track)                             */
/* ------------------------------------------------------------------ */

export const RiskTier = Schema.Literals(["T0", "T1", "T2", "T3"])
export type RiskTier = typeof RiskTier.Type

/**
 * One pending prompt. The prompt is UI; the gate is Part 02's SafetyKernel
 * (§4.1) — this slice renders what the kernel asked about, nothing more.
 */
export const PermissionPrompt = Schema.Struct({
  /** Correlation id back to the RequestPermission command. */
  requestId: Schema.String,
  tool: Schema.String,
  /** Human-readable summary of the canonicalized args (never raw strings). */
  argsSummary: Schema.String,
  riskTier: RiskTier,
  /** Who/why this intent exists, e.g. "agent-loop:turn-42". */
  context: Schema.String,
  at: Schema.Number,
})
export type PermissionPrompt = typeof PermissionPrompt.Type

export const PermissionDecision = Schema.Struct({
  requestId: Schema.String,
  decision: Schema.Literals(["allowed-by-policy", "granted-once", "granted-always", "denied"]),
  at: Schema.Number,
})
export type PermissionDecision = typeof PermissionDecision.Type

export const PermissionsSlice = Schema.Struct({
  _tag: Schema.Literal("permissions"),
  pending: Schema.Array(PermissionPrompt),
  /** Denial kills the intent: it lands here as a terminal record (§4.1). */
  decisions: Schema.Array(PermissionDecision),
})
export type PermissionsSlice = typeof PermissionsSlice.Type

/* ------------------------------------------------------------------ */
/* rejections audit (owned by this track) — the §3.2 teeth             */
/* ------------------------------------------------------------------ */

/**
 * Every message the update function rejected (unknown tag, Schema-decode
 * failure, or an attempted dial mutation). Bounded: the newest 100 win, so the
 * audit trail itself can never bloat the Model (Hermes memory-bloat discipline).
 */
export const RejectionRecord = Schema.Struct({
  at: Schema.Number,
  tag: Schema.String,
  reason: Schema.Literals(["unknown-tag", "decode-failed", "dial-mutation-rejected"]),
})
export type RejectionRecord = typeof RejectionRecord.Type

export const RejectionsSlice = Schema.Struct({
  _tag: Schema.Literal("rejections"),
  records: Schema.Array(RejectionRecord),
})
export type RejectionsSlice = typeof RejectionsSlice.Type

/** Cap on the rejections audit: newest-first, bounded memory. */
export const MAX_REJECTIONS = 100

/* ------------------------------------------------------------------ */
/* placeholders for the other tracks' slices                           */
/*                                                                     */
/* Each is a discriminated placeholder: the `_tag` keeps the union     */
/* stable while the owning track fleshes out the fields. This track's  */
/* update passes them through untouched — see update.ts.               */
/* ------------------------------------------------------------------ */

const placeholder = (tag: string) =>
  Schema.Struct({ _tag: Schema.Literal(tag), status: Schema.String })

export const InstanceSlice = placeholder("instance")
export const MemoryViewSlice = placeholder("memoryView")
export const ModuleRegistrySlice = placeholder("moduleRegistry")
export const InferencePoolSlice = placeholder("inferencePool")
export const AscSlice = placeholder("asc")
export const JobsSlice = placeholder("jobs")
export const BannersSlice = placeholder("banners")
export const SovereigntySlice = placeholder("sovereignty")
export const ExportStateSlice = placeholder("exportState")
export const OnboardingSlice = placeholder("onboarding")
export const ExpressionPreviewSlice = placeholder("expressionPreview")
export const DevtoolsSlice = placeholder("devtools")
export const TimelineSlice = placeholder("timeline")

/* ------------------------------------------------------------------ */
/* the top-level Model                                                 */
/* ------------------------------------------------------------------ */

export const Model = Schema.Struct({
  instance: InstanceSlice,
  session: SessionSlice,
  memoryView: MemoryViewSlice,
  moduleRegistry: ModuleRegistrySlice,
  inferencePool: InferencePoolSlice,
  asc: AscSlice,
  jobs: JobsSlice,
  banners: BannersSlice,
  permissions: PermissionsSlice,
  rejections: RejectionsSlice,
  sovereignty: SovereigntySlice,
  exportState: ExportStateSlice,
  onboarding: OnboardingSlice,
  expressionPreview: ExpressionPreviewSlice,
  devtools: DevtoolsSlice,
  timeline: TimelineSlice,
})
export type Model = typeof Model.Type

const freshPlaceholder = (tag: string) => ({ _tag: tag, status: "placeholder" }) as const

/** The initial Model: empty session, no prompts, all sibling slices placeholders. */
export const initialModel = (): Model => {
  // Unique session ID per app launch (2026-10-10: fixes hardcoded session-1
  // causing 500-message accumulation across restarts).
  const sessionId = `session-${Date.now()}`
  return {
  instance: freshPlaceholder("instance"),
  session: {
    _tag: "session",
    sessionId,
    branchId: sessionId,
    subject: "",
    messages: [],
    threadHistory: [],
    streaming: { active: false, streamId: "", text: "", startedAt: 0 },
    contextMeter: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      ceiling: 64000,
      compactionThreshold: 56000,
    },
    composer: { draft: "", attachments: [] },
    // Anchor starts at max: visibleWindow clamps to newest message.
    // (Column-reverse layout: we want the bottom/newest visible on load.)
    listWindow: { anchorIndex: Number.MAX_SAFE_INTEGER, overscan: 8 },
    // Mic pre-roll (2026-10-11): is the 500ms lead-in buffer capturing?
    // warming = capture starting, ready = pre-roll active, unavailable = denied/failed.
    micPreRoll: "warming",
    voiceEnabled: (() => {
      try {
        return localStorage.getItem("aimy.voiceEnabled") === "1"
      } catch { return false }
    })(),
    voicePanelOpen: false,
    pendingVoiceName: "",
    ttsEngine: { state: "unknown" },
    voices: [],
    pendingAudioChunks: [],
    audioDrainedStreamIds: [],
    sttSetupOpen: false,
    sttModelSizes: {},
    sttEngine: { state: "unknown" },
    sttTestRunning: false,
    micRecording: false,
    micTranscribing: false,
    voiceDraft: false,
    providers: initialProviderRegistry(),
    providersOpen: false,
    providerTab: "llm",
    editingProviderId: undefined,
    editingDraft: { name: "", endpoint: "", engine: "" },
    addingProvider: false,
    addDraft: { name: "", kind: "local", engine: "", host: "", port: "" },
    providerTestResults: {},
    providerScanRunning: false,
    providerScanHost: "",
    providerScanResults: [],
    providerScanProgress: undefined,
    providerScanError: undefined,
    providerModels: {},
    pushToTalkKey: (() => {
      try {
        return localStorage.getItem("aimy.pushToTalkKey") ?? "ControlRight"
      } catch { return "ControlRight" }
    })(),
    pushToTalkUseMouse: (() => {
      try {
        return localStorage.getItem("aimy.pushToTalkUseMouse") === "1"
      } catch { return false }
    })(),
    micDeviceId: (() => {
      try {
        return localStorage.getItem("aimy.micDeviceId") ?? ""
      } catch { return "" }
    })(),
    micDevices: [],
  },
  memoryView: freshPlaceholder("memoryView"),
  moduleRegistry: freshPlaceholder("moduleRegistry"),
  inferencePool: freshPlaceholder("inferencePool"),
  asc: freshPlaceholder("asc"),
  jobs: freshPlaceholder("jobs"),
  banners: freshPlaceholder("banners"),
  permissions: { _tag: "permissions", pending: [], decisions: [] },
  rejections: { _tag: "rejections", records: [] },
  sovereignty: freshPlaceholder("sovereignty"),
  exportState: freshPlaceholder("exportState"),
  onboarding: freshPlaceholder("onboarding"),
  expressionPreview: freshPlaceholder("expressionPreview"),
  devtools: freshPlaceholder("devtools"),
  timeline: freshPlaceholder("timeline"),
  }
}
