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

/** One transcript row. `role: "tool"` rows are rendered from observed tool calls. */
export const ChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "tool"]),
  text: Schema.String,
  /** Epoch millis. Monotonic within a session; display-only. */
  at: Schema.Number,
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
  messages: Schema.Array(ChatMessage),
  streaming: StreamingState,
  contextMeter: ContextMeter,
  composer: Schema.Struct({ draft: Schema.String }),
  listWindow: ListWindow,
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
  /** Voice settings panel (engine install + voice clone management). */
  voicePanelOpen: Schema.Boolean,
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
export const initialModel = (): Model => ({
  instance: freshPlaceholder("instance"),
  session: {
    _tag: "session",
    sessionId: "session-1",
    branchId: "session-1",
    messages: [],
    streaming: { active: false, streamId: "", text: "", startedAt: 0 },
    contextMeter: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      ceiling: 0,
      compactionThreshold: 0,
    },
    composer: { draft: "" },
    listWindow: { anchorIndex: 0, overscan: 8 },
    voiceEnabled: false,
    voicePanelOpen: false,
    ttsEngine: { state: "unknown" },
    voices: [],
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
})
