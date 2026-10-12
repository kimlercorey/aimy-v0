/**
 * ui/src/voice/seam.ts — the voice panel's service boundary.
 *
 * The shell never touches IPC directly: its voice commands yield `TtsIpc`,
 * which the desktop renderer provides (`desktop/src/renderer/resources.ts`)
 * over the `tts.*` IPC commands. Every method mirrors one IPC command;
 * failures surface as `Error` and the shell turns them into failed messages.
 */
import { Context } from "effect"

export type TtsEngineState = "missing" | "installing" | "ready" | "failed"

export interface TtsEngineStatus {
  readonly state: TtsEngineState
  readonly detail?: string | undefined
}

export interface Voice {
  readonly id: string
  readonly name: string
  readonly isDefault: boolean
}

export interface TtsInstallProgress {
  readonly phase: "python" | "venv" | "deps" | "verify" | "done" | "error"
  readonly message: string
}

export interface TtsIpcShape {
  readonly engineStatus: () => Promise<TtsEngineStatus>
  readonly installEngine: () => Promise<{ started: boolean }>
  readonly voices: () => Promise<ReadonlyArray<Voice>>
  readonly setVoice: (voiceId: string) => Promise<void>
  readonly addVoice: (name: string, audioBase64: string) => Promise<Voice>
  readonly deleteVoice: (voiceId: string) => Promise<void>
  readonly playVoiceSample: (voiceId: string) => Promise<{ readonly audioBase64: string }>
  readonly testProvider: () => Promise<{
    readonly latencyMs: number
    readonly modelSizeMb: number
    readonly throughputCharsPerSec: number
  }>
  readonly setVoiceDefault: (voiceId: string) => Promise<void>
  readonly pickVoiceFile: () => Promise<{
    readonly cancelled: boolean
    readonly name?: string | undefined
    readonly audioBase64?: string | undefined
  }>
  /** Enqueue text for TTS narration (fire-and-forget). */
  readonly speak: (text: string) => Promise<void>
  /** Stop narration and clear the queue (on user interruption). */
  readonly stop: () => Promise<void>
  /** STT engine status. */
  readonly sttEngineStatus: () => Promise<{
    readonly state: "unknown" | "missing" | "installing" | "ready" | "failed"
    readonly detail?: string | undefined
    readonly engine?: string | undefined
  }>
  /** Install an STT engine (fire-and-forget, progress via events). */
  readonly installSttEngine: (engine: string) => Promise<void>
  /** Transcribe audio (base64 WAV) to text. */
  readonly transcribeStt: (audioBase64: string, sampleRate?: number) => Promise<{
    readonly text: string
    readonly latencyMs: number
  }>
  /** Run STT latency test. */
  readonly testStt: () => Promise<{
    readonly latencyMs: number
    readonly modelSizeMb: number
  }>
  /** Start mic recording (renderer-side MediaRecorder). */
  readonly startMicRecording: () => Promise<void>
  /** Stop mic recording, return base64 WAV. */
  readonly stopMicRecording: () => Promise<{ readonly audioBase64: string }>
  /** List available microphone devices. */
  readonly listMicDevices: () => Promise<ReadonlyArray<{
    readonly deviceId: string
    readonly label: string
  }>>
}

export class TtsIpc extends Context.Service<TtsIpc, TtsIpcShape>()(
  "aimy/ui/TtsIpc"
) {}
