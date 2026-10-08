/**
 * ui/src/update.ts — the pure update function for the shell track.
 *
 * `(rawMessage, Model) -> (Model, Command[])`. Every sibling slice
 * (asc, jobs, banners, …) passes through untouched by construction: this
 * function only ever rebuilds `session`, `permissions`, and `rejections`.
 *
 * STRUCTURAL RULES (tested in update.test.ts):
 * 1. No dial-setting message exists in the vocabulary, and any raw message
 *    that fails Schema decode — including a `DialsSetDirectly`-shaped object
 *    arriving over DevTools/MCP — is REJECTED and logged to
 *    `model.rejections`, never applied. This is the architectural teeth
 *    behind "computed, not chosen" (architecture §3.2, §3.9).
 * 2. `Message.match` is exhaustive over the union: adding a variant without a
 *    handler is a compile error, and the MESSAGE_TAGS list keeps the runtime
 *    guard in sync.
 * 3. Stale stream chunks (wrong streamId — e.g. from an interrupted turn) are
 *    ignored, not applied: interruption is last-writer-wins by construction.
 * 4. Timestamps ride in on the messages themselves; update never calls
 *    Date.now() for replay state, so the DevTools timeline replays exactly.
 *    (The rejections audit uses the wall clock — it is audit metadata, not
 *    replay state — and is bounded to MAX_REJECTIONS.)
 */
import { Schema } from "effect"
import { Update } from "foldkit"
import { MemoryService } from "../../memory/service.js"
import type { SafetyKernel } from "../../permission-kernel/index.js"
import { PersistMemory, RequestPermission, SendToInference } from "./commands.js"
import {
  AddVoice,
  FetchEngineStatus,
  FetchVoices,
  InstallEngine,
  PickVoiceFile,
  SelectVoice,
} from "./voice/commands.js"
import { MAX_REJECTIONS, type Model, type RejectionRecord } from "./model.js"
import { MESSAGE_TAGS, Message } from "./messages.js"
import type { TtsIpc } from "./voice/seam.js"

/** Services the shell track's commands require; provided at the shell boundary. */
export type ShellServices = SafetyKernel | MemoryService | TtsIpc

/** Estimated transcript-row height (px) mapping scrollTop -> window anchor. */
export const ESTIMATED_ROW_PX = 64

const knownTag = (tag: string): boolean =>
  (MESSAGE_TAGS as ReadonlyArray<string>).includes(tag)

const tagOf = (raw: unknown): string | undefined =>
  typeof raw === "object" && raw !== null && "_tag" in raw && typeof raw._tag === "string"
    ? raw._tag
    : undefined

/**
 * Reject a raw message: log it to the bounded audit trail, change nothing
 * else, emit no commands. Rejection is total — no partial application.
 */
const reject = (
  model: Model,
  raw: unknown,
  reason: RejectionRecord["reason"],
): Update.Return<Model, Message, ShellServices> => {
  const records = [
    ...model.rejections.records,
    { at: Date.now(), tag: tagOf(raw) ?? "non-object", reason },
  ].slice(-MAX_REJECTIONS)
  return {
    model: {
      ...model,
      rejections: { ...model.rejections, records },
    },
  }
}

const streamingActive = (model: Model, streamId: string): boolean =>
  model.session.streaming.active && model.session.streaming.streamId === streamId

/**
 * The update function. Accepts `unknown` so the DevTools/MCP dispatch path —
 * which hands it unvalidated JSON — goes through the same rejection gate as
 * the UI. Typed callers pass `Message`; the decode is a no-op for them.
 */
export const update = (
  model: Model,
  rawMessage: unknown,
): Update.Return<Model, Message, ShellServices> => {
  if (!Schema.is(Message)(rawMessage)) {
    const tag = tagOf(rawMessage)
    const reason: RejectionRecord["reason"] =
      tag !== undefined && /dial/i.test(tag)
        ? "dial-mutation-rejected"
        : tag !== undefined && !knownTag(tag)
          ? "unknown-tag"
          : "decode-failed"
    return reject(model, rawMessage, reason)
  }

  const message: Message = rawMessage
  return Message.match<Update.Return<Model, Message, ShellServices>>(message, {
    ComposerDraftChanged: ({ text }) => ({
      model: {
        ...model,
        session: { ...model.session, composer: { draft: text } },
      },
    }),

    UserSentMessage: ({ id, text, at }) => {
      if (text.trim().length === 0) return { model }
      const sessionId = model.session.sessionId
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [
              ...model.session.messages,
              { id, role: "user", text, at },
            ],
            composer: { draft: "" },
          },
        },
        commands: [
          SendToInference({ correlationId: id, sessionId, input: text }),
          PersistMemory({ correlationId: `${id}:user`, sessionId, role: "user", text }),
        ],
      }
    },

    StreamStarted: ({ streamId, sessionId, input: _input, at }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          streaming: { active: true, streamId, text: "", startedAt: at },
        },
      },
    }),

    StreamChunkReceived: ({ streamId, delta }) => {
      // Stale chunk from an interrupted turn: ignore, never apply.
      if (!streamingActive(model, streamId)) return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            streaming: { ...model.session.streaming, text: model.session.streaming.text + delta },
          },
        },
      }
    },

    StreamToolCallObserved: ({ streamId, tool, resultSummary }) => {
      if (!streamingActive(model, streamId)) return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [
              ...model.session.messages,
              {
                id: `${streamId}-tool-${model.session.messages.length}`,
                role: "tool",
                text: `${tool}: ${resultSummary}`,
                at: model.session.streaming.startedAt,
              },
            ],
          },
        },
      }
    },

    StreamSettled: ({ streamId, text, at, usage }) => {
      if (!streamingActive(model, streamId)) return { model }
      const sessionId = model.session.sessionId
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [
              ...model.session.messages,
              { id: streamId, role: "assistant", text, at },
            ],
            streaming: { active: false, streamId: "", text: "", startedAt: 0 },
            contextMeter:
              usage === undefined
                ? model.session.contextMeter
                : {
                    ...model.session.contextMeter,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    reasoningTokens: usage.reasoningTokens,
                  },
          },
        },
        commands: [
          PersistMemory({ correlationId: `${streamId}:assistant`, sessionId, role: "assistant", text }),
        ],
      }
    },

    StreamFailed: ({ streamId, reason }) => {
      if (!streamingActive(model, streamId)) return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [
              ...model.session.messages,
              {
                id: `${streamId}-error`,
                role: "assistant",
                text: `turn failed: ${reason}`,
                at: model.session.streaming.startedAt,
              },
            ],
            streaming: { active: false, streamId: "", text: "", startedAt: 0 },
          },
        },
      }
    },

    SessionBranched: ({ fromId: _fromId, newSessionId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sessionId: newSessionId,
          branchId: newSessionId,
        },
      },
    }),

    VoiceToggled: ({ enabled }) => {
      const engineState = model.session.ttsEngine.state
      const needsPanel = enabled && (engineState === "unknown" || engineState === "missing")
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            voiceEnabled: enabled,
            // First enable with no engine: open the panel so the user can
            // install it — the toggle alone can't produce speech.
            voicePanelOpen: needsPanel ? true : model.session.voicePanelOpen,
            voiceError: undefined,
          },
        },
        ...(needsPanel ? { commands: [FetchEngineStatus({})] } : {}),
      }
    },

    ChannelsReceived: ({ streamId, audioBase64, audioUnavailableReason, expressions }) => ({
      // The audio plays in the voice subscription (a side effect); the model
      // holds the payload transiently until playback starts or is skipped.
      model: {
        ...model,
        session: {
          ...model.session,
          pendingChannels: { streamId, audioBase64, audioUnavailableReason, expressions: [...expressions] },
        },
      },
    }),

    SpeechStarted: ({ streamId }) => ({
      model: {
        ...model,
        session: { ...model.session, speakingStreamId: streamId },
      },
    }),

    SpeechEnded: ({ streamId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          speakingStreamId:
            model.session.speakingStreamId === streamId ? undefined : model.session.speakingStreamId,
        },
      },
    }),

    ChannelsConsumed: ({ streamId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          pendingChannels:
            model.session.pendingChannels?.streamId === streamId
              ? undefined
              : model.session.pendingChannels,
        },
      },
    }),

    /* -- voice panel -------------------------------------------- */

    VoicePanelToggled: ({ open }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voicePanelOpen: open,
          voiceError: undefined,
        },
      },
      ...(open ? { commands: [FetchEngineStatus({})] } : {}),
    }),

    TtsInstallRequested: () => ({
      model,
      commands: [InstallEngine({})],
    }),

    VoicesRefreshRequested: () => ({
      model,
      commands: [FetchVoices({})],
    }),

    VoiceSelectRequested: ({ voiceId }) => ({
      model,
      commands: [SelectVoice({ voiceId })],
    }),

    VoiceFilePickRequested: () => ({
      model,
      commands: [PickVoiceFile({})],
    }),

    TtsEngineStatusReceived: ({ state, detail }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          ttsEngine: {
            state,
            ...(detail !== undefined ? { detail } : {}),
          },
          voiceError: undefined,
        },
      },
      ...(state === "ready" ? { commands: [FetchVoices({})] } : {}),
    }),

    TtsEngineStatusFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          ttsEngine: { state: "failed", detail: reason },
        },
      },
    }),

    TtsInstallStarted: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          ttsEngine: { state: "installing", progressMessage: "Starting…" },
          voiceError: undefined,
        },
      },
    }),

    TtsInstallFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          ttsEngine: { state: "failed", detail: reason },
        },
      },
    }),

    TtsInstallProgressReceived: ({ phase, message }) => {
      const done = phase === "done"
      const failed = phase === "error"
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            ttsEngine: done
              ? { state: "ready" }
              : failed
                ? { state: "failed", detail: message }
                : {
                    state: "installing",
                    progressPhase: phase,
                    progressMessage: message,
                  },
            voiceError: undefined,
          },
        },
        ...(done ? { commands: [FetchVoices({})] } : {}),
      }
    },

    VoicesReceived: ({ voices }) => {
      const list = [...voices]
      const current = model.session.activeVoiceId
      const stillThere = current !== undefined && list.some((v) => v.id === current)
      const def = list.find((v) => v.isDefault)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            voices: list,
            activeVoiceId: stillThere ? current : def?.id,
            voiceError: undefined,
          },
        },
      }
    },

    VoicesFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    VoiceSelected: ({ voiceId }) => ({
      model: {
        ...model,
        session: { ...model.session, activeVoiceId: voiceId, voiceError: undefined },
      },
    }),

    VoiceSelectFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    VoiceFilePicked: ({ name, audioBase64 }) => ({
      model,
      commands: [AddVoice({ name, audioBase64 })],
    }),

    VoiceFilePickCancelled: () => ({ model }),

    VoiceFilePickFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    VoiceAdded: ({ id, name, isDefault }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voices: [...model.session.voices, { id, name, isDefault }],
          voiceError: undefined,
        },
      },
      // Select the new clone immediately.
      commands: [SelectVoice({ voiceId: id })],
    }),

    VoiceAddFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    ChatListScrolled: ({ scrollTop }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          listWindow: {
            ...model.session.listWindow,
            anchorIndex: Math.max(0, Math.floor(scrollTop / ESTIMATED_ROW_PX)),
          },
        },
      },
    }),

    PermissionRequested: ({ requestId, tool, argsSummary, riskTier, context, at }) => {
      if (model.permissions.pending.some((p) => p.requestId === requestId)) {
        return { model }
      }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            pending: [
              ...model.permissions.pending,
              { requestId, tool, argsSummary, riskTier, context, at },
            ],
          },
        },
      }
    },

    PermissionAutoAllowed: ({ requestId, at }) => {
      if (model.permissions.decisions.some((d) => d.requestId === requestId)) {
        return { model }
      }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            decisions: [
              ...model.permissions.decisions,
              { requestId, decision: "allowed-by-policy", at },
            ],
          },
        },
      }
    },

    PermissionCheckFailed: ({ requestId, denied, reason: _reason, at }) => {
      if (!denied) return { model }
      if (model.permissions.decisions.some((d) => d.requestId === requestId)) {
        return { model }
      }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            decisions: [
              ...model.permissions.decisions,
              { requestId, decision: "denied", at },
            ],
          },
        },
      }
    },

    PermissionGranted: ({ requestId, scope, at }) => {
      const pending = model.permissions.pending.find((p) => p.requestId === requestId)
      if (pending === undefined) return { model }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            pending: model.permissions.pending.filter((p) => p.requestId !== requestId),
            decisions: [
              ...model.permissions.decisions,
              {
                requestId,
                decision: scope === "always" ? "granted-always" : "granted-once",
                at,
              },
            ],
          },
        },
      }
    },

    PermissionDenied: ({ requestId, at }) => {
      // Denial kills the intent (Hermes #65592): the prompt is dropped and the
      // decision is terminal. The kernel's one-shot approve() is never called
      // for this requestId, so the agent loop's execute() fails typed — the
      // loop is structurally barred from re-attempting via another tool.
      const pending = model.permissions.pending.find((p) => p.requestId === requestId)
      if (pending === undefined) return { model }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            pending: model.permissions.pending.filter((p) => p.requestId !== requestId),
            decisions: [
              ...model.permissions.decisions,
              { requestId, decision: "denied", at },
            ],
          },
        },
      }
    },

    MemoryPersisted: (_msg) => ({ model }),

    MemoryPersistFailed: (_msg) => ({ model }),
  })
}

/** Re-exported for the foldChild composition contract (integrator pass). */
export { RequestPermission, SendToInference }
