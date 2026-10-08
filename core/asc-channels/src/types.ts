/**
 * asc-channels/types.ts — the simultaneous-channels module's public shapes.
 *
 * One agent turn fans out to three simultaneous channels:
 *   - chat:  the full text (information *for* the user)
 *   - voice: the speakable text as WAV audio (information *to* the user)
 *   - face:  a FACS expression timeline driving the avatar
 *
 * The module is a downstream reader of ASC state (INTERFACE.md §7): it
 * consumes dials, never writes them. TTS is optional per-turn — when the
 * server is down the text and face channels still deliver, honestly marked.
 */
import type { Effect } from "effect"
import type { TtsServiceShape } from "../../tts/src/types.js"
import type { ChannelError } from "./errors.js"
import type { AUFrame, DialInput } from "./facs.js"

export interface ChannelInput {
  readonly text: string
  readonly voiceId?: string | undefined
}

export interface ChannelDeps {
  readonly tts: TtsServiceShape
  /**
   * ASC dials for this turn. The integrator wires ASCEngine.currentDials;
   * a failure degrades the face channel to the rest frame (never fatal).
   */
  readonly dials: Effect.Effect<DialInput, ChannelError>
}

/** One expression keyframe: the avatar holds `frame` from `atMs`. */
export interface ExpressionCue {
  readonly atMs: number
  readonly frame: AUFrame
}

export interface ChannelOutput {
  /** Full text, for the chat channel. */
  readonly text: string
  /** Speakable text (markdown stripped), for captioning the voice channel. */
  readonly spoken: string
  /** WAV bytes, or undefined when TTS was unavailable this turn. */
  readonly audio: Uint8Array | undefined
  /** Set exactly when audio is undefined: why. */
  readonly audioUnavailableReason: string | undefined
  /** FACS timeline over the utterance, for the avatar. */
  readonly expressions: ReadonlyArray<ExpressionCue>
  /** Estimated utterance length in ms (from audio when present). */
  readonly durationMs: number
}

/** The avatar at rest: every AU at zero, head straight. */
export const NEUTRAL_FRAME: AUFrame = {
  browRaise: 0,
  browLower: 0,
  eyeOpen: 0,
  lidTighten: 0,
  smile: 0,
  mouthCornerDepress: 0,
  lipPress: 0,
  jawDrop: 0,
  headTiltDeg: 0,
}
