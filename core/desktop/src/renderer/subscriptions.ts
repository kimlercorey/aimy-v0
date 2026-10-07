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

import type { DialVector } from "../../../asc-engine/index.js"
import {
  AppMessage,
  type AppModel
} from "../../../ui/src/composed/index.js"
import { Message as ShellMessage } from "../../../ui/src/messages.js"
import { BannersMessage } from "../../../ui/src/ops/index.js"
import { JobsMessage } from "../../../ui/src/ops/index.js"
import { Message as TimelineMessage } from "../../../ui/src/timeline/index.js"
import { AscPanelMessage, type ArchivedComputation } from "../../../ui/src/asc/index.js"
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

/** One chat turn over the bridge. Deltas are sanitized at this boundary (Pi #10504). */
const pumpChat = (shellStreamId: string, sessionId: string, input: string): Stream.Stream<AppMessage> => {
  const client = getClient()
  const handle = client.chatStream(sessionId, input)
  const sanitizer = new ChunkSanitizer()
  let text = ""

  const messages = (async function* (): AsyncGenerator<AppMessage> {
    try {
      for await (const delta of handle) {
        const clean = sanitizer.push(delta)
        text += clean
        yield AppMessage.GotShell({
          message: ShellMessage.StreamChunkReceived({ streamId: shellStreamId, delta: clean })
        })
      }
      yield AppMessage.GotShell({
        message: ShellMessage.StreamSettled({ streamId: shellStreamId, text, at: Date.now() })
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
    // Interrupt the engine stream whenever this subscription ends.
    Stream.ensuring(Effect.sync(() => handle.cancel()))
  )
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

        const unsubscribe = client.subscribe((evt) => {
          switch (evt._tag) {
            case "banner.published":
              push(AppMessage.GotBanners({ message: BannersMessage.BannersRefreshRequested() }))
              break
            case "asc.dialsUpdated":
              push(ascDialsMessage(evt.dials))
              break
            default:
              break
          }
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

        return queue
      })
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue)))
  )

export const subscriptions = makeSubscriptions<AppModel, AppMessage, never>()((entry) => ({
  chatPump: entry(
    {
      streamId: Schema.String,
      sessionId: Schema.String,
      input: Schema.String
    },
    {
      modelToDependencies: (model) => {
        const streaming = model.shell.session.streaming
        if (!streaming.active) return { streamId: "", sessionId: "", input: "" }
        // The user message whose id armed this stream (UserSentMessage's id
        // is the SendToInference correlationId is the StreamStarted streamId).
        const userMessage = model.shell.session.messages.find(
          (m) => m.id === streaming.streamId && m.role === "user"
        )
        return {
          streamId: streaming.streamId,
          sessionId: model.shell.session.sessionId,
          input: userMessage?.text ?? ""
        }
      },
      dependenciesToStream: ({ streamId, sessionId, input }) =>
        streamId === "" ? Stream.empty : pumpChat(streamId, sessionId, input)
    }
  ),
  ipcEvents: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: () => ({ active: true }),
      dependenciesToStream: () => pumpIpcEvents()
    }
  )
}))
