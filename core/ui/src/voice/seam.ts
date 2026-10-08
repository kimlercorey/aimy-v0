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
  readonly pickVoiceFile: () => Promise<{
    readonly cancelled: boolean
    readonly name?: string | undefined
    readonly audioBase64?: string | undefined
  }>
}

export class TtsIpc extends Context.Service<TtsIpc, TtsIpcShape>()(
  "aimy/ui/TtsIpc"
) {}
