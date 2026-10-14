/**
 * ui/src/commands.ts — effects as data (architecture §3.3).
 *
 * The update function never performs effects; it returns these Commands, which
 * the Effect runtime interprets at the shell boundary. Every command carries a
 * correlation id back to the Message that produced it (requestId /
 * correlationId), so the DevTools timeline shows cause -> effect. Failed
 * commands produce failure Messages, never silent drops.
 *
 * The real service APIs are read from source, not reimplemented:
 * - `SendToInference` — the turn's *intent*; the live token pump is the
 *   `inferenceStream` Subscription in app.ts, which runs `AgentLoop.chat`
 *   (itself routed through the InferencePool — no direct model calls).
 *   The command is interruptible (name-keyed): sending a new message while a
 *   turn streams cancels the old one; the interrupted effect's messages are
 *   guaranteed never to dispatch, and stale chunks are ignored by update.
 * - `RequestPermission` — via `SafetyKernel`. The prompt is UI, the gate is
 *   the kernel (Pi #10426). Interruptible, keyed by requestId.
 * - `PersistMemory` — via `MemoryService.append` (JSONL session tree).
 *
 * INTEGRATION CONTRACT (for the later foldChild pass): a `PermissionGranted`
 * decision in the Model means the user approved; the command *interpreter* at
 * the shell boundary must call `SafetyKernel.approve(intent)` for the matching
 * requestId before the agent loop's `execute()` proceeds. The kernel — not
 * the UI — remains the enforcement point, and denial stays terminal there.
 */
import { Cause, Effect, Schema } from "effect"
import { define as defineCommand, type CommandDefinitionWithArgs } from "foldkit/command"
import { MemoryService } from "../../memory/service.js"
import { SafetyKernel } from "../../permission-kernel/index.js"
import type { JsonValue, ToolName } from "../../substrate/types.js"
import { Message } from "./messages.js"
import { ChatImage } from "./model.js"
import { TtsIpc } from "./voice/seam.js"
import { DocsIpc } from "./docs-seam.js"
import { ChatIpc } from "./chat-seam.js"
import { HomeIpc } from "./home-seam.js"
import { HomedashIpc } from "./homedash-seam.js"

/** Named array schema so the SendToInference annotation can reference its type. */
const ChatImageArray = Schema.Array(ChatImage)

/**
 * Nameable message-instance types for the command annotations below.
 * `defineCommand` with `interrupt: true` infers `DefinitionWithArgsNameKeyed`,
 * which is not reachable through foldkit's public exports, so declaration
 * emit (TS2883) needs these explicit annotations. The annotations are
 * behavior-identical: same names, same args, same effects.
 */
type StreamStartedMsg = ReturnType<typeof Message.StreamStarted>
type PermissionMsg =
  | ReturnType<typeof Message.PermissionRequested>
  | ReturnType<typeof Message.PermissionAutoAllowed>
  | ReturnType<typeof Message.PermissionCheckFailed>

/** Shared tier schema, named so `typeof` captures its exact literal type. */
const TierSchema = Schema.Literals(["T0", "T1", "T2", "T3"])

/* ------------------------------------------------------------------ */
/* SendToInference                                                     */
/* ------------------------------------------------------------------ */

/**
 * The user sent a message; arm the streaming state and let the
 * `inferenceStream` subscription pump `AgentLoop.chat` chunks into
 * StreamChunkReceived / StreamSettled / StreamFailed.
 */
export const SendToInference: CommandDefinitionWithArgs<
  "SendToInference",
  {
    correlationId: typeof Schema.String
    sessionId: typeof Schema.String
    input: typeof Schema.String
    voiceEnabled: typeof Schema.Boolean
    viaVoice: typeof Schema.Boolean
    interrupted: typeof Schema.Boolean
    images: typeof ChatImageArray
  },
  Effect.Effect<StreamStartedMsg, never, never>
> = defineCommand("SendToInference", {
  args: {
    /** Correlation id: the UserSentMessage id, reused as the streamId. */
    correlationId: Schema.String,
    sessionId: Schema.String,
    input: Schema.String,
    /** Whether voice narration is on — agent should narrate responses. */
    voiceEnabled: Schema.Boolean,
    /** Whether the input came via voice (STT) — response should use voice. */
    viaVoice: Schema.Boolean,
    /** Whether this turn barged in on a previous response (2026-10-11). */
    interrupted: Schema.Boolean,
    /** Images attached via drag-and-drop (2026-10-11). */
    images: ChatImageArray,
  },
  messages: [Message.StreamStarted, Message.StreamFailed],
  interrupt: true,
  execute: ({ correlationId, sessionId, input, voiceEnabled, viaVoice, interrupted, images }) =>
    Effect.succeed(
      Message.StreamStarted({ streamId: correlationId, sessionId, input, at: Date.now(), voiceEnabled, viaVoice, interrupted, ...(images.length > 0 ? { images } : {}) }),
    ),
})

/* ------------------------------------------------------------------ */
/* RequestPermission                                                   */
/* ------------------------------------------------------------------ */

/**
 * Consult the SafetyKernel about a tool intent. The kernel's answer drives
 * the UI: "allow" is recorded silently, "ask" raises the prompt surface,
 * "deny" fails typed and is recorded as a terminal denial. The args travel
 * as a JSON string because command args must be Schema-plain; they are
 * parsed back to JsonValue at the boundary — the kernel, not the UI,
 * canonicalizes them for the fingerprint.
 */
export const RequestPermission: CommandDefinitionWithArgs<
  "RequestPermission",
  {
    requestId: typeof Schema.String
    tool: typeof Schema.String
    tier: typeof TierSchema
    argsSummary: typeof Schema.String
    provenance: typeof Schema.String
  },
  Effect.Effect<PermissionMsg, never, SafetyKernel>
> = defineCommand("RequestPermission", {
  args: {
    /** Correlation id: the permission request id, reused in every message. */
    requestId: Schema.String,
    tool: Schema.String,
    tier: TierSchema,
    /** JSON-encoded JsonValue of the canonicalized args. */
    argsSummary: Schema.String,
    /** Who/why this intent exists, e.g. "agent-loop:turn-42". */
    provenance: Schema.String,
  },
  messages: [Message.PermissionRequested, Message.PermissionAutoAllowed, Message.PermissionCheckFailed],
  interrupt: {
    keyFields: ["requestId"],
    toKey: ({ requestId }) => requestId,
  },
  execute: ({ requestId, tool, tier, argsSummary, provenance }) =>
    Effect.gen(function* () {
      const kernel = yield* SafetyKernel
      const at = Date.now()
      let args: JsonValue
      try {
        args = JSON.parse(argsSummary) as JsonValue
      } catch {
        // Fail closed on unparseable args: the kernel sees an empty object,
        // which the policy denies unless explicitly allowed.
        args = {}
      }
      const decision = yield* kernel
        .check({ tool: tool as ToolName, tier, args, provenance })
        .pipe(
          Effect.catchTag("PermissionDenied", (e) =>
            Effect.succeed(
              Message.PermissionCheckFailed({
                requestId,
                denied: true,
                reason: e.reason,
                at,
              }),
            ),
          ),
        )
      // `decision` is either the failure message or the kernel's Decision.
      if (typeof decision !== "string") return decision
      return decision === "allow"
        ? Message.PermissionAutoAllowed({ requestId, at })
        : Message.PermissionRequested({
            requestId,
            tool,
            argsSummary,
            riskTier: tier,
            context: provenance,
            at,
          })
    }),
})

/* ------------------------------------------------------------------ */
/* PersistMemory                                                       */
/* ------------------------------------------------------------------ */

/**
 * Append one transcript entry to the JSONL session tree. Fire-and-forget by
 * design: success and failure both surface as Messages for the timeline.
 */
export const PersistMemory = defineCommand("PersistMemory", {
  args: {
    /** Correlation id back to the Message that produced this command. */
    correlationId: Schema.String,
    sessionId: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String,
  },
  messages: [Message.MemoryPersisted, Message.MemoryPersistFailed],
  execute: ({ correlationId, sessionId, role, text }) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService
      yield* memory.append(sessionId, {
        parentId: null,
        kind: "message",
        payload: { role, text },
      })
      return Message.MemoryPersisted({ correlationId })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          Message.MemoryPersistFailed({
            correlationId,
            reason: Cause.pretty(cause).slice(0, 300),
          }),
        ),
      ),
    ),
})

/* ------------------------------------------------------------------ */
/* SpeakText                                                           */
/* ------------------------------------------------------------------ */

/**
 * Enqueue text for TTS narration (fire-and-forget). Used for auto-narration
 * when voice is enabled. Never fails visibly — TTS errors are swallowed so
 * a voice hiccup never breaks the chat flow.
 */
export const SpeakText = defineCommand("SpeakText", {
  args: {
    text: Schema.String,
  },
  messages: [Message.TtsSpoken],
  execute: ({ text }) =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      // Best-effort: swallow TTS failures so a voice hiccup never breaks chat.
      yield* Effect.tryPromise({
        try: () => ipc.speak(text),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.tapError((e) => Effect.logWarning(`SpeakText: TTS failed: ${e.message}`)),
        Effect.ignore,
      )
      return Message.TtsSpoken({})
    }),
})

/* ------------------------------------------------------------------ */
/* StopNarration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Stop narration and clear the queue (on user interruption).
 * Prevents old content from resuming after the user interrupts.
 * Fire-and-forget: never fails visibly.
 */
export const StopNarration = defineCommand("StopNarration", {
  messages: [],
  // Side-effect only: no message produced. Cast bypasses the
  // Effect<never> type constraint for fire-and-forget commands.
  execute: (() =>
    Effect.gen(function* () {
      const ipc = yield* TtsIpc
      yield* Effect.tryPromise({
        try: () => ipc.stop(),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.ignore)
    })) as unknown as Effect.Effect<never, never, never>,
})

/* ------------------------------------------------------------------ */
/* FocusComposer                                                       */
/* ------------------------------------------------------------------ */

/**
 * Focus the composer input after a turn completes (2026-10-10).
 * The user shouldn't have to click to type the next message.
 * Best-effort: if the input isn't in the DOM, silently do nothing.
 */
export const FocusComposer = defineCommand("FocusComposer", {
  messages: [],
  // Side-effect only: no message produced. Cast bypasses the
  // Effect<never> type constraint for fire-and-forget commands.
  execute: Effect.sync(() => {
    try {
      const input = document.querySelector<HTMLInputElement>(".composer-input")
      if (input) {
        input.focus()
      }
    } catch {
      // Silently ignore (e.g., during tests without DOM).
    }
  }) as unknown as Effect.Effect<never, never, never>,
})

/* ------------------------------------------------------------------ */
/* ScrollToBottom                                                      */
/* ------------------------------------------------------------------ */

/**
 * Scroll the message list to the bottom after new messages arrive
 * (2026-10-10: fixes auto-scroll not working).
 * Uses requestAnimationFrame to ensure the DOM has updated first.
 */
export const ScrollToBottom = defineCommand("ScrollToBottom", {
  messages: [],
  execute: Effect.promise(async () => {
    await new Promise<void>((resolve) => {
      try {
        requestAnimationFrame(() => resolve())
      } catch {
        resolve()
      }
    })
    try {
      const list = document.querySelector<HTMLElement>(".message-list")
      if (list) {
        list.scrollTop = list.scrollHeight
      }
    } catch {
      // Silently ignore.
    }
  }) as unknown as Effect.Effect<never, never, never>,
})

/* ------------------------------------------------------------------ */
/* RenderMermaid                                                       */
/* ------------------------------------------------------------------ */

/**
 * Render mermaid diagrams in the chat (2026-10-10).
 * The markdown renderer outputs `<pre class="mermaid-block">` elements;
 * this command invokes mermaid.js to convert them to SVG diagrams.
 * Runs after DOM update via requestAnimationFrame.
 */
export const RenderMermaid = defineCommand("RenderMermaid", {
  messages: [],
  execute: Effect.promise(async () => {
    await new Promise<void>((resolve) => {
      try {
        requestAnimationFrame(() => resolve())
      } catch {
        resolve()
      }
    })
    try {
      const mermaid = (await import("mermaid")).default
      mermaid.initialize({ startOnLoad: false, theme: "dark" })
      await mermaid.run({ querySelector: ".mermaid-block" })
    } catch (e) {
      console.warn("[aimy] RenderMermaid failed:", e instanceof Error ? e.message : e)
    }
  }) as unknown as Effect.Effect<never, never, never>,
})

/* ------------------------------------------------------------------ */
/* SaveDocument                                                        */
/* ------------------------------------------------------------------ */

type DrawerSavedMsg = ReturnType<typeof Message.DrawerSpaceSaved>
type DrawerSaveFailedMsg = ReturnType<typeof Message.DrawerSpaceSaveFailed>

/**
 * Write a drawer space's document to disk via the DocsIpc seam
 * (2026-10-12). Success and failure BOTH surface as messages — the
 * space's sync state is only updated on DrawerSpaceSaved, so a failed
 * save can never masquerade as a saved document.
 */
export const SaveDocument: CommandDefinitionWithArgs<
  "SaveDocument",
  {
    spaceId: typeof Schema.String
    path: typeof Schema.String
    content: typeof Schema.String
  },
  Effect.Effect<DrawerSavedMsg | DrawerSaveFailedMsg, never, DocsIpc>
> = defineCommand("SaveDocument", {
  args: {
    spaceId: Schema.String,
    /** Repo-relative target path (planning/ or docs/). */
    path: Schema.String,
    content: Schema.String,
  },
  messages: [Message.DrawerSpaceSaved, Message.DrawerSpaceSaveFailed],
  execute: ({ spaceId, path, content }) =>
    Effect.gen(function* () {
      const ipc = yield* DocsIpc
      const result = yield* Effect.tryPromise({
        try: () => ipc.saveDocument(path, content),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((r) => Message.DrawerSpaceSaved({ id: spaceId, path: r.path, content })),
        Effect.catch((e) =>
          Effect.succeed(
            Message.DrawerSpaceSaveFailed({ id: spaceId, reason: e.message.slice(0, 300) })
          )
        )
      )
      return result
    }),
})

/* ------------------------------------------------------------------ */
/* Drawer home panel (2026-10-12)                                     */
/* ------------------------------------------------------------------ */

type HomeLoadedMsg = ReturnType<typeof Message.HomeDataLoaded>
type HomeFailedMsg = ReturnType<typeof Message.HomeDataFailed>

/**
 * Load the drawer home panel data (Continue / Needs you / What she
 * knows) via the HomeIpc seam. Failure surfaces as HomeDataFailed —
 * the panel shows the error instead of pretending the stores are empty.
 */
export const LoadHomeData: CommandDefinitionWithArgs<
  "LoadHomeData",
  { correlationId: typeof Schema.String },
  Effect.Effect<HomeLoadedMsg | HomeFailedMsg, never, HomeIpc>
> = defineCommand("LoadHomeData", {
  args: { correlationId: Schema.String },
  messages: [Message.HomeDataLoaded, Message.HomeDataFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* HomeIpc
      return yield* Effect.tryPromise({
        try: () => ipc.getHomeData(),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((d) =>
          Message.HomeDataLoaded({
            recents: [...d.recents],
            requests: [...d.requests],
            cards: [...d.cards],
            project:
              d.project === null
                ? null
                : {
                    ...d.project,
                    goals: [...d.project.goals],
                    assets: [...d.project.assets],
                    runs: [...d.project.runs],
                  },
            projectList: [...d.projectList],
            chats: [...d.chats],
            memories: [...d.memories],
            journal: d.journal === null ? null : { ...d.journal },
            promptHistory: [...(d.promptHistory ?? [])],
          })
        ),
        Effect.catch((e) =>
          Effect.succeed(Message.HomeDataFailed({ reason: e.message.slice(0, 300) }))
        )
      )
    }),
})

type HomeDocLoadedMsg = ReturnType<typeof Message.HomeDocumentLoaded>
type HomeDocFailedMsg = ReturnType<typeof Message.HomeDocumentLoadFailed>
type LinkedDocLoadedMsg = ReturnType<typeof Message.LinkedDocumentLoaded>
type LinkedDocFailedMsg = ReturnType<typeof Message.LinkedDocumentLoadFailed>
type EditBranchReadyMsg = ReturnType<typeof Message.EditBranchReady>
type EditBranchFailedMsg = ReturnType<typeof Message.EditBranchFailed>

/**
 * Open a document from the home panel's Continue list via the DocsIpc
 * seam. Success and failure both surface as messages — a document that
 * could not be read is never shown as opened.
 */
export const LoadHomeDocument: CommandDefinitionWithArgs<
  "LoadHomeDocument",
  { path: typeof Schema.String },
  Effect.Effect<HomeDocLoadedMsg | HomeDocFailedMsg, never, DocsIpc>
> = defineCommand("LoadHomeDocument", {
  args: { path: Schema.String },
  messages: [Message.HomeDocumentLoaded, Message.HomeDocumentLoadFailed],
  execute: ({ path }) =>
    Effect.gen(function* () {
      const ipc = yield* DocsIpc
      return yield* Effect.tryPromise({
        try: () => ipc.loadDocument(path),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((r) => Message.HomeDocumentLoaded({ path: r.path, content: r.content })),
        Effect.catch((e) =>
          Effect.succeed(
            Message.HomeDocumentLoadFailed({ path, reason: e.message.slice(0, 300) })
          )
        )
      )
    }),
})

/**
 * Document links (2026-10-13): load a linked library document
 * through the same DocsIpc seam, carrying the click's mode and
 * the containing space id so the update can place it — same
 * space (replace) or new space (append) per Kimler's spec.
 */
export const LoadLinkedDocument: CommandDefinitionWithArgs<
  "LoadLinkedDocument",
  { path: typeof Schema.String; mode: typeof Schema.String; spaceId: typeof Schema.String },
  Effect.Effect<LinkedDocLoadedMsg | LinkedDocFailedMsg, never, DocsIpc>
> = defineCommand("LoadLinkedDocument", {
  args: { path: Schema.String, mode: Schema.String, spaceId: Schema.String },
  messages: [Message.LinkedDocumentLoaded, Message.LinkedDocumentLoadFailed],
  execute: ({ path, mode, spaceId }) =>
    Effect.gen(function* () {
      const ipc = yield* DocsIpc
      return yield* Effect.tryPromise({
        try: () => ipc.loadDocument(path),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((r) =>
          Message.LinkedDocumentLoaded({ path: r.path, content: r.content, mode, spaceId })
        ),
        Effect.catch((e) =>
          Effect.succeed(
            Message.LinkedDocumentLoadFailed({ path, reason: e.message.slice(0, 300) })
          )
        )
      )
    }),
})

/**
 * Edit-and-resend (2026-10-13): fork the session at the edited
 * prompt via the ChatIpc seam. Success lands as EditBranchReady
 * (the update truncates the thread and replays the stashed
 * send into the branch); failure as EditBranchFailed, which
 * restores his text to the composer — never a silent loss.
 */
export const BranchForEdit: CommandDefinitionWithArgs<
  "BranchForEdit",
  { sessionId: typeof Schema.String; userOrdinal: typeof Schema.Number },
  Effect.Effect<EditBranchReadyMsg | EditBranchFailedMsg, never, ChatIpc>
> = defineCommand("BranchForEdit", {
  args: { sessionId: Schema.String, userOrdinal: Schema.Number },
  messages: [Message.EditBranchReady, Message.EditBranchFailed],
  execute: ({ sessionId, userOrdinal }) =>
    Effect.gen(function* () {
      const ipc = yield* ChatIpc
      return yield* Effect.tryPromise({
        try: () => ipc.branchSession(sessionId, userOrdinal),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((r) => Message.EditBranchReady({ newSessionId: r.newSessionId })),
        Effect.catch((e) =>
          Effect.succeed(Message.EditBranchFailed({ reason: e.message.slice(0, 300) }))
        )
      )
    }),
})

type HomeBriefLoadedMsg = ReturnType<typeof Message.HomeRequestBriefLoaded>
type HomeBriefFailedMsg = ReturnType<typeof Message.HomeRequestBriefLoadFailed>

/**
 * Load the full text of one pending capability request so the UI can
 * open it as a build brief. The panel list only carries a truncated
 * summary; a build detail must not be generated from a truncated need.
 */
export const LoadHomeRequestBrief: CommandDefinitionWithArgs<
  "LoadHomeRequestBrief",
  { capability: typeof Schema.String, at: typeof Schema.String },
  Effect.Effect<HomeBriefLoadedMsg | HomeBriefFailedMsg, never, HomeIpc>
> = defineCommand("LoadHomeRequestBrief", {
  args: { capability: Schema.String, at: Schema.String },
  messages: [Message.HomeRequestBriefLoaded, Message.HomeRequestBriefLoadFailed],
  execute: ({ capability, at }) =>
    Effect.gen(function* () {
      const ipc = yield* HomeIpc
      return yield* Effect.tryPromise({
        try: () => ipc.getRequestDetail(capability, at),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((r) => Message.HomeRequestBriefLoaded({ capability: r.capability, why: r.why, at: r.at })),
        Effect.catch((e) =>
          Effect.succeed(
            Message.HomeRequestBriefLoadFailed({ capability, reason: e.message.slice(0, 300) })
          )
        )
      )
    }),
})

type HomeDismissedMsg = ReturnType<typeof Message.HomeRequestDismissed>
type HomeDismissFailedMsg = ReturnType<typeof Message.HomeRequestDismissFailed>

/** Dismiss one pending capability request via the HomeIpc seam. */
export const DismissHomeRequest: CommandDefinitionWithArgs<
  "DismissHomeRequest",
  { capability: typeof Schema.String, at: typeof Schema.String },
  Effect.Effect<HomeDismissedMsg | HomeDismissFailedMsg, never, HomeIpc>
> = defineCommand("DismissHomeRequest", {
  args: { capability: Schema.String, at: Schema.String },
  messages: [Message.HomeRequestDismissed, Message.HomeRequestDismissFailed],
  execute: ({ capability, at }) =>
    Effect.gen(function* () {
      const ipc = yield* HomeIpc
      return yield* Effect.tryPromise({
        try: () => ipc.dismissRequest(capability, at),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map(() => Message.HomeRequestDismissed({ capability })),
        Effect.catch((e) =>
          Effect.succeed(Message.HomeRequestDismissFailed({ reason: e.message.slice(0, 300) }))
        )
      )
    }),
})

type ProjectActionDoneMsg = ReturnType<typeof Message.HomeProjectActionDone>

/**
 * Project actions (2026-10-12): switch / create / move / add over the
 * HomeIpc seam. Each resolves to HomeProjectActionDone; the update
 * handler answers it with a fresh LoadHomeData so the panel always
 * reflects the store, never an optimistic guess. Failures also resolve
 * to ActionDone (logged) — the refresh shows the true state either way.
 */
export const SwitchHomeProject: CommandDefinitionWithArgs<
  "SwitchHomeProject",
  { id: typeof Schema.String },
  Effect.Effect<ProjectActionDoneMsg, never, HomeIpc>
> = defineCommand("SwitchHomeProject", {
  args: { id: Schema.String },
  messages: [Message.HomeProjectActionDone],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const ipc = yield* HomeIpc
      yield* Effect.tryPromise({
        try: () => ipc.setActiveProject(id),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.catch(() => Effect.void))
      return Message.HomeProjectActionDone()
    }),
})

export const CreateHomeProject: CommandDefinitionWithArgs<
  "CreateHomeProject",
  { name: typeof Schema.String, purpose: typeof Schema.String },
  Effect.Effect<ProjectActionDoneMsg, never, HomeIpc>
> = defineCommand("CreateHomeProject", {
  args: { name: Schema.String, purpose: Schema.String },
  messages: [Message.HomeProjectActionDone],
  execute: ({ name, purpose }) =>
    Effect.gen(function* () {
      const ipc = yield* HomeIpc
      yield* Effect.tryPromise({
        try: () => ipc.createProject(name, purpose),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.catch(() => Effect.void))
      return Message.HomeProjectActionDone()
    }),
})

export const MoveHomeAsset: CommandDefinitionWithArgs<
  "MoveHomeAsset",
  { fromId: typeof Schema.String, toId: typeof Schema.String, kind: typeof Schema.String, title: typeof Schema.String, path: typeof Schema.String },
  Effect.Effect<ProjectActionDoneMsg, never, HomeIpc>
> = defineCommand("MoveHomeAsset", {
  args: { fromId: Schema.String, toId: Schema.String, kind: Schema.String, title: Schema.String, path: Schema.String },
  messages: [Message.HomeProjectActionDone],
  execute: ({ fromId, toId, kind, title, path }) =>
    Effect.gen(function* () {
      const ipc = yield* HomeIpc
      yield* Effect.tryPromise({
        try: () => ipc.moveAsset(fromId, toId, kind, title, path === "" ? undefined : path),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.catch(() => Effect.void))
      return Message.HomeProjectActionDone()
    }),
})

export const AddHomeRecentToProject: CommandDefinitionWithArgs<
  "AddHomeRecentToProject",
  { projectId: typeof Schema.String, path: typeof Schema.String, title: typeof Schema.String },
  Effect.Effect<ProjectActionDoneMsg, never, HomeIpc>
> = defineCommand("AddHomeRecentToProject", {
  args: { projectId: Schema.String, path: Schema.String, title: Schema.String },
  messages: [Message.HomeProjectActionDone],
  execute: ({ projectId, path, title }) =>
    Effect.gen(function* () {
      const ipc = yield* HomeIpc
      yield* Effect.tryPromise({
        try: () => ipc.addAsset(projectId, path, title),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.catch(() => Effect.void))
      return Message.HomeProjectActionDone()
    }),
})

/* ------------------------------------------------------------------ */
/* HomeDash (2026-10-13)                                               */
/* ------------------------------------------------------------------ */

type HomedashLoadedMsg = ReturnType<typeof Message.HomedashLoaded>
type HomedashFailedMsg = ReturnType<typeof Message.HomedashFailed>
type VoiceAlertsChangedMsg = ReturnType<typeof Message.VoiceAlertsChanged>
type NewsArticleLoadedMsg = ReturnType<typeof Message.NewsArticleLoaded>
type NewsArticleFailedMsg = ReturnType<typeof Message.NewsArticleFailed>

/**
 * Load the HomeDash state (enabled widgets, manifests, effective
 * settings) via the HomedashIpc seam.
 */
export const LoadHomedash: CommandDefinitionWithArgs<
  "LoadHomedash",
  { correlationId: typeof Schema.String },
  Effect.Effect<HomedashLoadedMsg | HomedashFailedMsg, never, HomedashIpc>
> = defineCommand("LoadHomedash", {
  args: { correlationId: Schema.String },
  messages: [Message.HomedashLoaded, Message.HomedashFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* HomedashIpc
      return yield* Effect.tryPromise({
        try: () => ipc.getHomedash(),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((d) =>
          Message.HomedashLoaded({
            widgets: d.widgets.map((w) => ({
              ...w,
              settings: w.settings.map((s) => ({ ...s })),
            })),
          })
        ),
        Effect.catch((e) =>
          Effect.succeed(Message.HomedashFailed({ reason: e.message.slice(0, 300) }))
        )
      )
    }),
})

/**
 * Persist one widget setting, then reload so every surface (dash,
 * Settings) renders the effective value — the store is the truth,
 * never the control.
 */
const HomedashValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])

export const ApplyHomedashSetting: CommandDefinitionWithArgs<
  "ApplyHomedashSetting",
  {
    correlationId: typeof Schema.String
    widgetId: typeof Schema.String
    key: typeof Schema.String
    value: typeof HomedashValueSchema
  },
  Effect.Effect<HomedashLoadedMsg | HomedashFailedMsg, never, HomedashIpc>
> = defineCommand("ApplyHomedashSetting", {
  args: {
    correlationId: Schema.String,
    widgetId: Schema.String,
    key: Schema.String,
    value: HomedashValueSchema,
  },
  messages: [Message.HomedashLoaded, Message.HomedashFailed],
  execute: (args) =>
    Effect.gen(function* () {
      const ipc = yield* HomedashIpc
      return yield* Effect.tryPromise({
        try: async () => {
          await ipc.setSetting(args.widgetId, args.key, args.value)
          return ipc.getHomedash()
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((d) =>
          Message.HomedashLoaded({
            widgets: d.widgets.map((w) => ({
              ...w,
              settings: w.settings.map((s) => ({ ...s })),
            })),
          })
        ),
        Effect.catch((e) =>
          Effect.succeed(Message.HomedashFailed({ reason: e.message.slice(0, 300) }))
        )
      )
    }),
})

/**
 * Mark one GlobeNews event read, then reload — same discipline as
 * ApplyHomedashSetting: the store is the truth, the reload carries
 * the read flag to the globe (cyan ring) and the feed (dimmed row).
 */
export const MarkNewsRead: CommandDefinitionWithArgs<
  "MarkNewsRead",
  { correlationId: typeof Schema.String; id: typeof Schema.String },
  Effect.Effect<HomedashLoadedMsg | HomedashFailedMsg, never, HomedashIpc>
> = defineCommand("MarkNewsRead", {
  args: { correlationId: Schema.String, id: Schema.String },
  messages: [Message.HomedashLoaded, Message.HomedashFailed],
  execute: (args) =>
    Effect.gen(function* () {
      const ipc = yield* HomedashIpc
      return yield* Effect.tryPromise({
        try: async () => {
          await ipc.markNewsRead(args.id)
          return ipc.getHomedash()
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((d) =>
          Message.HomedashLoaded({
            widgets: d.widgets.map((w) => ({
              ...w,
              settings: w.settings.map((s) => ({ ...s })),
            })),
          })
        ),
        Effect.catch((e) =>
          Effect.succeed(Message.HomedashFailed({ reason: e.message.slice(0, 300) }))
        )
      )
    }),
})

/** GlobeNews (2026-10-13): run the scan now, then reload the dash (the store is the truth). */
export const RefreshNews: CommandDefinitionWithArgs<
  "RefreshNews",
  { correlationId: typeof Schema.String },
  Effect.Effect<HomedashLoadedMsg | HomedashFailedMsg, never, HomedashIpc>
> = defineCommand("RefreshNews", {
  args: { correlationId: Schema.String },
  messages: [Message.HomedashLoaded, Message.HomedashFailed],
  execute: () =>
    Effect.gen(function* () {
      const ipc = yield* HomedashIpc
      return yield* Effect.tryPromise({
        try: async () => {
          await ipc.refreshNews()
          return ipc.getHomedash()
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((d) =>
          Message.HomedashLoaded({
            widgets: d.widgets.map((w) => ({
              ...w,
              settings: w.settings.map((s) => ({ ...s })),
            })),
          })
        ),
        Effect.catch((e) =>
          Effect.succeed(Message.HomedashFailed({ reason: e.message.slice(0, 300) }))
        )
      )
    }),
})

/**
 * Voice alerts (2026-10-13, Threat Channel §8): silence one
 * repeating alert. The response carries the still-active set;
 * on failure the command logs and re-reads the dash so the
 * strip keeps telling the truth (the alert is still active).
 */
export const DismissVoiceAlert: CommandDefinitionWithArgs<
  "DismissVoiceAlert",
  { correlationId: typeof Schema.String; id: typeof Schema.String },
  Effect.Effect<VoiceAlertsChangedMsg, never, HomedashIpc>
> = defineCommand("DismissVoiceAlert", {
  args: { correlationId: Schema.String, id: Schema.String },
  messages: [Message.VoiceAlertsChanged],
  execute: (args) =>
    Effect.gen(function* () {
      const ipc = yield* HomedashIpc
      return yield* Effect.tryPromise({
        try: () => ipc.dismissVoiceAlert(args.id),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((alerts) =>
          Message.VoiceAlertsChanged({
            alerts: alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity })),
          })
        ),
        Effect.catch((e) =>
          Effect.gen(function* () {
            console.error(`[aimy] voice alert dismiss failed: ${e.message}`)
            const d = yield* Effect.tryPromise({
              try: () => ipc.getHomedash(),
              catch: () => new Error("homedash reload failed"),
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const alerts =
              d?.widgets.find((w) => w.voiceAlerts !== undefined)?.voiceAlerts ?? []
            return Message.VoiceAlertsChanged({
              alerts: alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity })),
            })
          })
        )
      )
    }),
})

/** GlobeNews (2026-10-13): fetch one event's article for the drawer. */
export const LoadNewsArticle: CommandDefinitionWithArgs<
  "LoadNewsArticle",
  { correlationId: typeof Schema.String; id: typeof Schema.String },
  Effect.Effect<NewsArticleLoadedMsg | NewsArticleFailedMsg, never, HomedashIpc>
> = defineCommand("LoadNewsArticle", {
  args: { correlationId: Schema.String, id: Schema.String },
  messages: [Message.NewsArticleLoaded, Message.NewsArticleFailed],
  execute: (args) =>
    Effect.gen(function* () {
      const ipc = yield* HomedashIpc
      return yield* Effect.tryPromise({
        try: () => ipc.getNewsArticle(args.id),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.map((a) =>
          Message.NewsArticleLoaded({ id: a.id, title: a.title, content: a.content, url: a.url })
        ),
        Effect.catch((e) =>
          Effect.succeed(Message.NewsArticleFailed({ id: args.id, reason: e.message.slice(0, 300) }))
        )
      )
    }),
})

/* NOTE (2026-10-12): there is deliberately NO DownloadDocument command.
 * A no-message DOM command (messages: []) crashes this app with
 * "Schema validation failed" — the same failure that disabled
 * FocusComposer/ScrollToBottom/RenderMermaid on 2026-10-10. Download is
 * a delegated DOM op in desktop main.ts (like the copy button), reading
 * the space's hidden .drawer-space-source span. */
