/**
 * ui/src/app.ts — the shell application wiring (Foldkit README pattern).
 *
 * This module DEFINES the program; it never boots it. `makeShellApplication`
 * builds the `Runtime.makeApplication` config and `entry.ts` calls
 * `Runtime.run` on it, so this file stays importable from tests with zero
 * side effects.
 *
 * Composition contract for the later integrator pass: this track's slice is
 * exported as `shellFold` parts — `Model`, `init`, `update`, `view`,
 * `subscriptions` — ready to compose with the other tracks' slices via
 * `foldkit/update`'s `foldChild` (this track's messages ride in a `GotShell`
 * envelope at the parent).
 */
import { Effect, Layer, Schema, Stream } from "effect"
import { Runtime } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { make as makeSubscriptions } from "foldkit/subscription"
import { AgentLoop } from "../../agent-loop/src/index.js"
import { ChunkSanitizer } from "./rendering.js"
import { chatChunkToMessage } from "./chat/streaming.js"
import { chatPanelView } from "./chat/view.js"
import { permissionsView } from "./permissions/view.js"
import { initialModel, Model } from "./model.js"
import { Message } from "./messages.js"
import { update, type ShellServices } from "./update.js"

/**
 * The full service set the shell needs at the boundary: SafetyKernel +
 * MemoryService for the commands (see update.ts), AgentLoop for the
 * inference-stream subscription.
 */
export type AppServices = ShellServices | AgentLoop

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: initialModel(),
})

const shellView = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `AImy — ${model.session.sessionId}`,
  body: h.div([h.Class("shell")], [
    h.header([h.Class("shell-header")], [
      h.h1([h.Class("shell-title")], ["AImy"]),
      h.span([h.Class("shell-session")], [model.session.sessionId]),
    ]),
    h.main([h.Class("shell-main")], [
      chatPanelView(model.session, h),
      permissionsView(model.permissions, h),
    ]),
  ]),
})

export const view = shellView

/* ------------------------------------------------------------------ */
/* inferenceStream subscription                                        */
/*                                                                     */
/* The live token pump. When `session.streaming` is armed (by           */
/* SendToInference -> StreamStarted), this runs `AgentLoop.chat` — the  */
/* one path that may call the InferencePool — and maps its chunks to    */
/* Messages. Deltas are sanitized at this boundary, before they become  */
/* Messages (Pi #10504). Loop errors surface as StreamFailed: never a   */
/* silent drop.                                                        */
/*                                                                     */
/* Token accounting note (Pi #9409): `TurnReport` does not yet expose   */
/* per-turn `Usage`, so `StreamSettled` carries no usage here. The      */
/* context-meter field exists in the Model; the loop revision that      */
/* exposes usage fills it — the meter shows "unknown" until then, never */
/* a fabricated zero.                                                  */
/* ------------------------------------------------------------------ */

const streamDepFields = {
  streamId: Schema.String,
  sessionId: Schema.String,
  input: Schema.String,
}

export const subscriptions = makeSubscriptions<Model, Message, AgentLoop>()((entry) => ({
  inferenceStream: entry(streamDepFields, {
    modelToDependencies: (model) =>
      model.session.streaming.active
        ? {
            streamId: model.session.streaming.streamId,
            sessionId: model.session.sessionId,
            input: "",
          }
        : { streamId: "", sessionId: "", input: "" },
    dependenciesToStream: ({ streamId, sessionId, input }) => {
      if (streamId === "") return Stream.empty
      // One sanitizer per stream: chunk-split escape sequences reassemble
      // here, before deltas become Messages (Pi #10504).
      const sanitizer = new ChunkSanitizer()
      return Stream.unwrap(
        Effect.map(AgentLoop, (loop) => loop.chat(sessionId, input)),
      ).pipe(
        Stream.map((chunk) =>
          chatChunkToMessage(
            streamId,
            chunk._tag === "Token" ? { ...chunk, delta: sanitizer.push(chunk.delta) } : chunk,
          ),
        ),
        Stream.catchCause((_cause) =>
          Stream.succeed(
            Message.StreamFailed({ streamId, reason: "inference stream failed" }),
          ),
        ),
      )
    },
  }),
}))

/**
 * Build the application. `container` is the DOM mount node; the runtime needs
 * `HTMLElement | null`, but this package compiles without DOM lib types, so
 * the boundary takes `unknown` and forwards it (the entry point owns the real
 * DOM lookup).
 */
declare global {
  // Minimal structural stand-in: the build has no DOM lib, and the container
  // is only ever forwarded to the runtime, never touched here.
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface HTMLElement {}
}

export const makeShellApplication = (
  container: unknown,
  resources?: Layer.Layer<AppServices>,
) =>
  Runtime.makeApplication<Model, Message, AppServices>({
    Model,
    init,
    update,
    view,
    subscriptions,
    container: container as HTMLElement | null,
    ...(resources !== undefined ? { resources } : {}),
  })

export type ShellApplication = ReturnType<typeof makeShellApplication>
