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
import { PersistMemory, RequestPermission, SendToInference, StopNarration } from "./commands.js"
import { parseMessageTools, splitBlocks } from "./tool-calls.js";
import {
  AddVoice,
  DeleteVoice,
  FetchEngineStatus,
  FetchVoices,
  InstallEngine,
  InstallSttEngine,
  TestSttEngine,
  MicStartRecording,
  MicStopRecording,
  TranscribeMicAudio,
  ListMicDevices,
  PickVoiceFile,
  PlayVoiceSample,
  RunProviderTest,
  SelectVoice,
  SetVoiceDefault,
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
        // Manual edit clears the voice-draft flag (user took over).
        // Preserve attachments (2026-10-11).
        session: {
          ...model.session,
          composer: { draft: text, attachments: model.session.composer.attachments },
          voiceDraft: false,
        },
      },
    }),

    UserSentMessage: ({ id, text, at, images }) => {
      if (text.trim().length === 0 && (images ?? []).length === 0) return { model }
      const sessionId = model.session.sessionId
      // Derive subject from AImy's perspective: what the user is asking about
      const subject = text.trim().slice(0, 50) + (text.trim().length > 50 ? "…" : "")
      // Ghost 2 (2026-10-10): if voiceDraft was true, input came via STT.
      // Pass viaVoice so the response can auto-trigger TTS.
      const viaVoice = model.session.voiceDraft === true
      // Barge-in (2026-10-11): the user cut in while a response was still
      // streaming or its narration was playing. The loop gets this flag so
      // it can weave the unfinished thought into its reply.
      const interrupted =
        model.session.streaming.active || model.session.speakingStreamId !== undefined
      // Attachments: use message images if provided, else composer staged.
      const msgImages = images ?? model.session.composer.attachments
      const newMessages = [
        ...model.session.messages,
        { id, role: "user" as const, text, at, ...(msgImages.length > 0 ? { images: msgImages } : {}) },
      ]
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            subject,
            messages: newMessages,
            // Pin the window to the newest message (column-reverse: bottom).
            listWindow: { ...model.session.listWindow, anchorIndex: newMessages.length - 1 },
            composer: { draft: "", attachments: [] },
            voiceDraft: false,
            // Clear speaking indicator: user interrupted, narration stopped.
            speakingStreamId: undefined,
            // Drop pending audio chunks (2026-10-11): interrupted audio must
            // not replay when the new turn starts. The renderer stops the
            // active Audio object when it sees the chunks vanish.
            pendingAudioChunks: [],
          },
        },
        commands: [
          // Stop any ongoing narration: user interrupted, don't resume old content.
          StopNarration(),
          SendToInference({
            correlationId: id,
            sessionId,
            input: text,
            voiceEnabled: model.session.voiceEnabled,
            viaVoice,
            interrupted,
            images: msgImages,
          }),
          PersistMemory({ correlationId: `${id}:user`, sessionId, role: "user", text }),
        ],
      }
    },

    StreamStarted: ({ streamId, sessionId, input: _input, at, viaVoice, interrupted }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          streaming: { active: true, streamId, text: "", startedAt: at, viaVoice: viaVoice ?? false, interrupted: interrupted ?? false },
          // Clear stale speaking indicator from previous turn (2026-10-10).
          speakingStreamId: undefined,
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
      // Diagnostic: log at entry (2026-10-10: responses vanishing). If this
      // doesn't appear, the message isn't dispatched or streamingActive fails.
      console.log(`[aimy] StreamSettled ENTRY: streamId=${streamId} textLen=${text.length}`)
      if (!streamingActive(model, streamId)) {
        console.log(`[aimy] StreamSettled: streaming not active for ${streamId}, ignoring`)
        return { model }
      }
      const sessionId = model.session.sessionId
      // Estimate input tokens from local message history (system prompt ~2K + messages).
      // The IPC layer provides outputTokens; input is estimated here where history lives.
      const estimateTokens = (s: string): number => Math.ceil(s.length / 4)
      const historyTokens = model.session.messages.reduce(
        (sum, m) => sum + estimateTokens(m.text),
        2000 // system prompt estimate
      )
      // Multi-block sequencing (2026-10-10): split on /// markers into
      // separate bubbles. The transcript is the sequencer — each block
      // renders and narrates in order. Parse tool calls from the full text
      // first, then split the clean text into blocks.
      // Defensive: if parsing fails, fall back to single block with raw text
      // (2026-10-10: responses vanishing).
      let parsed: { text: string; toolsUsed: string[]; narratedTexts: string[] }
      let blocks: string[]
      try {
        parsed = parseMessageTools(text)
        blocks = splitBlocks(parsed.text)
      } catch (e) {
        console.error(`[aimy] StreamSettled: parse failed (${e instanceof Error ? e.message : e}), using raw text`)
        parsed = { text, toolsUsed: [], narratedTexts: [] }
        blocks = [text]
      }
      const toolsUsed = parsed.toolsUsed
      const narratedTexts = parsed.narratedTexts
      // Emotion tags to emoji (2026-10-10): [happy] -> 😊 for display.
      // Tags are stripped for TTS (voice carries the emotion via exaggeration).
      const EMOTION_EMOJI: Record<string, string> = {
        happy: "😊", sad: "😢", surprised: "😮", angry: "😠",
        whispering: "🤫", laughing: "😂", laugh: "😂", chuckle: "😄", giggle: "😂",
        thinking: "🤔", confused: "😕", excited: "🤩", nervous: "😬",
        shy: "🫣", playful: "😏", sarcastic: "🙄", tired: "😮‍💨",
        curious: "🧐", determined: "😤", sigh: "😮‍💨", gasp: "😲",
        dramatic: "🎭",
      }
      const toDisplay = (t: string): string =>
        t.replace(/\[(\w+)\]/g, (m, tag) => EMOTION_EMOJI[tag.toLowerCase()] ?? m)
      // Use unique IDs to avoid DOM key collisions (2026-10-10 crash fix).
      // Always suffix with block index, even for single blocks.
      // Filter empty blocks (2026-10-11): voice-only turns (narrate with no
      // chat text) should not render empty bubbles.
      const nonEmptyBlocks = blocks.filter((b) => b.trim().length > 0)
      const blockMessages = nonEmptyBlocks.map((blockText, i) => ({
        id: `${streamId}-b${i}`,
        role: "assistant" as const,
        text: toDisplay(blockText),
        at: at + i, // preserve order; millisecond offsets keep sort stable
        ...(toolsUsed.length > 0 && i === nonEmptyBlocks.length - 1 ? { toolsUsed } : {}),
        // Spoken texts for the narrate hover tooltip (2026-10-11 debug aid).
        ...(narratedTexts.length > 0 && i === nonEmptyBlocks.length - 1 ? { narratedTexts } : {}),
      }))
      // Voice: narrate-only (2026-10-11). Auto-speech disabled; the `narrate`
      // tool is the sole voice channel. Chat blocks are visual-only.
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [...model.session.messages, ...blockMessages],
            streaming: { active: false, streamId: "", text: "", startedAt: 0 },
            // Auto-scroll to newest: set anchor to end so the virtualized list
            // renders the latest bubbles (2026-10-10: fixes glitching when
            // multi-block messages arrive). The OnScroll handler will update
            // the anchor if the user scrolls up manually.
            listWindow: {
              ...model.session.listWindow,
              anchorIndex: model.session.messages.length + blockMessages.length - 1,
            },
            contextMeter:
              usage === undefined
                ? model.session.contextMeter
                : {
                    ...model.session.contextMeter,
                    inputTokens: historyTokens,
                    outputTokens: usage.outputTokens,
                    reasoningTokens: usage.reasoningTokens,
                  },
          },
        },
        commands: [
          // Persist each block; correlate to the parent stream.
          ...blockMessages.map((m, i) =>
            PersistMemory({
              correlationId: `${m.id}:assistant`,
              sessionId,
              role: "assistant",
              text: m.text,
            })
          ),
          // Voice: narrate-only (2026-10-11).
          // Auto-speech permanently disabled — the `narrate` tool is the sole
          // voice channel. The model speaks via narrate (interaction); chat
          // blocks are visual-only (information). No auto-SpeakText dispatch.
          // TEMP DISABLED 2026-10-10: FocusComposer/ScrollToBottom/RenderMermaid
          // crash with "Schema validation failed". The command definitions
          // need rework — doing DOM ops via commands isn't the right pattern.
          // FocusComposer(),
          // ScrollToBottom(),
          // RenderMermaid() — crashes with Schema validation failed (2026-10-10 21:31).
          // Needs rework: mermaid rendering should happen in the view layer,
          // not via a command. Disabled until then.
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
      try {
        localStorage.setItem("aimy.voiceEnabled", enabled ? "1" : "0")
      } catch { /* private mode */ }
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

    MicPreRollChanged: ({ status }) => ({
      model: {
        ...model,
        session: { ...model.session, micPreRoll: status },
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

    AudioChunkReceived: ({ streamId, sequence, audioBase64 }) => ({
      // NOTE (2026-10-11): a streamId-based stale filter was tried here but
      // the main process broadcasts all chunks with streamId "narration"
      // (handlers.ts), so it dropped every chunk mid-turn. Stale audio after
      // an interrupt is handled by the pendingAudioChunks clear on
      // UserSentMessage + stopAllAudio() in the renderer's audio pump.
      model: {
        ...model,
        session: {
          ...model.session,
          pendingAudioChunks: [
            ...model.session.pendingAudioChunks,
            { streamId, sequence, audioBase64 },
          ],
        },
      },
    }),

    AudioDrainedReceived: ({ streamId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          audioDrainedStreamIds: model.session.audioDrainedStreamIds.includes(streamId)
            ? model.session.audioDrainedStreamIds
            : [...model.session.audioDrainedStreamIds, streamId],
        },
      },
    }),

    AudioChunksConsumed: ({ streamId, sequences }) => {
      const seqSet = new Set(sequences)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            pendingAudioChunks: model.session.pendingAudioChunks.filter(
              (c) => !(c.streamId === streamId && seqSet.has(c.sequence))
            ),
          },
        },
      }
    },

    TtsSpoken: () => ({ model }),

    /* -- voice panel -------------------------------------------- */

    VoicePanelToggled: ({ open }) => {
      const engineReady = model.session.ttsEngine.state === "ready"
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            voicePanelOpen: open,
            voiceError: undefined,
            // Auto-test provider health on open (if engine ready).
            ...(open && engineReady ? { providerTestRunning: true } : {}),
          },
        },
        ...(open
          ? {
              commands: [
                FetchEngineStatus({}),
                // Auto-run provider health check when panel opens.
                ...(engineReady ? [RunProviderTest({})] : []),
              ],
            }
          : {}),
      }
    },

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

    VoiceNameChanged: ({ name }) => ({
      model: {
        ...model,
        session: { ...model.session, pendingVoiceName: name },
      },
    }),

    VoiceDeleteRequested: ({ voiceId }) => ({
      model: {
        ...model,
        session: { ...model.session, pendingDeleteVoiceId: voiceId },
      },
    }),

    VoiceDeleteConfirmed: () => {
      const voiceId = model.session.pendingDeleteVoiceId
      if (voiceId === undefined) return { model }
      return {
        model: {
          ...model,
          session: { ...model.session, pendingDeleteVoiceId: undefined },
        },
        commands: [DeleteVoice({ voiceId })],
      }
    },

    VoiceDeleteCancelled: () => ({
      model: {
        ...model,
        session: { ...model.session, pendingDeleteVoiceId: undefined },
      },
    }),

    VoiceSampleRequested: ({ voiceId }) => ({
      model,
      commands: [PlayVoiceSample({ voiceId })],
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

    VoiceDeleted: ({ voiceId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voices: model.session.voices.filter((v) => v.id !== voiceId),
          activeVoiceId: model.session.activeVoiceId === voiceId ? undefined : model.session.activeVoiceId,
          // Don't clear voiceError here — let the user dismiss it explicitly.
        },
      },
    }),

    VoiceDeleteFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    VoiceSamplePlayed: () => ({
      model: {
        ...model,
        session: { ...model.session, playingSampleVoiceId: undefined },
      },
    }),

    VoiceSampleFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason, playingSampleVoiceId: undefined },
      },
    }),

    VoiceErrorDismissed: () => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: undefined },
      },
    }),

    VoiceSetDefaultRequested: ({ voiceId }) => ({
      model,
      commands: [SetVoiceDefault({ voiceId })],
    }),

    VoiceDefaultSet: ({ voiceId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voices: model.session.voices.map((v) => ({
            ...v,
            isDefault: v.id === voiceId,
          })),
          voiceError: undefined,
        },
      },
    }),

    VoiceDefaultSetFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    SttSetupOpened: () => ({
      model: {
        ...model,
        session: { ...model.session, sttSetupOpen: true },
      },
    }),

    SttEngineStatusReceived: ({ state, engine, detail }) => {
      const validStates = ["unknown", "missing", "installing", "ready", "failed"] as const
      const safeState = (validStates as readonly string[]).includes(state)
        ? state as typeof validStates[number]
        : "unknown" as const
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            sttEngine: {
              state: safeState,
              ...(engine !== undefined ? { engine } : {}),
              ...(detail !== undefined ? { detail } : {}),
            },
          },
        },
      }
    },

    SttSetupClosed: () => ({
      model: {
        ...model,
        session: { ...model.session, sttSetupOpen: false },
      },
    }),

    SttModelSizeChanged: ({ engine, size }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttModelSizes: { ...model.session.sttModelSizes, [engine]: size },
        },
      },
    }),

    SttInstallRequested: ({ engine }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttEngine: { state: "installing", progressMessage: "Starting…", engine },
        },
      },
      commands: [InstallSttEngine({ engine })],
    }),

    SttInstallProgressReceived: ({ message }) => {
      // "done" phase means the install completed — mark ready and close the dialog.
      const done = message.toLowerCase().includes("installed") || message === "STT engine installed."
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            sttEngine: done
              ? { state: "ready", engine: model.session.sttEngine.engine }
              : { state: "installing", progressMessage: message, engine: model.session.sttEngine.engine },
            sttSetupOpen: done ? false : model.session.sttSetupOpen,
          },
        },
      }
    },

    SttTestRequested: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttTestRunning: true,
        },
      },
      commands: [TestSttEngine({})],
    }),
    SttTestCompleted: ({ latencyMs, modelSizeMb }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttTestRunning: false,
          sttTestResults: { latencyMs, modelSizeMb },
        },
      },
    }),
    SttTestFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttTestRunning: false,
          voiceError: `STT test failed: ${reason}`,
        },
      },
    }),
    MicRecordToggled: () => {
      // Toggle recording. The actual MediaRecorder lives in the renderer;
      // this flips the intent, and the renderer reports back via
      // MicRecordingStarted / MicRecordingStopped / MicFailed.
      const starting = !model.session.micRecording
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            micRecording: starting,
            ...(starting ? {} : { micTranscribing: true }),
          },
        },
        commands: starting ? [MicStartRecording({})] : [MicStopRecording({})],
      }
    },
    MicRecordingStarted: () => ({
      model: {
        ...model,
        session: { ...model.session, micRecording: true },
      },
    }),
    MicRecordingStopped: ({ audioBase64 }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          micRecording: false,
          micTranscribing: true,
        },
      },
      commands: [TranscribeMicAudio({ audioBase64 })],
    }),
    MicTranscribed: ({ text }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          micTranscribing: false,
          composer: { draft: model.session.composer.draft + text, attachments: model.session.composer.attachments },
          // Mark draft as voice-originated: enables click-to-send /
          // right-click-to-discard. Cleared on manual edit or send.
          voiceDraft: true,
        },
      },
    }),
    /** User confirmed the voice draft (click-to-send). */
    VoiceDraftSent: () => ({
      model: {
        ...model,
        session: { ...model.session, voiceDraft: false },
      },
    }),
    /** User discarded the voice draft (right-click). */
    VoiceDraftDiscarded: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voiceDraft: false,
          composer: { draft: "", attachments: [] },
        },
      },
    }),
    /** Global click confirmed voice draft — send current draft as message. */
    VoiceDraftConfirmed: () => {
      const draft = model.session.composer.draft
      if (draft.trim().length === 0) {
        return { model }
      }
      const id = `msg-${Date.now()}`
      const sessionId = model.session.sessionId
      // Same barge-in semantics as UserSentMessage (2026-10-11).
      const interrupted =
        model.session.streaming.active || model.session.speakingStreamId !== undefined
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [
              ...model.session.messages,
              { id, role: "user", text: draft, at: Date.now() },
            ],
            composer: { draft: "", attachments: [] },
            voiceDraft: false,
            speakingStreamId: undefined,
            pendingAudioChunks: [],
          },
        },
        commands: [
          StopNarration(),
          SendToInference({ correlationId: id, sessionId, input: draft, voiceEnabled: model.session.voiceEnabled, viaVoice: false, interrupted, images: [] }),
          PersistMemory({ correlationId: `${id}:user`, sessionId, role: "user", text: draft }),
        ],
      }
    },
    /* ── Provider registry ─────────────────────────────────────────── */
    ProvidersLoaded: ({ registry }) => {
      // Validate and merge the loaded registry.
      const r = registry as {
        providers?: Array<{
          id: string
          name: string
          category: "llm" | "vision" | "tts" | "stt" | "image"
          kind: "local" | "remote"
          enabled: boolean
          engine?: string
          endpoint?: string
          config?: Record<string, string>
          stats?: { latencyMs?: number; throughput?: number; modelSizeMb?: number; lastTestedAt?: number; testCount: number }
        }>
        activeId?: Record<string, string | undefined>
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            providers: {
              providers: (r.providers ?? []).map((p) => ({
                ...p,
                config: p.config ?? {},
                stats: p.stats ?? { testCount: 0 },
              })),
              activeId: r.activeId ?? {},
            },
          },
        },
      }
    },
    ProvidersOpened: () => ({
      model: {
        ...model,
        session: { ...model.session, providersOpen: true },
      },
    }),
    ProvidersClosed: () => ({
      model: {
        ...model,
        session: { ...model.session, providersOpen: false },
      },
    }),
    ProviderTabChanged: ({ tab }) => ({
      model: {
        ...model,
        session: { ...model.session, providerTab: tab },
      },
    }),
    ProviderAdded: ({ name, category, kind, engine, endpoint }) => {
      const id = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newProvider = {
        id,
        name,
        category: category as "llm" | "vision" | "tts" | "stt" | "image",
        kind: kind as "local" | "remote",
        enabled: true,
        ...(engine !== undefined ? { engine } : {}),
        ...(endpoint !== undefined ? { endpoint } : {}),
        config: {},
        stats: { testCount: 0 },
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            providers: {
              ...model.session.providers,
              providers: [...model.session.providers.providers, newProvider],
            },
          },
        },
      }
    },
    ProviderUpdated: ({ id, name, endpoint, engine, config }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id
                ? {
                    ...p,
                    name,
                    ...(endpoint !== undefined ? { endpoint } : {}),
                    ...(engine !== undefined ? { engine } : {}),
                    config,
                  }
                : p
            ),
          },
          // Close the edit form after saving.
          editingProviderId: undefined,
        },
      },
    }),
    ProviderDeleted: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            providers: model.session.providers.providers.filter((p) => p.id !== id),
            activeId: Object.fromEntries(
              Object.entries(model.session.providers.activeId).map(([cat, active]) => [
                cat,
                active === id ? undefined : active,
              ])
            ) as Record<string, string | undefined>,
          },
          // Close the edit form if we deleted the provider being edited.
          editingProviderId: model.session.editingProviderId === id ? undefined : model.session.editingProviderId,
        },
      },
    }),
    ProviderEditOpened: ({ id }) => {
      const p = model.session.providers.providers.find((x) => x.id === id)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            editingProviderId: id,
            editingDraft: {
              name: p?.name ?? "",
              endpoint: p?.endpoint ?? "",
              engine: p?.engine ?? "",
            },
          },
        },
      }
    },
    ProviderEditClosed: () => ({
      model: {
        ...model,
        session: { ...model.session, editingProviderId: undefined },
      },
    }),
    ProviderEditDraftChanged: ({ field, value }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          editingDraft: { ...model.session.editingDraft, [field]: value },
        },
      },
    }),
    ProviderAddOpened: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          addingProvider: true,
          addDraft: { name: "", kind: "local", engine: "", host: "", port: "" },
        },
      },
    }),
    ProviderAddClosed: () => ({
      model: {
        ...model,
        session: { ...model.session, addingProvider: false },
      },
    }),
    ProviderAddDraftChanged: ({ field, value }) => {
      const draft = model.session.addDraft
      // Auto-populate name from engine if name is empty.
      const autoName =
        field === "engine" && !draft.name.trim() ? value : draft.name
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            addDraft: {
              ...draft,
              [field]: value,
              ...(field === "engine" && !draft.name.trim() ? { name: value } : {}),
            },
          },
        },
      }
    },
    ProviderCreateFromDraft: ({ category }) => {
      const d = model.session.addDraft
      const id = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const isRemote = d.kind === "remote"
      const endpoint = isRemote && d.host ? `http://${d.host}${d.port ? `:${d.port}` : ""}` : undefined
      const newProvider = {
        id,
        name: d.name || `New ${category.toUpperCase()} provider`,
        category: category as "llm" | "vision" | "tts" | "stt" | "image",
        kind: d.kind as "local" | "remote",
        enabled: true,
        engine: !isRemote && d.engine ? d.engine : undefined,
        endpoint,
        config: {},
        stats: { testCount: 0 },
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            providers: {
              ...model.session.providers,
              providers: [...model.session.providers.providers, newProvider],
            },
            addingProvider: false,
          },
        },
      }
    },
    ProviderToggled: ({ id, enabled }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id ? { ...p, enabled } : p
            ),
          },
        },
      },
    }),
    ProviderSetActive: ({ category, id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            activeId: {
              ...model.session.providers.activeId,
              [category]: id,
            },
          },
        },
      },
    }),
    ProviderBenchmarkRequested: ({ id }) => ({
      model,
      // TODO: dispatch benchmark command via IPC
    }),
    ProviderConnectionTestRequested: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerTestResults: {
            ...model.session.providerTestResults,
            [id]: "testing...",
          },
        },
      },
    }),
    ProviderConnectionTestCompleted: ({ id, detail }) => {
      // If this is a remote LLM/vision provider, auto-request the model list.
      const provider = model.session.providers.providers.find((p) => p.id === id)
      const shouldFetchModels =
        provider?.kind === "remote" &&
        (provider.category === "llm" || provider.category === "vision") &&
        provider.endpoint
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            providerTestResults: {
              ...model.session.providerTestResults,
              [id]: `OK: ${detail}`,
            },
            // Trigger model fetch by setting empty array.
            ...(shouldFetchModels
              ? {
                  providerModels: {
                    ...model.session.providerModels,
                    [id]: [],
                  },
                }
              : {}),
          },
        },
      }
    },
    ProviderConnectionTestFailed: ({ id, reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerTestResults: {
            ...model.session.providerTestResults,
            [id]: `Failed: ${reason}`,
          },
        },
      },
    }),
    ProviderScanRequested: ({ host }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerScanRunning: true,
          providerScanHost: host,
          providerScanResults: [],
          providerScanProgress: { scanned: 0, total: 254 },
          providerScanError: undefined,
        },
      },
    }),
    ProviderScanProgress: ({ scanned, total }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerScanProgress: { scanned, total },
        },
      },
    }),
    ProviderScanCompleted: ({ host, found }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerScanRunning: false,
          providerScanResults: found,
          providerScanProgress: undefined,
        },
      },
    }),
    ProviderScanFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerScanRunning: false,
          providerScanError: reason,
          providerScanProgress: undefined,
        },
      },
    }),
    ProviderScanResultSelected: ({ host, port, service }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          addDraft: {
            ...model.session.addDraft,
            host,
            port: String(port),
            // Auto-name from the detected service.
            name: `${service} (${host}:${port})`,
          },
        },
      },
    }),
    ProviderModelsRequested: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerModels: {
            ...model.session.providerModels,
            [id]: [], // clearing triggers the subscription to fetch
          },
        },
      },
    }),
    ProviderModelsLoaded: ({ id, models }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerModels: {
            ...model.session.providerModels,
            [id]: [...models],
          },
        },
      },
    }),
    ProviderModelSelected: ({ id, model: selectedModel }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id
                ? { ...p, config: { ...p.config, model: selectedModel } }
                : p
            ),
          },
        },
      },
    }),
    ProviderStreamingToggled: ({ id, streaming }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id
                ? { ...p, config: { ...p.config, streaming: streaming ? "true" : "false" } }
                : p
            ),
          },
        },
      },
    }),
    ProviderBenchmarkCompleted: ({ id, latencyMs, throughput, modelSizeMb }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id
                ? {
                    ...p,
                    stats: {
                      latencyMs,
                      ...(throughput !== undefined ? { throughput } : {}),
                      ...(modelSizeMb !== undefined ? { modelSizeMb } : {}),
                      lastTestedAt: Date.now(),
                      testCount: p.stats.testCount + 1,
                    },
                  }
                : p
            ),
          },
        },
      },
    }),
    ProviderBenchmarkFailed: ({ id, reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          // TODO: surface error in UI
        },
      },
    }),
    MicFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          micRecording: false,
          micTranscribing: false,
          voiceError: `Microphone: ${reason}`,
        },
      },
    }),
    PushToTalkKeyChanged: ({ key, useMouse }) => {
      try {
        localStorage.setItem("aimy.pushToTalkKey", key)
        localStorage.setItem("aimy.pushToTalkUseMouse", useMouse ? "1" : "0")
      } catch { /* ignore */ }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            pushToTalkKey: key,
            pushToTalkUseMouse: useMouse,
          },
        },
      }
    },
    MicDeviceChanged: ({ deviceId }) => {
      try {
        localStorage.setItem("aimy.micDeviceId", deviceId)
      } catch { /* ignore */ }
      return {
        model: {
          ...model,
          session: { ...model.session, micDeviceId: deviceId },
        },
      }
    },
    MicDevicesRequested: () => ({
      model,
      commands: [ListMicDevices({})],
    }),
    MicDevicesReceived: ({ devices }) => ({
      model: {
        ...model,
        session: { ...model.session, micDevices: [...devices] },
      },
    }),
    SttInstallFailed: ({ reason }) => {
      // Ignore the dummy "install started" signal from the fire-and-forget command.
      if (reason === "__install_started__") return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            sttEngine: { state: "failed", detail: reason },
          },
        },
      }
    },

    // Legacy TTS battery messages (UI removed, commands may still dispatch).
    // These are no-ops now that provider testing lives in Settings.
    ProviderTestRequested: () => ({ model }),
    ProviderTestCompleted: () => ({ model }),
    ProviderTestFailed: () => ({ model }),

    VoiceFilePicked: ({ name, audioBase64 }) => {      // Use the pending name if the user typed one, else fall back to filename.
      const finalName = model.session.pendingVoiceName.trim() || name
      return {
        model: {
          ...model,
          session: { ...model.session, pendingVoiceName: "" },
        },
        commands: [AddVoice({ name: finalName, audioBase64 })],
      }
    },

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

    ChatListScrolled: ({ scrollTop }) => {
      // Column-reverse layout (2026-10-10): scrollTop=0 is the visual BOTTOM
      // (newest messages). The anchor must count from the end, not the start.
      // Without this inversion, scrolling up renders the wrong window and
      // bubbles vanish (2026-10-11).
      const total = model.session.messages.length
      const fromBottom = Math.floor(scrollTop / ESTIMATED_ROW_PX)
      const anchorIndex = Math.max(0, total - 1 - fromBottom)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            listWindow: {
              ...model.session.listWindow,
              anchorIndex,
            },
          },
        },
      }
    },

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

    /* ── Image attachments (2026-10-11: drag-and-drop) ─────────────── */
    ImageDropped: ({ id, dataUrl, name, mimeType }) => {
      // Max 4 images per message.
      const current = model.session.composer.attachments
      if (current.length >= 4) return { model }
      // 10MB total limit (approximate via dataUrl length).
      const totalBytes = current.reduce((n, a) => n + a.dataUrl.length, 0) + dataUrl.length
      if (totalBytes > 10 * 1024 * 1024 * 1.37) return { model } // base64 ~1.37x
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            composer: {
              ...model.session.composer,
              attachments: [...current, { id, dataUrl, name, mimeType }],
            },
          },
        },
      }
    },

    AttachmentRemoved: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          composer: {
            ...model.session.composer,
            attachments: model.session.composer.attachments.filter((a) => a.id !== id),
          },
        },
      },
    }),
  })
}

/** Re-exported for the foldChild composition contract (integrator pass). */
export { RequestPermission, SendToInference }
