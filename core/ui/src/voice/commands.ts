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

export const DeleteVoice = defineCommand("voice/deleteVoice", {
  args: { voiceId: Schema.String },
  messages: [Message.VoiceDeleted, Message.VoiceDeleteFailed],
  execute: ({ voiceId }: { voiceId: string }) =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      yield* Effect.tryPromise({
        try: () => ipc.deleteVoice(voiceId),
        catch: (e) => new Error(toError(e)),
      })
      return Message.VoiceDeleted({ voiceId })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.VoiceDeleteFailed({ reason: toError(e) })))),
})

export const PlayVoiceSample = defineCommand("voice/playSample", {
  args: { voiceId: Schema.String },
  messages: [Message.VoiceSamplePlayed, Message.VoiceSampleFailed],
  execute: ({ voiceId }: { voiceId: string }) =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const { audioBase64 } = yield* Effect.tryPromise({
        try: () => ipc.playVoiceSample(voiceId),
        catch: (e) => new Error(toError(e)),
      })
      // Play the WAV via the browser Audio API.
      yield* Effect.tryPromise({
        try: async () => {
          const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0))
          const blob = new Blob([bytes], { type: "audio/wav" })
          const url = URL.createObjectURL(blob)
          const audio = new Audio(url)
          await audio.play()
          URL.revokeObjectURL(url)
        },
        catch: (e) => new Error(toError(e)),
      })
      return Message.VoiceSamplePlayed({ voiceId })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.VoiceSampleFailed({ reason: toError(e) })))),
})

export const RunProviderTest = defineCommand("voice/runProviderTest", {
  args: {},
  messages: [Message.ProviderTestCompleted, Message.ProviderTestFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      // Battery: 5 runs. First is cold, rest are warm.
      const latencies: number[] = []
      let modelSizeMb = 0
      let throughput = 0
      for (let i = 0; i < 5; i++) {
        const r = yield* Effect.tryPromise({
          try: () => ipc.testProvider(),
          catch: (e) => new Error(toError(e)),
        })
        latencies.push(r.latencyMs)
        modelSizeMb = r.modelSizeMb
        throughput = r.throughputCharsPerSec
      }
      const sorted = [...latencies].sort((a, b) => a - b)
      const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
      return Message.ProviderTestCompleted({
        latencyMs: percentile(50),
        modelSizeMb,
        throughputCharsPerSec: throughput,
        // Extended battery results (optional fields).
        ...({
          coldMs: latencies[0],
          p50Ms: percentile(50),
          p95Ms: percentile(95),
          allLatenciesMs: latencies,
        } as object),
      })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.ProviderTestFailed({ reason: toError(e) })))),
})

export const SetVoiceDefault = defineCommand("voice/setDefault", {
  args: { voiceId: Schema.String },
  messages: [Message.VoiceDefaultSet, Message.VoiceDefaultSetFailed],
  execute: ({ voiceId }: { voiceId: string }) =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      yield* Effect.tryPromise({
        try: () => ipc.setVoiceDefault(voiceId),
        catch: (e) => new Error(toError(e)),
      })
      return Message.VoiceDefaultSet({ voiceId })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.VoiceDefaultSetFailed({ reason: toError(e) })))),
})

export const InstallSttEngine = defineCommand("voice/installStt", {
  args: { engine: Schema.String },
  messages: [Message.SttInstallFailed],
  execute: ({ engine }: { engine: string }) =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      yield* Effect.tryPromise({
        try: () => ipc.installSttEngine(engine),
        catch: (e) => new Error(toError(e)),
      })
      // Success is signaled via SttInstallProgressReceived events, not a message.
      // Return a dummy failure that the update handler will ignore (install is fire-and-forget).
      return Message.SttInstallFailed({ reason: "__install_started__" })
    }).pipe(
      Effect.catch((e) => Effect.succeed(Message.SttInstallFailed({ reason: toError(e) }))),
    ),
})

export const TestSttEngine = defineCommand("voice/testStt", {
  args: {},
  messages: [Message.SttTestCompleted, Message.SttTestFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const result = yield* Effect.tryPromise({
        try: () => ipc.testStt(),
        catch: (e) => new Error(toError(e)),
      })
      return Message.SttTestCompleted({
        latencyMs: result.latencyMs,
        modelSizeMb: result.modelSizeMb,
      })
    }).pipe(
      Effect.catch((e) => Effect.succeed(Message.SttTestFailed({ reason: toError(e) }))),
    ),
})

export const MicStartRecording = defineCommand("voice/micStart", {
  args: {},
  messages: [Message.MicRecordingStarted, Message.MicFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      yield* Effect.tryPromise({
        try: () => ipc.startMicRecording(),
        catch: (e) => new Error(toError(e)),
      })
      return Message.MicRecordingStarted({})
    }).pipe(
      Effect.catch((e) => Effect.succeed(Message.MicFailed({ reason: toError(e) }))),
    ),
})

export const MicStopRecording = defineCommand("voice/micStop", {
  args: {},
  messages: [Message.MicRecordingStopped, Message.MicFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const result = yield* Effect.tryPromise({
        try: () => ipc.stopMicRecording(),
        catch: (e) => new Error(toError(e)),
      })
      return Message.MicRecordingStopped({ audioBase64: result.audioBase64 })
    }).pipe(
      Effect.catch((e) => Effect.succeed(Message.MicFailed({ reason: toError(e) }))),
    ),
})

export const TranscribeMicAudio = defineCommand("voice/transcribeMic", {
  args: { audioBase64: Schema.String },
  messages: [Message.MicTranscribed, Message.MicFailed],
  execute: ({ audioBase64 }: { audioBase64: string }) =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const result = yield* Effect.tryPromise({
        try: () => ipc.transcribeStt(audioBase64, 16000),
        catch: (e) => new Error(toError(e)),
      })
      return Message.MicTranscribed({ text: result.text })
    }).pipe(
      Effect.catch((e) => Effect.succeed(Message.MicFailed({ reason: toError(e) }))),
    ),
})

export const ListMicDevices = defineCommand("voice/listMicDevices", {
  args: {},
  messages: [Message.MicDevicesReceived, Message.MicFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      const devices = yield* Effect.tryPromise({
        try: () => ipc.listMicDevices(),
        catch: (e) => new Error(toError(e)),
      })
      return Message.MicDevicesReceived({ devices: [...devices] })
    }).pipe(
      Effect.catch((e) => Effect.succeed(Message.MicFailed({ reason: toError(e) }))),
    ),
})
