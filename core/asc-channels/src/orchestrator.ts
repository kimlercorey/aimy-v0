/**
 * asc-channels/orchestrator.ts — one turn, three simultaneous channels.
 *
 * renderChannels: validate text → derive the speakable version → run TTS
 * and the ASC dial read concurrently → build the FACS timeline over the
 * utterance duration (exact from audio, estimated otherwise).
 *
 * Degradation is honest, never silent:
 * - TTS down → audio undefined + audioUnavailableReason; text and face
 *   channels still deliver.
 * - Dials unreadable → face channel uses the rest frame.
 * - Nothing speakable (e.g. text was only code) → voice skipped with reason.
 * Only empty input is fatal (ChannelError).
 */
import { Effect } from "effect"
import { chunkText } from "../../tts/src/chunk.js"
import { NEUTRAL_FRAME, type ChannelDeps, type ChannelInput, type ChannelOutput } from "./types.js"
import { ChannelError } from "./errors.js"
import { toSpeakable } from "./speakable.js"
import { buildTimeline, estimateDurationMs, wavDurationMs } from "./timeline.js"
import { dialsToAUFrame } from "./facs.js"

export const renderChannels = (
  deps: ChannelDeps,
  input: ChannelInput
): Effect.Effect<ChannelOutput, ChannelError> =>
  Effect.gen(function* () {
    const text = input.text.replace(/\s+/g, " ").trim()
    if (text === "") {
      return yield* Effect.fail(new ChannelError({ reason: "renderChannels: text must not be empty" }))
    }
    const spoken = toSpeakable(input.text)

    // Dials and TTS run concurrently; each degrades independently.
    const [dials, audioResult] = yield* Effect.all(
      [
        deps.dials.pipe(Effect.catch(() => Effect.succeed(undefined))),
        spoken === ""
          ? Effect.succeed({ audio: undefined, reason: "nothing speakable in this turn" } as const)
          : deps.tts
              .speak(spoken, input.voiceId)
              .pipe(
                Effect.map((audio) => ({ audio, reason: undefined as string | undefined })),
                Effect.catch((e) =>
                  Effect.succeed({
                    audio: undefined,
                    reason: `TTS unavailable: ${e instanceof Error ? e.message : String(e)}`,
                  })
                )
              ),
      ],
      { concurrency: 2 }
    )

    const durationMs =
      audioResult.audio !== undefined
        ? safeWavDuration(audioResult.audio, spoken)
        : estimateDurationMs(spoken)
    // Dials unreadable → the face channel rests at neutral for the turn.
    const expressions =
      dials === undefined
        ? [{ atMs: 0, frame: { ...NEUTRAL_FRAME } }]
        : buildTimeline(chunkText(spoken === "" ? text : spoken), dials, durationMs)

    return {
      text: input.text,
      spoken,
      audio: audioResult.audio,
      audioUnavailableReason: audioResult.reason,
      expressions,
      durationMs,
    } satisfies ChannelOutput
  })

const safeWavDuration = (audio: Uint8Array, spoken: string): number => {
  try {
    return Math.max(500, wavDurationMs(audio))
  } catch {
    return estimateDurationMs(spoken)
  }
}

// Re-exported for integrators that need the raw mapping.
export { dialsToAUFrame }
