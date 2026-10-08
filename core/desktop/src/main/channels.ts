/**
 * desktop/src/main/channels.ts — simultaneous-channels fan-out for chat turns.
 *
 * When a chat stream settles, the full turn text goes through
 * `renderChannels`: the voice channel (TTS audio of the speakable text) and
 * the face channel (FACS expression timeline from the live ASC dials) are
 * computed alongside the text the renderer already has. The result crosses
 * to the renderer as one `chat.channels` event — audio as base64 WAV.
 *
 * TTS failure degrades inside renderChannels (audio absent + reason); a
 * channels failure never fails the chat turn itself.
 */
import { Effect } from "effect"
import { renderChannels } from "../../../asc-channels/src/index.js"
import { HttpClient } from "../../../web-retrieval/src/http.js"
import type { ASCEngineShape } from "../../../asc-engine/index.js"
import type { DesktopEngine } from "./engine.js"
import type { TtsEngine } from "./tts-engine.js"
import type { ChatChannelsResult } from "../ipc/protocol.js"

export interface ChannelsFanOutDeps {
  readonly engine: DesktopEngine
  readonly asc: ASCEngineShape
  readonly tts: TtsEngine
}

const toBase64 = (bytes: Uint8Array): string => {
  let bin = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/**
 * Build the `chat.channels` payload for a settled turn, inside the engine
 * layer (for HttpClient). Never rejects: worst case the renderer gets no
 * channels event and the turn still stands on its text.
 */
export const fanOutChannels = (
  deps: ChannelsFanOutDeps,
  streamId: string,
  text: string
): Promise<ChatChannelsResult | undefined> =>
  deps.engine
    .run(
      Effect.gen(function* () {
        const clean = text.trim()
        if (clean === "") return undefined
        const http = yield* HttpClient
        const tts = yield* deps.tts.ttsService(http)
        const dials = yield* deps.asc.currentDials.pipe(
          Effect.catch(() => Effect.succeed(undefined))
        )
        const out = yield* renderChannels(
          {
            tts,
            dials:
              dials === undefined
                ? Effect.fail(new Error("dials unavailable") as never)
                : Effect.succeed({
                    warmth: dials.warmth,
                    playfulness: dials.playfulness,
                    intensity: dials.intensity,
                    vulnerability: dials.vulnerability,
                  }),
          },
          { text: clean }
        ).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (out === undefined) return undefined
        return {
          streamId,
          spoken: out.spoken,
          audioBase64: out.audio !== undefined ? toBase64(out.audio) : undefined,
          audioUnavailableReason: out.audioUnavailableReason,
          expressions: out.expressions.map((c) => ({ atMs: c.atMs, frame: { ...c.frame } })),
          durationMs: out.durationMs,
        } satisfies ChatChannelsResult
      })
    )
    .catch(() => undefined)
