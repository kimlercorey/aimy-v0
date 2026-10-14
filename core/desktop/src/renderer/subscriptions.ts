/**
 * desktop/src/renderer/subscriptions.ts — the renderer's live token pump.
 *
 * The M8 composed app has no subscriptions of its own; the old shell app
 * (`ui/src/app.ts`) pumped `AgentLoop.chat` directly. Here the engine lives
 * in the main process, so the pump goes through Track 2's IPC client:
 *
 * - `chatPump`: when the shell slice arms `streaming` (via the
 *   `SendToInference` command → `StreamStarted`), this opens
 *   `client.chatStream(sessionId, input)` and maps token deltas to the
 *   shell's `StreamChunkReceived` / `StreamSettled` / `StreamFailed`
 *   messages. Stream teardown (deps change / new turn) calls the handle's
 *   `cancel()` — the protocol's chat.cancel path (fiber interrupt, no
 *   post-cancel side effects).
 * - `ipcEvents`: the always-on subscription. On start it refreshes every
 *   IPC-backed slice (banners, jobs, timeline) and reads the ASC dials once;
 *   afterwards it forwards `banner.published` → banner refresh and
 *   `asc.dialsUpdated` → the ASC slice.
 *
 * Two deliberate notes:
 * 1. `input` is derived from the model (the user message whose id armed the
 *    stream) — update stays pure and the pump needs no out-of-band channel.
 * 2. The ASC slice only writes dials via `DialComputationArchived`, which
 *    needs a full computation. An IPC dial read is therefore wrapped in a
 *    computation whose id is prefixed `ipc-read:` — it is never presented
 *    as a pipeline-archived turn, and the dial history stays labeled.
 */
import { Effect, Queue, Schema, Stream } from "effect"
import { make as makeSubscriptions } from "foldkit/subscription"
import { getMicPreRollStatus, setupPushToTalk } from "./resources.js"

import type { DialVector } from "../../../asc-engine/index.js"
import {
  AppMessage,
  type AppModel
} from "../../../ui/src/composed/index.js"
import { Message as ShellMessage } from "../../../ui/src/messages.js"
import { uiStateMarker } from "../../../ui/src/update.js"
import { BannersMessage } from "../../../ui/src/ops/index.js"
import { JobsMessage } from "../../../ui/src/ops/index.js"
import { Message as TimelineMessage } from "../../../ui/src/timeline/index.js"
import { AscPanelMessage, type ArchivedComputation } from "../../../ui/src/asc/index.js"
import type { AUFrame as AscAUFrame } from "../../../ui/src/asc/model.js"
import { ChunkSanitizer } from "../../../ui/src/rendering.js"

import { getClient } from "./ipc.js"

/** Wrap an IPC dial read so the ASC slice accepts it — provenance in the id. */
const ipcReadComputation = (dials: DialVector): ArchivedComputation => ({
  id: `ipc-read:${new Date().toISOString()}`,
  turn: 0,
  at: new Date().toISOString(),
  finalDials: {
    warmth: dials.warmth,
    playfulness: dials.playfulness,
    intensity: dials.intensity,
    vulnerability: dials.vulnerability
  },
  guardFired: false,
  gated: false,
  gateReason: ""
})

const ascDialsMessage = (dials: DialVector): AppMessage =>
  AppMessage.GotAsc({
    message: AscPanelMessage.DialComputationArchived({ computation: ipcReadComputation(dials) })
  })

/** The chat stream's error channel is unreachable: the generator below catches everything. */
const unreachableStreamError = (_error: unknown): never => {
  throw new Error("chat pump: unreachable stream error")
}

/**
 * Marker prepended to the IPC input when the turn barged in on a previous
 * response (2026-10-11). `loop.ts` strips it and injects the interruption
 * context — this avoids changing the IPC protocol, the client, the engine,
 * and the AgentLoop signatures for one boolean. The marker never reaches
 * the model, the UI, or persisted history.
 */
const INTERRUPTED_MARKER = "[AIMY-INTERRUPTED]\n"

/** One chat turn over the bridge. Deltas are sanitized at this boundary (Pi #10504). */
const pumpChat = (
  shellStreamId: string,
  sessionId: string,
  input: string,
  interrupted: boolean,
  images?: ReadonlyArray<{ dataUrl: string; mimeType: string; name: string }>,
  promptText?: string,
): Stream.Stream<AppMessage> => {
  const client = getClient()
  const handle = client.chatStream(sessionId, interrupted ? INTERRUPTED_MARKER + input : input, images, promptText)
  const sanitizer = new ChunkSanitizer()
  let text = ""
  let completedNaturally = false

  const messages = (async function* (): AsyncGenerator<AppMessage> {
    try {
      for await (const delta of handle) {
        const clean = sanitizer.push(delta)
        text += clean
        yield AppMessage.GotShell({
          message: ShellMessage.StreamChunkReceived({ streamId: shellStreamId, delta: clean })
        })
      }
      const outputTokens = handle.outputTokens()
      completedNaturally = true
      yield AppMessage.GotShell({
        message: ShellMessage.StreamSettled({
          streamId: shellStreamId,
          text,
          at: Date.now(),
          ...(outputTokens !== undefined
            ? { usage: { inputTokens: 0, outputTokens, reasoningTokens: 0 } }
            : {})
        })
      })
    } catch (error) {
      yield AppMessage.GotShell({
        message: ShellMessage.StreamFailed({
          streamId: shellStreamId,
          reason: error instanceof Error ? error.message : String(error)
        })
      })
    }
  })()

  return Stream.fromAsyncIterable(messages, unreachableStreamError).pipe(
    // Interrupt the engine stream on teardown — but only if it didn't complete
    // naturally (2026-10-10: fixes systematic "already gone" cancel on every stream).
    Stream.ensuring(Effect.sync(() => {
      if (!completedNaturally) {
        handle.cancel()
      }
    }))
  )
}

/**
 * Voice pump: plays a settled turn's TTS audio and drives the expression
 * preview through its AU timeline while speech plays.
 *
 * Dependencies arm when a channels payload is pending AND voice is on.
 * The generator:
 * 1. yields SpeechStarted + ChannelsConsumed (claim the payload),
 * 2. plays the audio (no audio → skip to step 4),
 * 3. yields each expression cue at its atMs offset, racing speech end,
 * 4. yields ExpressionFrameCleared + SpeechEnded.
 *
 * Teardown (deps change / new turn) ends the generator; the next update
 * cycle clears the frame via SpeechEnded's absence — a new turn never
 * inherits the old one's face because each pump clears on completion.
 */
interface VoiceDeps {
  readonly streamId: string
  readonly voiceEnabled: boolean
  readonly audioBase64: string | undefined
  readonly expressions: ReadonlyArray<{ atMs: number; frame: Record<string, number> }>
}

const toAUFrame = (record: Record<string, number>): AscAUFrame => ({
  browRaise: record["browRaise"] ?? 0,
  browLower: record["browLower"] ?? 0,
  eyeOpen: record["eyeOpen"] ?? 0,
  lidTighten: record["lidTighten"] ?? 0,
  smile: record["smile"] ?? 0,
  mouthCornerDepress: record["mouthCornerDepress"] ?? 0,
  lipPress: record["lipPress"] ?? 0,
  jawDrop: record["jawDrop"] ?? 0,
  headTiltDeg: record["headTiltDeg"] ?? 0,
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Global audio interruption (2026-10-11): tracks active Audio elements so
 * user interruption (new message, mic input) can stop playback immediately.
 * The NarrationQueue.clear() in main stops synthesis, but the renderer must
 * stop the already-playing Audio object itself.
 */
const activeAudioElements = new Set<HTMLAudioElement>()
let audioEpoch = 0
let lastAudioStreamId = ""

/**
 * Debug trace (2026-10-11): forward one event to the main-process trace
 * writer. Fire-and-forget; no-op unless debugTrace is on. Never throws.
 */
const traceLog = (trace: string, event: string, fields?: Record<string, unknown>): void => {
  try {
    const cmd = fields !== undefined
      ? { _tag: "trace.log", trace, event, fields } as const
      : { _tag: "trace.log", trace, event } as const
    void getClient().invoke(cmd).catch(() => undefined)
  } catch {
    // Bridge unavailable — tracing must never break the app.
  }
}

export const stopAllAudio = (reason = "unspecified"): void => {
  audioEpoch++
  console.log(`[aimy] audio: stopAllAudio (epoch=${audioEpoch}, elements=${activeAudioElements.size}) reason=${reason}`)
  traceLog("audio", "audio.stopped", { reason, epoch: audioEpoch, elements: activeAudioElements.size })
  for (const audio of activeAudioElements) {
    try {
      audio.pause()
      // Reset source to release the resource and prevent resume.
      audio.src = ""
    } catch {
      // Already stopped — nothing to do.
    }
  }
  activeAudioElements.clear()
}

/**
 * Replay guard (2026-10-11): sequences marked consumed in-memory the moment
 * they finish playing. The `AudioChunksConsumed` model update is async — if
 * the subscription re-fires before it's processed, the new pump would replay
 * the same chunk. This set is the synchronous source of truth; the model
 * update is for long-term cleanup. Cleared when the queue empties or the
 * stream changes.
 */
const consumedAudioSequences = new Set<number>()
let consumedAudioStreamId = ""

const pumpVoice = (deps: VoiceDeps): Stream.Stream<AppMessage> => {
  const messages = (async function* (): AsyncGenerator<AppMessage> {
    const { streamId, audioBase64, expressions } = deps
    yield AppMessage.GotShell({
      message: ShellMessage.ChannelsConsumed({ streamId }),
    })
    if (audioBase64 === undefined) return

    yield AppMessage.GotShell({
      message: ShellMessage.SpeechStarted({ streamId }),
    })

    const audio = new Audio(`data:audio/wav;base64,${audioBase64}`)
    let playFailed = false
    const playDone = (async (): Promise<void> => {
      try {
        await audio.play()
      } catch {
        playFailed = true
        return
      }
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve()
        audio.onerror = () => resolve() // a failed play still ends speech
      })
    })()

    // Yield each cue at its offset; stop early when speech ends.
    let lastAt = 0
    for (const cue of expressions) {
      const wait = Math.max(0, cue.atMs - lastAt)
      lastAt = cue.atMs
      const outcome = await Promise.race([
        delay(wait).then((): "cue" => "cue"),
        playDone.then((): "done" => "done"),
      ])
      if (outcome === "done" || playFailed) break
      yield AppMessage.GotAsc({
        message: AscPanelMessage.ExpressionFrameShown({ frame: toAUFrame(cue.frame) }),
      })
    }
    await playDone
    try {
      audio.pause()
    } catch {
      // Already stopped — nothing to do.
    }

    yield AppMessage.GotAsc({ message: AscPanelMessage.ExpressionFrameCleared() })
    yield AppMessage.GotShell({ message: ShellMessage.SpeechEnded({ streamId }) })
  })()

  return Stream.fromAsyncIterable(messages, unreachableStreamError)
}

interface ChunkDeps {
  readonly streamId: string
  readonly voiceEnabled: boolean
  readonly chunks: ReadonlyArray<{ sequence: number; audioBase64: string }>
  readonly drained: boolean
}

/**
 * Gapless playback of ordered narration audio chunks (from the `narrate`
 * tool). Chunks play in sequence order, chained via onended — no gaps.
 * When drained and the queue empties, speech ends.
 */
const pumpAudioChunks = (deps: ChunkDeps): Stream.Stream<AppMessage> => {
  const messages = (async function* (): AsyncGenerator<AppMessage> {
    const { streamId, chunks, drained } = deps
    if (chunks.length === 0) return

    // Sort by sequence to ensure order even if events arrived out of order.
    const ordered = [...chunks].sort((a, b) => a.sequence - b.sequence)

    yield AppMessage.GotShell({
      message: ShellMessage.SpeechStarted({ streamId }),
    })
    const playStartTime = Date.now()
    console.log(`[aimy] audio playback started: streamId=${streamId} t=${playStartTime}`)
    traceLog(streamId, "audio.playback_start", { chunks: ordered.length, drained, pendingDepth: chunks.length })

    const playedSequences: Array<number> = []
    const startEpoch = audioEpoch
    let interrupted = false
    for (const chunk of ordered) {
      // Interruption check: if epoch changed, another turn started — abort.
      if (audioEpoch !== startEpoch) {
        console.log(`[aimy] audio: interrupted (epoch ${startEpoch} → ${audioEpoch}), stopping playback`)
        traceLog(streamId, "audio.playback_interrupted", { atSeq: chunk.sequence, played: playedSequences.length })
        interrupted = true
        break
      }
      const chunkStart = Date.now()
      const audio = new Audio(`data:audio/wav;base64,${chunk.audioBase64}`)
      activeAudioElements.add(audio)
      try {
        await audio.play()
      } catch (error) {
        // Log playback failures — silent skips hide broken audio.
        console.error(`[aimy] audio.play failed for chunk ${chunk.sequence}:`, error)
        traceLog(streamId, "audio.play_failed", { seq: chunk.sequence, error: error instanceof Error ? error.message : String(error) })
        activeAudioElements.delete(audio)
        continue
      }
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
      })
      activeAudioElements.delete(audio)
      // Check interruption again after playback (may have been stopped).
      if (audioEpoch !== startEpoch) {
        console.log(`[aimy] audio: interrupted during chunk ${chunk.sequence}, stopping`)
        traceLog(streamId, "audio.playback_interrupted", { atSeq: chunk.sequence, played: playedSequences.length })
        interrupted = true
        break
      }
      const chunkEnd = Date.now()
      console.log(`[aimy] audio chunk done: seq=${chunk.sequence} duration=${chunkEnd - chunkStart}ms`)
      traceLog(streamId, "audio.chunk_done", { seq: chunk.sequence, playMs: chunkEnd - chunkStart })
      playedSequences.push(chunk.sequence)
      // Mark consumed in-memory IMMEDIATELY (2026-10-11 replay guard).
      // Do NOT yield here — yielding mid-loop re-triggers the subscription
      // before the model update lands, causing a replay. The in-memory set
      // is the synchronous guard; the model update batches at the end.
      consumedAudioSequences.add(chunk.sequence)
    }

    // On interruption, mark ALL remaining chunks consumed in-memory so they
    // never replay. The subscription re-fires on non-empty pendingAudioChunks;
    // without this, an interrupted chunk comes back from the start.
    if (interrupted) {
      const remaining = ordered.map((c) => c.sequence).filter((s) => !playedSequences.includes(s))
      for (const s of remaining) consumedAudioSequences.add(s)
      if (remaining.length > 0) {
        console.log(`[aimy] audio: consuming ${remaining.length} interrupted chunks so they don't replay`)
        traceLog(streamId, "audio.chunks_consumed_on_interrupt", { sequences: remaining })
      }
    }

    // Batch the model update at the end (single yield, no re-entrancy).
    const allConsumed = [...playedSequences, ...(interrupted
      ? ordered.map((c) => c.sequence).filter((s) => !playedSequences.includes(s))
      : [])]
    if (allConsumed.length > 0) {
      yield AppMessage.GotShell({
        message: ShellMessage.AudioChunksConsumed({ streamId, sequences: allConsumed }),
      })
    }

    // End speech after this batch. If more chunks arrive, the subscription
    // re-fires and SpeechStarted will fire again. (2026-10-10: was gated on
    // `drained`, but drained was often false, leaving the speaking indicator stuck.)
    {
      const playEndTime = Date.now()
      console.log(`[aimy] audio playback ended: streamId=${streamId} total=${playEndTime - playStartTime}ms chunks=${playedSequences.length}`)
      yield AppMessage.GotShell({ message: ShellMessage.SpeechEnded({ streamId }) })
    }
  })()

  return Stream.fromAsyncIterable(messages, unreachableStreamError)
}

/**
 * Always-on: initial slice refreshes + pushed main→renderer events.
 * Refreshes ride as *Requested messages through update so each slice's own
 * command runs (lifted through its Got* envelope by foldChild).
 */
const pumpIpcEvents = (): Stream.Stream<AppMessage> =>
  Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const client = getClient()
        const queue = yield* Queue.unbounded<AppMessage>()
        const push = (message: AppMessage): void => {
          Queue.offerUnsafe(queue, message)
        }

        push(AppMessage.GotBanners({ message: BannersMessage.BannersRefreshRequested() }))
        push(AppMessage.GotJobs({ message: JobsMessage.JobsRefreshRequested() }))
        push(AppMessage.GotTimeline({ message: TimelineMessage.TimelineRefreshRequested() }))
        const dials = yield* Effect.promise(() => client.invoke({ _tag: "asc.readDials" })).pipe(
          Effect.catch(() => Effect.succeed(undefined))
        )
        if (dials !== undefined) push(ascDialsMessage(dials))

        // Hydrate STT engine status on startup (marker file -> ready state).
        // Without this, the mic button stays hidden after restart.
        const sttStatus = yield* Effect.promise(() =>
          client.invoke({ _tag: "stt.engineStatus" })
        ).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (sttStatus !== undefined) {
          const s = sttStatus as { state: string; engine?: string; detail?: string }
          push(
            AppMessage.GotShell({
              message: ShellMessage.SttEngineStatusReceived({
                state: s.state,
                ...(s.engine !== undefined ? { engine: s.engine } : {}),
                ...(s.detail !== undefined ? { detail: s.detail } : {}),
              }),
            })
          )
        }

        // Load provider registry on startup.
        const providers = yield* Effect.promise(() =>
          client.invoke({ _tag: "providers.load" })
        ).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (providers !== undefined) {
          push(
            AppMessage.GotShell({
              message: ShellMessage.ProvidersLoaded({ registry: providers }),
            })
          )
        }

        // Push-to-talk global key/mouse listener. Uses the subscription's
        // push() to dispatch MicRecordToggled — the correct way to send
        // messages from outside the update loop.
        try {
          setupPushToTalk(() => {
            push(
              AppMessage.GotShell({
                message: ShellMessage.MicRecordToggled({}),
              })
            )
          })
          console.log("[ptt] listener installed via subscription")
        } catch (e) {
          console.error("[ptt] setup failed:", e)
        }

        const unsubscribe = client.subscribe((evt) => {
          switch (evt._tag) {
            case "banner.published":
              push(AppMessage.GotBanners({ message: BannersMessage.BannersRefreshRequested() }))
              break
            case "news.voiceAlerts":
              push(
                AppMessage.GotShell({
                  message: ShellMessage.VoiceAlertsChanged({ alerts: evt.alerts }),
                })
              )
              break
            case "asc.dialsUpdated":
              push(ascDialsMessage(evt.dials))
              break
            case "chat.channels": {
              const c = evt.channels
              push(
                AppMessage.GotShell({
                  message: ShellMessage.ChannelsReceived({
                    streamId: c.streamId,
                    audioBase64: c.audioBase64,
                    audioUnavailableReason: c.audioUnavailableReason,
                    expressions: c.expressions.map((e) => ({
                      atMs: e.atMs,
                      frame: { ...e.frame } as Record<string, number>,
                    })),
                  }),
                })
              )
              break
            }
            case "chat.audioChunk": {
              // Ordered narration audio chunk — queued for gapless playback.
              // Handled by the dedicated audio chunk pump (see below).
              push(
                AppMessage.GotShell({
                  message: ShellMessage.AudioChunkReceived({
                    streamId: evt.streamId,
                    sequence: evt.sequence,
                    audioBase64: evt.audioBase64,
                  }),
                })
              )
              break
            }
            case "chat.audioDrained": {
              push(
                AppMessage.GotShell({
                  message: ShellMessage.AudioDrainedReceived({
                    streamId: evt.streamId,
                  }),
                })
              )
              break
            }
            case "chat.tool": {
              // A tool call completed in the loop: footer outcome
              // (tint + conclusion) for the active stream's tags.
              push(
                AppMessage.GotShell({
                  message: ShellMessage.StreamToolActivity({
                    streamId: evt.streamId,
                    tool: evt.tool,
                    ok: evt.ok,
                    conclusion: evt.conclusion,
                  }),
                })
              )
              break
            }
            case "tts.installProgress": {
              const p = evt.progress
              push(
                AppMessage.GotShell({
                  message: ShellMessage.TtsInstallProgressReceived({
                    phase: p.phase,
                    message: p.message,
                  }),
                })
              )
              break
            }
            case "stt.installProgress": {
              const p = evt.progress
              if (p.phase === "error") {
                push(
                  AppMessage.GotShell({
                    message: ShellMessage.SttInstallFailed({ reason: p.message }),
                  })
                )
              } else if (p.phase === "done") {
                push(
                  AppMessage.GotShell({
                    message: ShellMessage.SttInstallProgressReceived({ message: p.message }),
                  })
                )
                // Mark as ready — the install completed.
                // (The status will be re-fetched on next panel open.)
              } else {
                push(
                  AppMessage.GotShell({
                    message: ShellMessage.SttInstallProgressReceived({ message: p.message }),
                  })
                )
              }
              break
            }
            default:
              break
          }
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )

/**
 * Per-stream composed inference inputs for the chatPump subscription
 * (2026-10-12): streamId -> "[AIMY-UISTATE]..." + user text, composed
 * once when the stream arms. See chatPump's modelToDependencies.
 */
const pumpInputCache = new Map<string, string>()

/**
 * Documents attached to a message (2026-10-13) are inlined into
 * the turn's input after his words — she reads the file because
 * its text is in front of her, and the framing says so plainly.
 * Total inlined text is capped at ~20,000 characters (the same
 * budget the drawer-space inlining uses); a document that does
 * not fit is truncated WITH a visible marker naming how much
 * was shown — never silently cut.
 */
export const DOCUMENT_INLINE_CAP = 20000
export const documentsSuffix = (
  documents: ReadonlyArray<{ readonly name: string; readonly text: string }> | undefined,
): string => {
  if (documents === undefined || documents.length === 0) return ""
  let out = ""
  for (const d of documents) {
    const header = `\n\n--- Attached document: ${d.name} ---\n`
    const room = DOCUMENT_INLINE_CAP - out.length - header.length
    if (room <= 0) {
      out += `\n\n--- Attached document: ${d.name} omitted — the 20,000-character attachment limit was already reached ---`
      continue
    }
    if (d.text.length > room) {
      out += header + d.text.slice(0, room) + `\n[document truncated: showing ${room} of ${d.text.length} characters]`
    } else {
      out += header + d.text
    }
  }
  return out
}

export const subscriptions = makeSubscriptions<AppModel, AppMessage, never>()((entry) => ({
  chatPump: entry(
    {
      streamId: Schema.String,
      sessionId: Schema.String,
      input: Schema.String,
      interrupted: Schema.Boolean,
      images: Schema.Array(
        Schema.Struct({
          dataUrl: Schema.String,
          mimeType: Schema.String,
          name: Schema.String,
        })
      ),
      promptText: Schema.String,
    },
    {
      modelToDependencies: (model) => {
        const streaming = model.shell.session.streaming
        if (!streaming.active)
          return { streamId: "", sessionId: "", input: "", interrupted: false, images: [], promptText: "" }
        // The user message whose id armed this stream (UserSentMessage's id
        // is the SendToInference correlationId is the StreamStarted streamId).
        const userMessage = model.shell.session.messages.find(
          (m) => m.id === streaming.streamId && m.role === "user"
        )
        // The inference input is the [AIMY-UISTATE] marker + the user's
        // text (2026-10-12 fix): update.ts puts the marker in the
        // SendToInference command's argument, but THIS subscription is
        // what actually sends, and it derives the input from the stored
        // user message — the marker never crossed IPC (field evidence:
        // main logged inputLen equal to the raw dictated text on six
        // straight voice turns while the renderer logged the marker).
        // Compose it HERE, once per stream: the cache keeps the
        // dependency value stable while the drawer changes mid-turn
        // (a changing input would restart this subscription and send
        // the turn twice).
        let input = pumpInputCache.get(streaming.streamId)
        if (input === undefined) {
          input = userMessage !== undefined ? uiStateMarker(model.shell) + userMessage.text + documentsSuffix(userMessage.documents) : ""
          if (userMessage !== undefined) {
            pumpInputCache.set(streaming.streamId, input)
            for (const k of Array.from(pumpInputCache.keys())) {
              if (k !== streaming.streamId) pumpInputCache.delete(k)
            }
          }
        }
        return {
          streamId: streaming.streamId,
          sessionId: model.shell.session.sessionId,
          input,
          interrupted: streaming.interrupted ?? false,
          images: (userMessage?.images ?? []).map((img) => ({
            dataUrl: img.dataUrl,
            mimeType: img.mimeType,
            name: img.name,
          })),
          promptText: userMessage?.text ?? "",
        }
      },
      dependenciesToStream: ({ streamId, sessionId, input, interrupted, images, promptText }) =>
        streamId === "" ? Stream.empty : pumpChat(streamId, sessionId, input, interrupted, images, promptText)
    }
  ),
  ipcEvents: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpIpcEvents()
    }
  ),
  voicePump: entry(
    {
      streamId: Schema.String,
      voiceEnabled: Schema.Boolean,
      audioBase64: Schema.optional(Schema.String),
      expressions: Schema.Array(
        Schema.Struct({
          atMs: Schema.Number,
          frame: Schema.Record(Schema.String, Schema.Number)
        })
      )
    },
    {
      modelToDependencies: (model) => {
        const pending = model.shell.session.pendingChannels
        if (pending === undefined || !model.shell.session.voiceEnabled) {
          return { streamId: "", voiceEnabled: false, audioBase64: undefined, expressions: [] }
        }
        return {
          streamId: pending.streamId,
          voiceEnabled: true as const,
          audioBase64: pending.audioBase64,
          expressions: pending.expressions.map((e: { atMs: number; frame: Record<string, number> }) => ({
            atMs: e.atMs,
            frame: { ...e.frame },
          })),
        }
      },
      dependenciesToStream: (deps) =>
        deps.streamId === ""
          ? Stream.empty
          : pumpVoice({
              streamId: deps.streamId,
              voiceEnabled: deps.voiceEnabled,
              audioBase64: deps.audioBase64,
              expressions: deps.expressions.map((e) => ({ atMs: e.atMs, frame: { ...e.frame } })),
            }),
    }
  ),
  audioChunkPump: entry(
    {
      streamId: Schema.String,
      voiceEnabled: Schema.Boolean,
      chunks: Schema.Array(
        Schema.Struct({
          sequence: Schema.Number,
          audioBase64: Schema.String,
        })
      ),
      drained: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => {
        const chunks = model.shell.session.pendingAudioChunks
        // Narration is explicit (model calls `narrate` tool) — if audio chunks
        // arrive, play them. The voice toggle gates the automatic fan-out
        // (now disabled), not explicit narration requests.
        if (chunks.length === 0) {
          // Queue empty: reset the replay guard.
          consumedAudioSequences.clear()
          consumedAudioStreamId = ""
          return { streamId: "", voiceEnabled: false, chunks: [], drained: false }
        }
        // Group by streamId — play the first stream's chunks.
        const streamId = chunks[0]!.streamId
        // New stream: reset the replay guard.
        if (streamId !== consumedAudioStreamId) {
          consumedAudioSequences.clear()
          consumedAudioStreamId = streamId
        }
        // Filter out already-consumed sequences (2026-10-11 replay guard:
        // the subscription can re-fire before AudioChunksConsumed is
        // processed — the in-memory set is the synchronous truth).
        const streamChunks = chunks.filter(
          (c) => c.streamId === streamId && !consumedAudioSequences.has(c.sequence)
        )
        if (streamChunks.length === 0) {
          return { streamId: "", voiceEnabled: false, chunks: [], drained: false }
        }
        const drained = model.shell.session.audioDrainedStreamIds.includes(streamId)
        return {
          streamId,
          voiceEnabled: true as const,
          chunks: streamChunks.map((c) => ({ sequence: c.sequence, audioBase64: c.audioBase64 })),
          drained,
        }
      },
      dependenciesToStream: (deps) => {
        // Stream change = new turn or interruption (2026-10-11): stop old
        // audio and clear the speaking indicator. The old pump was torn down
        // without yielding SpeechEnded, which left the UI stuck in
        // "speaking…" — so we emit it here before starting the new pump.
        // Same stream with new chunks = continue, don't interrupt.
        if (deps.streamId !== "" && deps.streamId !== lastAudioStreamId) {
          if (lastAudioStreamId !== "") {
            const endedStreamId = lastAudioStreamId
            console.log(`[aimy] audio: stream changed ${endedStreamId} → ${deps.streamId}, stopping old`)
            stopAllAudio("stream-change")
            lastAudioStreamId = deps.streamId
            return Stream.concat(
              Stream.succeed(
                AppMessage.GotShell({ message: ShellMessage.SpeechEnded({ streamId: endedStreamId }) })
              ),
              pumpAudioChunks({
                streamId: deps.streamId,
                voiceEnabled: deps.voiceEnabled,
                chunks: deps.chunks,
                drained: deps.drained,
              })
            )
          }
          lastAudioStreamId = deps.streamId
        }
        if (deps.streamId === "") {
          if (lastAudioStreamId !== "") {
            // Chunks vanished: user interrupted (UserSentMessage clears them)
            // or normal completion. Stop residual audio and clear the
            // speaking indicator in case the pump never yielded SpeechEnded.
            const endedStreamId = lastAudioStreamId
            stopAllAudio("chunks-cleared")
            lastAudioStreamId = ""
            return Stream.succeed(
              AppMessage.GotShell({ message: ShellMessage.SpeechEnded({ streamId: endedStreamId }) })
            )
          }
          lastAudioStreamId = ""
        }
        return deps.streamId === "" || deps.chunks.length === 0
          ? Stream.empty
          : pumpAudioChunks({
              streamId: deps.streamId,
              voiceEnabled: deps.voiceEnabled,
              chunks: deps.chunks,
              drained: deps.drained,
            })
      },
    }
  ),
  // Voice confirm: when a voice draft is pending, double-clicks act as
  // Enter/Escape. Double left-click (not on input) sends; double
  // right-click discards. Single clicks are untouched. Button 3 (PTT)
  // appends more (handled by the PTT listener, not here).
  voiceConfirm: entry(
    { voiceDraft: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        voiceDraft: model.shell.session.voiceDraft,
      }),
      dependenciesToStream: (deps) =>
        !deps.voiceDraft ? Stream.empty : pumpVoiceConfirm(),
    }
  ),
  // Provider auto-save: persists the registry to disk whenever it changes.
  // Skips the initial empty state to avoid overwriting on first load.
  providersSave: entry(
    { providersJson: Schema.String },
    {
      modelToDependencies: (model) => ({
        providersJson: JSON.stringify(model.shell.session.providers),
      }),
      dependenciesToStream: (deps) =>
        deps.providersJson === JSON.stringify({ providers: [], activeId: {} })
          ? Stream.empty
          : pumpProvidersSave(deps.providersJson),
    }
  ),
  // Provider connection test: probes the endpoint when a test is requested.
  providerTest: entry(
    { testRequests: Schema.String },
    {
      modelToDependencies: (model) => {
        const results = model.shell.session.providerTestResults ?? {}
        const providers = model.shell.session.providers.providers
        const toTest = providers.filter((p) => results[p.id] === "testing...")
        return {
          testRequests: JSON.stringify(
            toTest.map((p) => ({ id: p.id, kind: p.kind, endpoint: p.endpoint, category: p.category }))
          ),
        }
      },
      dependenciesToStream: (deps) => {
        const reqs: Array<{ id: string; kind: string; endpoint?: string; category: string }> = JSON.parse(
          deps.testRequests
        )
        if (reqs.length === 0) return Stream.empty
        return pumpProviderTest(reqs)
      },
    }
  ),
  // Provider network scan: probes known ports on a host for AI services.
  providerScan: entry(
    { scanHost: Schema.String },
    {
      modelToDependencies: (model) => ({
        scanHost: model.shell.session.providerScanRunning
          ? model.shell.session.providerScanHost
          : "",
      }),
      dependenciesToStream: (deps) =>
        !deps.scanHost ? Stream.empty : pumpProviderScan(deps.scanHost),
    }
  ),
  // Provider models: fetches /v1/models or /api/tags when requested.
  providerModels: entry(
    { modelsRequest: Schema.String },
    {
      modelToDependencies: (model) => {
        // Find providers with an empty models array (requested but not loaded).
        const models = model.shell.session.providerModels ?? {}
        const providers = model.shell.session.providers.providers
        const toFetch = providers.filter(
          (p) => p.kind === "remote" && p.endpoint && models[p.id] !== undefined && (models[p.id] ?? []).length === 0
        )
        return {
          modelsRequest: JSON.stringify(
            toFetch.map((p) => ({ id: p.id, endpoint: p.endpoint }))
          ),
        }
      },
      dependenciesToStream: (deps) => {
        const reqs: Array<{ id: string; endpoint: string }> = JSON.parse(deps.modelsRequest)
        if (reqs.length === 0) return Stream.empty
        return pumpProviderModels(reqs)
      },
    }
  ),
  // Image drag-and-drop (2026-10-11): listens for the `aimy:image-dropped`
  // DOM event (dispatched by main.ts after downscaling) and yields the
  // ImageDropped shell message. Always active.
  imageDrop: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpImageDrop(),
    }
  ),
  documentDrop: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpDocumentDrop(),
    }
  ),
  // Mic pre-roll status (2026-10-11): listens for the `aimy:mic-preroll`
  // DOM event (dispatched by warmupMicCapture) and yields MicPreRollChanged.
  // Always active.
  micPreRoll: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpMicPreRoll(),
    }
  ),
  // Drawer resize (2026-10-12): drag the divider to adjust width,
  // double-click to reset to default. Always active.
  drawerResize: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpDrawerResize(),
    }
  ),
  // Validation reports (2026-10-12): renderer validators (mermaid.ts)
  // dispatch `aimy:validation` DOM events; yields
  // DrawerValidationReported so failures/recoveries become change
  // notes for her next turn. Always active.
  validation: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpValidation(),
    }
  ),
  // Mirror Field actions (2026-10-12): the empty-state mind map
  // (mirror-field.ts) dispatches `aimy:field-open` /
  // `aimy:field-project` DOM events when a node is clicked; yields
  // the same shell messages the drawer home uses. Always active.
  fieldActions: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpFieldActions(),
    }
  ),
  // HomeDash in-place editor (2026-10-13): homedash-edit.ts
  // dispatches `aimy:homedash-setting` when a priority or geometry
  // value is committed; folds the normal HomedashSettingChanged so
  // editor and Settings panel share one persistence path. Always on.
  homedashEdit: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpHomedashSetting(),
    }
  ),
}))

/**
 * Listens for `aimy:image-dropped` CustomEvents (from the main.ts drop
 * handler) and yields ImageDropped messages through the foldkit channel.
 */
const pumpImageDrop = (): Stream.Stream<AppMessage> => {
  console.log("[aimy] imageDrop subscription starting")
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        console.log("[aimy] imageDrop listener attached")
        const onImageDropped = (e: Event) => {
          const detail = (e as CustomEvent).detail as {
            id: string
            dataUrl: string
            name: string
            mimeType: string
          }
          console.log(`[aimy] image dropped: ${detail.name} (${detail.mimeType})`)
          Queue.offerUnsafe(
            queue,
            AppMessage.GotShell({
              message: ShellMessage.ImageDropped(detail),
            })
          )
        }
        window.addEventListener("aimy:image-dropped", onImageDropped)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeEventListener("aimy:image-dropped", onImageDropped)
            console.log("[image] drop listener removed")
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Listens for `aimy:document-dropped` CustomEvents (dispatched by
 * the drop handler in main.ts after reading the file's text) and
 * yields DocumentDropped messages (2026-10-13). Mirrors
 * pumpImageDrop.
 */
const pumpDocumentDrop = (): Stream.Stream<AppMessage> => {
  console.log("[aimy] documentDrop subscription starting")
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        console.log("[aimy] documentDrop listener attached")
        const onDocumentDropped = (e: Event) => {
          const detail = (e as CustomEvent).detail as {
            id: string
            name: string
            text: string
          }
          console.log(`[aimy] document dropped: ${detail.name} (${detail.text.length} chars)`)
          Queue.offerUnsafe(
            queue,
            AppMessage.GotShell({
              message: ShellMessage.DocumentDropped(detail),
            })
          )
        }
        window.addEventListener("aimy:document-dropped", onDocumentDropped)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeEventListener("aimy:document-dropped", onDocumentDropped)
            console.log("[document] drop listener removed")
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Listens for `aimy:validation` CustomEvents (from mermaid.ts render
 * outcomes) and yields DrawerValidationReported messages (2026-10-12).
 */
const pumpValidation = (): Stream.Stream<AppMessage> => {
  console.log("[aimy] validation subscription starting")
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const onValidation = (e: Event) => {
          const detail = (e as CustomEvent).detail as {
            spaceId: string
            lang: string
            ok: boolean
            error?: string
          }
          console.log(`[aimy] validation report: space=${detail.spaceId} lang=${detail.lang} ok=${detail.ok}`)
          Queue.offerUnsafe(
            queue,
            AppMessage.GotShell({
              message: ShellMessage.DrawerValidationReported(detail),
            })
          )
        }
        window.addEventListener("aimy:validation", onValidation)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeEventListener("aimy:validation", onValidation)
            console.log("[aimy] validation listener removed")
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Listens for `aimy:field-open` / `aimy:field-project` CustomEvents
 * (from mirror-field.ts node clicks on the empty state) and yields
 * the drawer's own open/switch messages (2026-10-12).
 */
const pumpFieldActions = (): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const onOpen = (e: Event) => {
          const detail = (e as CustomEvent).detail as { path: string }
          Queue.offerUnsafe(
            queue,
            AppMessage.GotShell({
              message: ShellMessage.HomeRecentClicked({ path: detail.path }),
            })
          )
        }
        const onProject = (e: Event) => {
          const detail = (e as CustomEvent).detail as { id: string }
          Queue.offerUnsafe(
            queue,
            AppMessage.GotShell({
              message: ShellMessage.HomeProjectSwitchClicked({ id: detail.id }),
            })
          )
        }
        const onRefresh = () => {
          // The dash mounted with no data behind it (cold start):
          // load both the home data and the dash state.
          Queue.offerUnsafe(queue, AppMessage.GotShell({ message: ShellMessage.HomeDataRefreshRequested() }))
          Queue.offerUnsafe(queue, AppMessage.GotShell({ message: ShellMessage.HomedashRefreshRequested() }))
        }
        const onPanel = (e: Event) => {
          const detail = (e as CustomEvent).detail as { panel: string }
          // The field's nodes route to their homes: chat / memory /
          // subject / knowledge → Memory; projects → Projects; the
          // hub → Presence. A closed whitelist, nothing else routes.
          const panel = detail.panel
          if (panel === "memory" || panel === "projects" || panel === "presence") {
            Queue.offerUnsafe(queue, AppMessage.SelectPanel({ panel }))
          }
        }
        // The shell header's home mark (a class-hooked button in
        // the shell view) is the door back to the homedash. Panel
        // selection is composed state the shell cannot dispatch,
        // so the click routes through this pump.
        const onHomeNav = (e: Event) => {
          const t = e.target as HTMLElement | null
          if (t !== null && typeof t.closest === "function" && t.closest(".js-home-nav") !== null) {
            Queue.offerUnsafe(queue, AppMessage.SelectPanel({ panel: "home" }))
          }
        }
        // Document references in chat (.doc-ref code chips, marked
        // by the markdown renderer) open in the drawer: the chip's
        // text is the document's name or path, and the drawer-open
        // flow is the same one the home lists already use — the
        // space it creates is how she knows what he is reading.
        const onDocRef = (e: Event) => {
          const t = e.target as HTMLElement | null
          const el = t !== null && typeof t.closest === "function" ? t.closest("code.doc-ref") : null
          if (el !== null) {
            const name = (el.textContent ?? "").trim()
            if (name !== "") {
              Queue.offerUnsafe(queue, AppMessage.GotShell({ message: ShellMessage.HomeRecentClicked({ path: name }) }))
            }
          }
        }
        // Document links (2026-10-13): the desktop link
        // interceptor classifies library links and forwards the
        // click — path, mode (same/new space), and the space the
        // link was clicked in — as an aimy:doc-link event.
        // Placement is the shell update's job (DocLinkClicked).
        const onDocLink = (e: Event) => {
          try {
            const detail = JSON.parse((e as CustomEvent).detail as string) as {
              path: string
              mode: string
              spaceId: string
            }
            if (typeof detail.path !== "string" || detail.path === "") return
            Queue.offerUnsafe(
              queue,
              AppMessage.GotShell({
                message: ShellMessage.DocLinkClicked({
                  path: detail.path,
                  mode: detail.mode === "new" ? "new" : "same",
                  spaceId: typeof detail.spaceId === "string" ? detail.spaceId : "",
                }),
              })
            )
          } catch {
            // Malformed event ignored.
          }
        }
        // Stop generation (2026-10-13): Esc and the composer
        // stop button arrive as aimy:stop-stream (main.ts).
        const onStopStream = () => {
          Queue.offerUnsafe(
            queue,
            AppMessage.GotShell({ message: ShellMessage.StreamStopRequested({}) })
          )
        }
        // Edit-and-resend (2026-10-13): the pencil on one of
        // his bubbles arrives as aimy:edit-message with the
        // message id (main.ts reads it off the row's class).
        const onEditMessage = (e: Event) => {
          try {
            const detail = JSON.parse((e as CustomEvent).detail as string) as { id: string }
            if (typeof detail.id !== "string" || detail.id === "") return
            Queue.offerUnsafe(
              queue,
              AppMessage.GotShell({
                message: ShellMessage.UserMessageEditRequested({ id: detail.id }),
              })
            )
          } catch {
            // Malformed event ignored.
          }
        }
        window.addEventListener("aimy:field-open", onOpen)
        window.addEventListener("aimy:field-project", onProject)
        window.addEventListener("aimy:field-panel", onPanel)
        window.addEventListener("aimy:field-refresh", onRefresh)
        // GlobeNews manual refresh (2026-10-13): the feed footer's
        // "last updated" label is a button (js-news-refresh). The
        // click folds NewsRefreshRequested (a real scan runs in
        // the main process); the label swaps to "updating…" so
        // the click visibly lands, restoring itself if no reload
        // re-renders it first. Delegated listener — same DOM rule
        // as the doc-ref pattern above.
        const onNewsRefresh = (e: Event) => {
          const t = e.target as HTMLElement | null
          const el = t !== null && typeof t.closest === "function" ? t.closest(".js-news-refresh") : null
          if (el === null) return
          const original = el.textContent ?? ""
          if (!original.startsWith("updating")) {
            el.textContent = "updating…"
            window.setTimeout(() => {
              if (el.isConnected && el.textContent === "updating…") el.textContent = original
            }, 30_000)
          }
          Queue.offerUnsafe(queue, AppMessage.GotShell({ message: ShellMessage.NewsRefreshRequested({}) }))
        }
        document.addEventListener("click", onHomeNav)
        document.addEventListener("click", onDocRef)
        document.addEventListener("click", onNewsRefresh)
        window.addEventListener("aimy:doc-link", onDocLink)
        window.addEventListener("aimy:stop-stream", onStopStream)
        window.addEventListener("aimy:edit-message", onEditMessage)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeEventListener("aimy:field-open", onOpen)
            window.removeEventListener("aimy:field-project", onProject)
            window.removeEventListener("aimy:field-panel", onPanel)
            window.removeEventListener("aimy:field-refresh", onRefresh)
            document.removeEventListener("click", onHomeNav)
            document.removeEventListener("click", onDocRef)
            document.removeEventListener("click", onNewsRefresh)
            window.removeEventListener("aimy:doc-link", onDocLink)
            window.removeEventListener("aimy:stop-stream", onStopStream)
            window.removeEventListener("aimy:edit-message", onEditMessage)
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * HomeDash editor settings (2026-10-13): the in-place editor
 * (homedash-edit.ts) commits a priority or geometry change as an
 * `aimy:homedash-setting` DOM event carrying a JSON detail
 * {widgetId, key, value}. Folds HomedashSettingChanged — the same
 * message the Settings panel dispatches, one persistence path.
 */
const pumpHomedashSetting = (): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const onSetting = (e: Event) => {
          try {
            const detail = JSON.parse((e as CustomEvent).detail as string) as {
              widgetId: string
              key: string
              value: string | number | boolean
            }
            if (typeof detail.widgetId !== "string" || typeof detail.key !== "string") return
            Queue.offerUnsafe(
              queue,
              AppMessage.GotShell({
                message: ShellMessage.HomedashSettingChanged({
                  widgetId: detail.widgetId,
                  key: detail.key,
                  value: detail.value,
                }),
              })
            )
          } catch {
            // A malformed editor event is ignored, never fatal.
          }
        }
        // GlobeNews read-marking (2026-10-13): the feed/link layer
        // dispatches `aimy:news-read` {id} when an event is opened.
        const onNewsRead = (e: Event) => {
          try {
            const detail = JSON.parse((e as CustomEvent).detail as string) as { id: string }
            if (typeof detail.id !== "string" || detail.id === "") return
            Queue.offerUnsafe(
              queue,
              AppMessage.GotShell({ message: ShellMessage.NewsReadRequested({ id: detail.id }) })
            )
          } catch {
            // Malformed event ignored.
          }
        }
        // GlobeNews article-open (2026-10-13): a feed click or globe
        // pick dispatches `aimy:news-open` {id}; the article lands
        // in the drawer as its own space.
        const onNewsOpen = (e: Event) => {
          try {
            const detail = JSON.parse((e as CustomEvent).detail as string) as { id: string }
            if (typeof detail.id !== "string" || detail.id === "") return
            Queue.offerUnsafe(
              queue,
              AppMessage.GotShell({ message: ShellMessage.NewsOpenRequested({ id: detail.id }) })
            )
          } catch {
            // Malformed event ignored.
          }
        }
        // Threat Channel focus (2026-10-13): the director's
        // feature events and the link layer's selection events
        // move the model focus the intel desk + lower-third read.
        const onNewsFeature = (e: Event) => {
          try {
            const detail = JSON.parse((e as CustomEvent).detail as string) as { id: string }
            if (typeof detail.id !== "string" || detail.id === "") return
            Queue.offerUnsafe(
              queue,
              AppMessage.GotShell({
                message: ShellMessage.NewsFocusChanged({ id: detail.id, kind: "featured" }),
              })
            )
          } catch {
            // Malformed event ignored.
          }
        }
        const onNewsFeatureEnd = () => {
          Queue.offerUnsafe(
            queue,
            AppMessage.GotShell({
              message: ShellMessage.NewsFocusChanged({ id: "", kind: "" }),
            })
          )
        }
        const onNewsSelect = (e: Event) => {
          try {
            const detail = JSON.parse((e as CustomEvent).detail as string) as { id: string }
            if (typeof detail.id !== "string" || detail.id === "") return
            Queue.offerUnsafe(
              queue,
              AppMessage.GotShell({
                message: ShellMessage.NewsFocusChanged({ id: detail.id, kind: "selected" }),
              })
            )
          } catch {
            // Malformed event ignored.
          }
        }
        // Desk + crawl clicks (view-rendered, delegated here per
        // the DOM side-effect rule): open the article through the
        // same events the feed uses.
        const onDashNewsClick = (e: Event) => {
          const t = e.target as HTMLElement | null
          // Voice alert silence (Threat Channel §8): the strip's
          // button carries the alert id in a hidden span, the
          // same pattern as the news rows.
          const dismissEl = t?.closest?.(".js-voice-dismiss") as HTMLElement | null
          if (dismissEl !== null && dismissEl !== undefined) {
            const id = dismissEl.querySelector(".voice-alert-id")?.textContent?.trim()
            if (typeof id === "string" && id !== "") {
              Queue.offerUnsafe(
                queue,
                AppMessage.GotShell({
                  message: ShellMessage.VoiceAlertDismissRequested({ id }),
                })
              )
            }
            return
          }
          const el = t?.closest?.(".js-news-desk-open, .js-crawl-item") as HTMLElement | null
          // The id rides a hidden span inside the clickable —
          // the same pattern the feed rows use.
          const id = el?.querySelector(".news-item-id")?.textContent?.trim()
          if (typeof id !== "string" || id === "") return
          window.dispatchEvent(
            new CustomEvent("aimy:news-read", { detail: JSON.stringify({ id }) })
          )
          window.dispatchEvent(
            new CustomEvent("aimy:news-open", { detail: JSON.stringify({ id }) })
          )
        }
        window.addEventListener("aimy:homedash-setting", onSetting)
        window.addEventListener("aimy:news-read", onNewsRead)
        window.addEventListener("aimy:news-open", onNewsOpen)
        window.addEventListener("aimy:news-feature", onNewsFeature)
        window.addEventListener("aimy:news-feature-end", onNewsFeatureEnd)
        window.addEventListener("aimy:news-select", onNewsSelect)
        document.addEventListener("click", onDashNewsClick)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeEventListener("aimy:homedash-setting", onSetting)
            window.removeEventListener("aimy:news-read", onNewsRead)
            window.removeEventListener("aimy:news-open", onNewsOpen)
            window.removeEventListener("aimy:news-feature", onNewsFeature)
            window.removeEventListener("aimy:news-feature-end", onNewsFeatureEnd)
            window.removeEventListener("aimy:news-select", onNewsSelect)
            document.removeEventListener("click", onDashNewsClick)
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Scans the local network for AI services via the main process (no CORS).
 * Dispatches ProviderScanCompleted with the list of {host, port, service}.
 */
const pumpProviderScan = (host: string): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const push = (m: AppMessage) => Queue.offer(queue, m)
        const client = getClient()
        // Promise that never rejects (catches internally).
        const safeInvoke = client
          .invoke({ _tag: "providers.scanNetwork", host })
          .then(
            (r) =>
              r as {
                found: ReadonlyArray<{ host: string; port: number; service: string }>
                error?: string
              },
            (e) => ({
              found: [] as ReadonlyArray<{ host: string; port: number; service: string }>,
              error: e instanceof Error ? e.message : "Scan failed",
            })
          )
        const result = yield* Effect.promise(() => safeInvoke)
        if (result.error) {
          yield* push(
            AppMessage.GotShell({
              message: ShellMessage.ProviderScanFailed({ reason: result.error }),
            })
          )
        } else {
          yield* push(
            AppMessage.GotShell({
              message: ShellMessage.ProviderScanCompleted({
                host,
                found: [...result.found],
              }),
            })
          )
        }
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Fetches available models from a provider's /v1/models or /api/tags.
 * Dispatches ProviderModelsLoaded for each.
 */
const pumpProviderModels = (
  reqs: Array<{ id: string; endpoint: string }>
): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const push = (m: AppMessage) => Queue.offer(queue, m)
        const client = getClient()
        for (const req of reqs) {
          const safeInvoke = client
            .invoke({ _tag: "providers.listModels", endpoint: req.endpoint })
            .then(
              (r) => r as { models: ReadonlyArray<string>; error?: string },
              () => ({ models: [] as ReadonlyArray<string>, error: "IPC failed" })
            )
          const result = yield* Effect.promise(() => safeInvoke)
          yield* push(
            AppMessage.GotShell({
              message: ShellMessage.ProviderModelsLoaded({
                id: req.id,
                models: [...result.models],
              }),
            })
          )
        }
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Tests provider connections via HTTP probe (remote) or marker check (local).
 * Dispatches ProviderConnectionTestCompleted/Failed for each.
 */
const pumpProviderTest = (
  reqs: Array<{ id: string; kind: string; endpoint?: string; category: string }>
): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const push = (m: AppMessage) => Queue.offer(queue, m)
        const client = getClient()
        for (const req of reqs) {
          if (req.kind === "local") {
            yield* push(
              AppMessage.GotShell({
                message: ShellMessage.ProviderConnectionTestCompleted({
                  id: req.id,
                  detail: "Local engine — verify manually",
                }),
              })
            )
          } else if (req.endpoint) {
            // Promise that never rejects.
            const safeInvoke = client
              .invoke({ _tag: "providers.testConnection", endpoint: req.endpoint })
              .then(
                (r) => r as { ok: boolean; status?: number; error?: string },
                (e) => ({
                  ok: false,
                  error: e instanceof Error ? e.message : "IPC failed",
                })
              )
            const result = (yield* Effect.promise(() => safeInvoke)) as {
              ok: boolean
              status?: number
              error?: string
            }
            if (result.ok) {
              yield* push(
                AppMessage.GotShell({
                  message: ShellMessage.ProviderConnectionTestCompleted({
                    id: req.id,
                    detail: `HTTP ${result.status} from ${req.endpoint}`,
                  }),
                })
              )
            } else {
              yield* push(
                AppMessage.GotShell({
                  message: ShellMessage.ProviderConnectionTestFailed({
                    id: req.id,
                    reason: result.error ?? "Connection failed",
                  }),
                })
              )
            }
          } else {
            yield* push(
              AppMessage.GotShell({
                message: ShellMessage.ProviderConnectionTestFailed({
                  id: req.id,
                  reason: "No endpoint configured",
                }),
              })
            )
          }
        }
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Persists the provider registry to disk via IPC.
 * Runs once per change (the subscription re-fires when the JSON changes).
 */
const pumpProvidersSave = (providersJson: string): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const client = getClient()
        try {
          const registry = JSON.parse(providersJson)
          yield* Effect.promise(() =>
            client.invoke({ _tag: "providers.save", registry })
          ).pipe(Effect.catch((e) => {
            console.error("[providers] save failed:", e)
            return Effect.succeed(undefined)
          }))
          console.log("[providers] auto-saved registry")
        } catch (e) {
          console.error("[providers] save parse failed:", e)
        }
        // Return an empty queue — no messages to push.
        const queue = yield* Queue.unbounded<AppMessage>()
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Global double-click to confirm voice drafts.
 * Double left-click (not on composer input) = send. Double right-click = discard.
 * Single clicks are untouched — full UI interactivity preserved.
 */
const pumpVoiceConfirm = (): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const push = (m: AppMessage) => Queue.offerUnsafe(queue, m)
        const onMouseDown = (e: MouseEvent) => {
          // Ignore PTT button (button 3) — that's for appending, handled elsewhere.
          if (e.button === 3) return
          // Only double-clicks trigger voice actions. Single clicks are normal.
          if (e.detail !== 2) return
          const target = e.target as HTMLElement
          // Double-clicking the composer input = edit mode, do not send.
          if (target.closest(".composer-input")) return
          if (e.button === 0) {
            // Double left-click anywhere = send (like Enter).
            console.log("[voice] double-click to send")
            push(
              AppMessage.GotShell({
                message: ShellMessage.VoiceDraftConfirmed({}),
              })
            )
          } else if (e.button === 2) {
            // Double right-click anywhere = discard.
            console.log("[voice] double right-click to discard")
            e.preventDefault()
            push(
              AppMessage.GotShell({
                message: ShellMessage.VoiceDraftDiscarded({}),
              })
            )
          }
        }
        // Prevent context menu on double right-click (single right-click
        // still shows the menu normally).
        const onContextMenu = (e: MouseEvent) => {
          // Only suppress if this is likely part of a double right-click.
          // We can't know for sure, so we let single right-clicks through
          // and rely on mousedown (detail===2) for the discard.
        }
        window.addEventListener("mousedown", onMouseDown)
        window.addEventListener("contextmenu", onContextMenu)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeEventListener("mousedown", onMouseDown)
            window.removeEventListener("contextmenu", onContextMenu)
            console.log("[voice] click listeners removed")
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Mic pre-roll status (2026-10-11): listens for `aimy:mic-preroll` events
 * from the warmup and dispatches MicPreRollChanged so the mic button dot
 * reflects the lead-in buffer state.
 */
const pumpMicPreRoll = (): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const push = (m: AppMessage) => Queue.offerUnsafe(queue, m)
        const onPreRoll = (e: Event) => {
          const status = (e as CustomEvent).detail?.status
          if (status === "ready" || status === "unavailable" || status === "warming") {
            console.log(`[mic] pre-roll status: ${status}`)
            push(
              AppMessage.GotShell({
                message: ShellMessage.MicPreRollChanged({ status }),
              })
            )
          }
        }
        window.addEventListener("aimy:mic-preroll", onPreRoll)
        // Boot race fix (2026-10-13): the warmup may have settled
        // BEFORE this listener registered — its one-shot event is
        // gone, and the dot would sit at "warming" all session.
        // Read the module-held current status and land it now;
        // the event carries any later change.
        const currentStatus = getMicPreRollStatus()
        if (currentStatus !== "warming") {
          console.log(`[mic] pre-roll status (initial read): ${currentStatus}`)
          push(
            AppMessage.GotShell({
              message: ShellMessage.MicPreRollChanged({ status: currentStatus }),
            })
          )
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeEventListener("aimy:mic-preroll", onPreRoll)
            console.log("[mic] pre-roll listener removed")
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Drawer resize (2026-10-12): drag the resize handle to adjust width,
 * double-click to reset to default (400px).
 *
 * Uses event delegation — the handle is re-rendered by Foldkit, so we
 * listen on document and check the target.
 */
export const pumpDrawerResize = (): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const DEFAULT_WIDTH = 400
        const MIN_WIDTH = 280
        let dragging = false
        let startX = 0
        let startWidth = 0

        const getDrawer = (): HTMLElement | null =>
          document.querySelector(".drawer") as HTMLElement | null

        const onMouseDown = (e: MouseEvent) => {
          const target = e.target as HTMLElement
          if (!target.classList.contains("drawer-resize-handle")) return
          const drawer = getDrawer()
          if (!drawer) return
          dragging = true
          startX = e.clientX
          startWidth = drawer.getBoundingClientRect().width
          e.preventDefault()
          console.log("[drawer] resize start")
        }

        const onMouseMove = (e: MouseEvent) => {
          if (!dragging) return
          const drawer = getDrawer()
          if (!drawer) return
          // Dragging left increases width (drawer is on the right).
          const delta = startX - e.clientX
          const maxWidth = window.innerWidth * 0.6
          const newWidth = Math.min(Math.max(startWidth + delta, MIN_WIDTH), maxWidth)
          document.documentElement.style.setProperty("--drawer-width", `${newWidth}px`)
        }

        const onMouseUp = () => {
          if (dragging) {
            dragging = false
            console.log("[drawer] resize end")
          }
        }

        const onDblClick = (e: MouseEvent) => {
          const target = e.target as HTMLElement
          if (!target.classList.contains("drawer-resize-handle")) return
          document.documentElement.style.setProperty("--drawer-width", `${DEFAULT_WIDTH}px`)
          console.log("[drawer] resize reset")
        }

        document.addEventListener("mousedown", onMouseDown)
        document.addEventListener("mousemove", onMouseMove)
        document.addEventListener("mouseup", onMouseUp)
        document.addEventListener("dblclick", onDblClick)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("mousemove", onMouseMove)
            document.removeEventListener("mouseup", onMouseUp)
            document.removeEventListener("dblclick", onDblClick)
            console.log("[drawer] resize listeners removed")
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Drawer space resize (2026-10-12): drag the handle between spaces to
 * adjust their height proportions. The layout uses flex-grow ratios —
 * dragging computes new ratios from the pixel delta.
 *
 * Uses event delegation — handles are re-rendered by Foldkit.
 */
export const pumpSpaceResize = (): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        const push = (m: AppMessage) => Queue.offerUnsafe(queue, m)
        let dragging = false
        let startY = 0
        let aboveId = ""
        let belowId = ""
        let aboveEl: HTMLElement | null = null
        let belowEl: HTMLElement | null = null
        let aboveStartHeight = 0
        let belowStartHeight = 0

        const onMouseDown = (e: MouseEvent) => {
          const target = e.target as HTMLElement
          if (!target.classList.contains("drawer-space-resize-handle")) return
          // Find adjacent spaces by DOM traversal. The handle is between two
          // .drawer-space elements. Space IDs are encoded in class names as
          // "space-id-<id>" (see drawer.ts).
          const prevEl = target.previousElementSibling as HTMLElement | null
          const nextEl = target.nextElementSibling as HTMLElement | null
          if (!prevEl || !nextEl) return
          const getSpaceId = (el: HTMLElement): string | null => {
            for (const cls of el.classList) {
              if (cls.startsWith("space-id-")) {
                return cls.slice("space-id-".length)
              }
            }
            return null
          }
          aboveId = getSpaceId(prevEl) ?? ""
          belowId = getSpaceId(nextEl) ?? ""
          if (!aboveId || !belowId) {
            console.warn("[drawer] space resize: could not determine space IDs")
            return
          }
          aboveEl = prevEl
          belowEl = nextEl
          dragging = true
          startY = e.clientY
          aboveStartHeight = aboveEl.getBoundingClientRect().height
          belowStartHeight = belowEl.getBoundingClientRect().height
          target.classList.add("dragging")
          e.preventDefault()
          console.log(`[drawer] space resize start: ${aboveId} / ${belowId}`)
        }

        const onMouseMove = (e: MouseEvent) => {
          if (!dragging || !aboveEl || !belowEl) return
          const delta = e.clientY - startY
          const MIN_HEIGHT = 80
          // Compute new pixel heights, clamped to minimum.
          let newAbove = Math.max(aboveStartHeight + delta, MIN_HEIGHT)
          let newBelow = Math.max(belowStartHeight - delta, MIN_HEIGHT)
          // If one hits min, the other gets the remainder.
          const total = aboveStartHeight + belowStartHeight
          if (newAbove === MIN_HEIGHT) {
            newBelow = total - MIN_HEIGHT
          } else if (newBelow === MIN_HEIGHT) {
            newAbove = total - MIN_HEIGHT
          }
          // Convert to flex-grow ratios (normalize so they sum to 2).
          // The actual ratio values don't matter, only their proportion.
          const sum = newAbove + newBelow
          const aboveRatio = (newAbove / sum) * 2
          const belowRatio = (newBelow / sum) * 2
          // Apply directly to DOM for smooth dragging (no re-render).
          aboveEl.style.flexGrow = String(aboveRatio)
          belowEl.style.flexGrow = String(belowRatio)
          // Store for mouseup dispatch.
          ;(aboveEl as any)._pendingRatio = aboveRatio
          ;(belowEl as any)._pendingRatio = belowRatio
        }

        const onMouseUp = (e: MouseEvent) => {
          if (!dragging) return
          dragging = false
          document.querySelectorAll(".drawer-space-resize-handle.dragging").forEach((el) =>
            el.classList.remove("dragging")
          )
          if (aboveEl && belowEl) {
            const aboveRatio = (aboveEl as any)._pendingRatio ?? 1
            const belowRatio = (belowEl as any)._pendingRatio ?? 1
            console.log(`[drawer] space resize end: ${aboveId}=${aboveRatio.toFixed(2)} ${belowId}=${belowRatio.toFixed(2)}`)
            push(
              AppMessage.GotShell({
                message: ShellMessage.DrawerSpaceResized({
                  aboveId,
                  belowId,
                  aboveRatio,
                  belowRatio,
                }),
              })
            )
          }
          aboveEl = null
          belowEl = null
        }

        document.addEventListener("mousedown", onMouseDown)
        document.addEventListener("mousemove", onMouseMove)
        document.addEventListener("mouseup", onMouseUp)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("mousemove", onMouseMove)
            document.removeEventListener("mouseup", onMouseUp)
            console.log("[drawer] space resize listeners removed")
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}

/**
 * Mermaid diagram rendering (2026-10-12).
 *
 * Watches for `.mermaid-block` elements (rendered by markdown.ts) and
 * transforms them into SVG diagrams via the mermaid library.
 *
 * Uses MutationObserver to catch newly added blocks (foldkit re-renders).
 * Each block is rendered once (marked with `data-mermaid-rendered`).
 */
export const pumpMermaid = (): Stream.Stream<AppMessage> => {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AppMessage>()
        // Dynamic import to avoid bundling mermaid if not needed.
        // Actually, static import is fine — it's already a dependency.
        let mermaid: any = null
        try {
          const mod = yield* Effect.promise(() => import("mermaid"))
          mermaid = mod.default
          mermaid.initialize({
            startOnLoad: false,
            theme: "dark",
            themeVariables: {
              // Match AImy's dark theme.
              primaryColor: "#22d3ee",
              primaryTextColor: "#e6edf3",
              primaryBorderColor: "#30363d",
              lineColor: "#8b949e",
              secondaryColor: "#161b22",
              tertiaryColor: "#0d1117",
            },
          })
          console.log("[mermaid] initialized")
        } catch (e) {
          console.error("[mermaid] failed to load:", e)
          return queue
        }

        const renderBlock = async (el: HTMLElement) => {
          if (el.getAttribute("data-mermaid-rendered") === "true") return
          const codeEl = el.querySelector("code")
          if (!codeEl) return
          const definition = codeEl.textContent ?? ""
          if (!definition.trim()) return
          try {
            // Generate a unique ID for this diagram.
            const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
            const { svg } = await mermaid.render(id, definition)
            el.innerHTML = svg
            el.setAttribute("data-mermaid-rendered", "true")
            el.classList.add("mermaid-rendered")
            console.log(`[mermaid] rendered diagram (${definition.length} chars)`)
          } catch (e) {
            console.error("[mermaid] render failed:", e)
            // Leave the code block as-is on failure.
            el.setAttribute("data-mermaid-rendered", "true")
            el.classList.add("mermaid-error")
          }
        }

        const renderAll = () => {
          document.querySelectorAll(".mermaid-block:not([data-mermaid-rendered])").forEach((el) => {
            renderBlock(el as HTMLElement)
          })
        }

        // Initial render.
        renderAll()

        // Watch for new blocks.
        const observer = new MutationObserver((mutations) => {
          let needsRender = false
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node instanceof HTMLElement) {
                if (node.classList.contains("mermaid-block") || node.querySelector(".mermaid-block")) {
                  needsRender = true
                  break
                }
              }
            }
            if (needsRender) break
          }
          if (needsRender) {
            // Defer to next tick to ensure DOM is settled.
            setTimeout(renderAll, 0)
          }
        })

        observer.observe(document.body, { childList: true, subtree: true })
        console.log("[mermaid] observer started")

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            observer.disconnect()
            console.log("[mermaid] observer stopped")
          })
        )
        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )
}
