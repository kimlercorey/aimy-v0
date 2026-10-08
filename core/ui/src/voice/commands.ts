/**
 * ui/src/voice/commands.ts — foldkit Commands for the voice panel.
 *
 * Each command is one IPC round-trip through `TtsIpc`; outcomes land as the
 * shell's `*Received` / `*Failed` messages. The engine install is
 * fire-and-forget: `InstallEngine` starts it, and progress arrives as
 * `tts.installProgress` events through the subscription (not as command
 * results), because the download takes minutes.
 */
import { Effect, Schema } from "effect"
import { define as defineCommand } from "foldkit/command"

import { Message } from "../messages.js"
import { TtsIpc } from "./seam.js"

const toError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const FetchEngineStatus = defineCommand("voice/fetchEngineStatus", {
  args: {},
  messages: [Message.TtsEngineStatusReceived, Message.TtsEngineStatusFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const s = yield* Effect.tryPromise({
        try: () => ipc.engineStatus(),
        catch: (e) => new Error(toError(e)),
      })
      return Message.TtsEngineStatusReceived({
        state: s.state,
        ...(s.detail !== undefined ? { detail: s.detail } : {}),
      })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.TtsEngineStatusFailed({ reason: toError(e) })))),
})

export const InstallEngine = defineCommand("voice/installEngine", {
  args: {},
  messages: [Message.TtsInstallStarted, Message.TtsInstallFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const r = yield* Effect.tryPromise({
        try: () => ipc.installEngine(),
        catch: (e) => new Error(toError(e)),
      })
      if (!r.started) {
        return Message.TtsInstallFailed({ reason: "Install already running or engine already installed." })
      }
      return Message.TtsInstallStarted({})
    }).pipe(Effect.catch((e) => Effect.succeed(Message.TtsInstallFailed({ reason: toError(e) })))),
})

export const FetchVoices = defineCommand("voice/fetchVoices", {
  args: {},
  messages: [Message.VoicesReceived, Message.VoicesFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const voices = yield* Effect.tryPromise({
        try: () => ipc.voices(),
        catch: (e) => new Error(toError(e)),
      })
      return Message.VoicesReceived({
        voices: voices.map((v) => ({ id: v.id, name: v.name, isDefault: v.isDefault })),
      })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.VoicesFailed({ reason: toError(e) })))),
})

export const SelectVoice = defineCommand("voice/selectVoice", {
  args: { voiceId: Schema.String },
  messages: [Message.VoiceSelected, Message.VoiceSelectFailed],
  execute: ({ voiceId }: { voiceId: string }) =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      yield* Effect.tryPromise({
        try: () => ipc.setVoice(voiceId),
        catch: (e) => new Error(toError(e)),
      })
      return Message.VoiceSelected({ voiceId })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.VoiceSelectFailed({ reason: toError(e) })))),
})

export const PickVoiceFile = defineCommand("voice/pickVoiceFile", {
  args: {},
  messages: [Message.VoiceFilePicked, Message.VoiceFilePickCancelled, Message.VoiceFilePickFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const r = yield* Effect.tryPromise({
        try: () => ipc.pickVoiceFile(),
        catch: (e) => new Error(toError(e)),
      })
      if (r.cancelled || r.audioBase64 === undefined) {
        return Message.VoiceFilePickCancelled({})
      }
      return Message.VoiceFilePicked({
        name: r.name ?? "voice",
        audioBase64: r.audioBase64,
      })
    }).pipe(
      Effect.catch((e) => Effect.succeed(Message.VoiceFilePickFailed({ reason: toError(e) })))
    ),
})

export const AddVoice = defineCommand("voice/addVoice", {
  args: { name: Schema.String, audioBase64: Schema.String },
  messages: [Message.VoiceAdded, Message.VoiceAddFailed],
  execute: ({ name, audioBase64 }: { name: string; audioBase64: string }) =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const v = yield* Effect.tryPromise({
        try: () => ipc.addVoice(name, audioBase64),
        catch: (e) => new Error(toError(e)),
      })
      return Message.VoiceAdded({ id: v.id, name: v.name, isDefault: v.isDefault })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.VoiceAddFailed({ reason: toError(e) })))),
})
