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

  UserSentMessage: {
    /** Also the correlation id for the SendToInference command it produces. */
    id: Schema.String,
    text: Schema.String,
    /** Epoch millis, set by the dispatcher — update never calls Date.now for replay state. */
    at: Schema.Number,
  },

  /** Dispatched by the SendToInference command; arms the streaming state. */
  StreamStarted: {
    streamId: Schema.String,
    sessionId: Schema.String,
    input: Schema.String,
    at: Schema.Number,
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
})
export type Message = typeof Message.Type

/** Every tag in this track's vocabulary, for the exhaustiveness tests. */
export const MESSAGE_TAGS = [
  "ComposerDraftChanged",
  "UserSentMessage",
  "StreamStarted",
  "StreamChunkReceived",
  "StreamToolCallObserved",
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
] as const
