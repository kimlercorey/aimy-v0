/**
 * ui/src/update.ts — the pure update function for the shell track.
 *
 * `(rawMessage, Model) -> (Model, Command[])`. Every sibling slice
 * (asc, jobs, banners, …) passes through untouched by construction: this
 * function only ever rebuilds `session`, `permissions`, and `rejections`.
 *
 * STRUCTURAL RULES (tested in update.test.ts):
 * 1. No dial-setting message exists in the vocabulary, and any raw message
 *    that fails Schema decode — including a `DialsSetDirectly`-shaped object
 *    arriving over DevTools/MCP — is REJECTED and logged to
 *    `model.rejections`, never applied. This is the architectural teeth
 *    behind "computed, not chosen" (architecture §3.2, §3.9).
 * 2. `Message.match` is exhaustive over the union: adding a variant without a
 *    handler is a compile error, and the MESSAGE_TAGS list keeps the runtime
 *    guard in sync.
 * 3. Stale stream chunks (wrong streamId — e.g. from an interrupted turn) are
 *    ignored, not applied: interruption is last-writer-wins by construction.
 * 4. Timestamps ride in on the messages themselves; update never calls
 *    Date.now() for replay state, so the DevTools timeline replays exactly.
 *    (The rejections audit uses the wall clock — it is audit metadata, not
 *    replay state — and is bounded to MAX_REJECTIONS.)
 */
import { Schema } from "effect"
import { Update } from "foldkit"
import { MemoryService } from "../../memory/service.js"
import type { SafetyKernel } from "../../permission-kernel/index.js"
import { PersistMemory, RequestPermission, SendToInference, StopNarration, SaveDocument, LoadHomeData, LoadHomeDocument, LoadHomeRequestBrief, DismissHomeRequest, SwitchHomeProject, CreateHomeProject, MoveHomeAsset, AddHomeRecentToProject, LoadHomedash, ApplyHomedashSetting, MarkNewsRead, LoadNewsArticle, RefreshNews, DismissVoiceAlert, LoadLinkedDocument, BranchForEdit } from "./commands.js"
import { parseMessageTools, splitBlocks, extractToolCalls } from "./tool-calls.js";
import {
  AddVoice,
  DeleteVoice,
  FetchEngineStatus,
  FetchVoices,
  InstallEngine,
  InstallSttEngine,
  TestSttEngine,
  MicStartRecording,
  MicStopRecording,
  TranscribeMicAudio,
  ListMicDevices,
  PickVoiceFile,
  PlayVoiceSample,
  RunProviderTest,
  SelectVoice,
  SetVoiceDefault,
} from "./voice/commands.js"
import { MAX_REJECTIONS, type Model, type RejectionRecord, type DrawerSpace, type DrawerSpaceVersion, spaceDirty, defaultDocPath } from "./model.js"
import { MESSAGE_TAGS, Message } from "./messages.js"
import type { TtsIpc } from "./voice/seam.js"
import type { DocsIpc } from "./docs-seam.js"
import type { HomeIpc } from "./home-seam.js"
import type { HomedashIpc } from "./homedash-seam.js"
import type { ChatIpc } from "./chat-seam.js"

/** Services the shell track's commands require; provided at the shell boundary. */
export type ShellServices = SafetyKernel | MemoryService | TtsIpc | DocsIpc | HomeIpc | HomedashIpc | ChatIpc

/** Estimated transcript-row height (px) mapping scrollTop -> window anchor. */
export const ESTIMATED_ROW_PX = 64

const knownTag = (tag: string): boolean =>
  (MESSAGE_TAGS as ReadonlyArray<string>).includes(tag)

const tagOf = (raw: unknown): string | undefined =>
  typeof raw === "object" && raw !== null && "_tag" in raw && typeof raw._tag === "string"
    ? raw._tag
    : undefined

/**
 * Reject a raw message: log it to the bounded audit trail, change nothing
 * else, emit no commands. Rejection is total — no partial application.
 */
const reject = (
  model: Model,
  raw: unknown,
  reason: RejectionRecord["reason"],
): Update.Return<Model, Message, ShellServices> => {
  const records = [
    ...model.rejections.records,
    { at: Date.now(), tag: tagOf(raw) ?? "non-object", reason },
  ].slice(-MAX_REJECTIONS)
  return {
    model: {
      ...model,
      rejections: { ...model.rejections, records },
    },
  }
}

const streamingActive = (model: Model, streamId: string): boolean =>
  model.session.streaming.active && model.session.streaming.streamId === streamId

/**
 * The update function. Accepts `unknown` so the DevTools/MCP dispatch path —
 * which hands it unvalidated JSON — goes through the same rejection gate as
 * the UI. Typed callers pass `Message`; the decode is a no-op for them.
 */
/**
 * Build the [AIMY-UISTATE] marker with current drawer state (2026-10-12).
 * Prepended to every inference input so she just knows the UI state —
 * no tool call needed, no curiosity required.
 */
export const uiStateMarker = (model: Model): string => {
  const drawer = model.session.drawer ?? { open: false, spaces: [], activeSpaceId: null, maxSpaces: 3 }
  // Include the CURRENT content of each space (2026-10-12) so her edits
  // start from the truth — including edits Kimler made directly in the
  // document — instead of from her own last-sent copy. Bounded: above
  // ~20K chars total the contents are omitted and she is told so.
  const totalContent = drawer.spaces.reduce((n, s) => n + s.content.length, 0)
  const inlineContent = totalContent <= 20000
  // Every inference-send path must use this marker. Log the state being
  // sent so a missing/stale UI snapshot is visible in the trace instead
  // of surfacing only as AImy claiming the drawer is closed or empty.
  console.warn(
    `[diag] uistate: open=${drawer.open} spaces=${drawer.spaces.length} active=${drawer.activeSpaceId ?? "none"} contentChars=${totalContent} inline=${inlineContent} notes=${(drawer.pendingNotes ?? []).length}`
  )
  return `[AIMY-UISTATE]${JSON.stringify({
    drawerOpen: drawer.open,
    spaces: drawer.spaces.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      path: s.path ?? null,
      savedToDisk: !spaceDirty(s),
      versions: (s.history ?? []).length,
      content: inlineContent ? s.content : null,
    })),
    activeSpaceId: drawer.activeSpaceId,
    maxSpaces: drawer.maxSpaces,
    // Changes Kimler made in the UI since her last turn (2026-10-12):
    // restores, direct edits, rejected stale tool calls. Delivered once
    // (cleared when this message is sent — see UserSentMessage).
    notes: drawer.pendingNotes ?? [],
    ...(inlineContent
      ? {}
      : { note: "Space contents exceed 20000 chars total and are not inlined here. Work from the file at each space's path, or ask him." }),
  })}\n`
}

/**
 * Append a version snapshot to a space's session history (2026-10-12).
 * Consecutive identical content is not duplicated. The full history is
 * retained until the session closes (Kimler's spec).
 */
const pushVersion = (
  space: DrawerSpace,
  title: string,
  content: string,
  at: number,
  label: string,
): ReadonlyArray<DrawerSpaceVersion> => {
  const hist = space.history ?? []
  const last = hist[hist.length - 1]
  if (last !== undefined && last.content === content && last.title === title) return hist
  return [...hist, { title, content, at, label }]
}

/**
 * Open content in the drawer as a space (2026-10-13): an existing
 * space (matched by path, then id) updates in place and activates;
 * a new id appends (refused past maxSpaces) and resets height
 * ratios. The space reads CLEAN (savedContent = content) — these
 * are previews, not drafts. Used by documents and news articles.
 */
/**
 * A loaded document's drawer identity: the space id slugs the
 * filename stem; the title is the first `# ` heading when the
 * document has one. Shared by the Continue open flow and the
 * document-link flow so a document is the same space however
 * it was reached.
 */
const docSpaceSeed = (path: string, content: string): { id: string; title: string } => {
  const stem = (path.split("/").pop() ?? "document").replace(/\.md$/, "")
  const id = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "document"
  const heading = content.split("\n").map((l) => l.trim()).find((l) => l.startsWith("# "))
  const title = heading !== undefined ? heading.replace(/^#\s+/, "").slice(0, 80) : stem.replace(/-/g, " ")
  return { id, title }
}

/**
 * Append a sent prompt to the in-memory global history
 * (2026-10-13): same rules as the persisted store in the main
 * process — blanks skipped, consecutive duplicates collapsed,
 * capped at 300. The store on disk is written by chat.send;
 * this keeps the open app current without a reload.
 */
const appendedPromptHistory = (
  list: ReadonlyArray<string> | undefined,
  text: string,
): Array<string> => {
  const base = list ?? []
  if (text.trim() === "" || base[base.length - 1] === text) return [...base]
  return [...base, text].slice(-300)
}

const openInDrawer = (
  model: Model,
  opts: { id: string; title: string; content: string; path?: string | undefined }
): Model => {
  const drawer = model.session.drawer
  const at = Date.now()
  const existing =
    (opts.path !== undefined ? drawer.spaces.find((s) => s.path === opts.path) : undefined) ??
    drawer.spaces.find((s) => s.id === opts.id)
  if (existing !== undefined) {
    const spaces =
      existing.content === opts.content
        ? drawer.spaces
        : drawer.spaces.map((s) =>
            s.id === existing.id
              ? {
                  ...s,
                  title: opts.title,
                  content: opts.content,
                  savedContent: opts.content,
                  savedAt: at,
                  saveError: undefined,
                  history: pushVersion(s, opts.title, opts.content, at, "Opened"),
                }
              : s
          )
    return {
      ...model,
      session: {
        ...model.session,
        drawer: { ...drawer, open: true, activeSpaceId: existing.id, spaces },
      },
    }
  }
  if (drawer.spaces.length >= drawer.maxSpaces) {
    console.warn(
      `[diag] update: openInDrawer refused (maxSpaces) id=${opts.id} path=${opts.path ?? "-"}`
    )
    return model
  }
  const space: DrawerSpace = {
    id: opts.id,
    title: opts.title,
    kind: "preview",
    content: opts.content,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    savedContent: opts.content,
    savedAt: at,
    history: [{ title: opts.title, content: opts.content, at, label: "Opened" }],
  }
  return {
    ...model,
    session: {
      ...model.session,
      drawer: {
        ...drawer,
        open: true,
        activeSpaceId: opts.id,
        spaces: [...drawer.spaces, space],
        // Space count changed — reset height ratios to equal split.
        heightRatios: {},
      },
    },
  }
}

/**
 * Turn one pending capability request into a build brief (2026-10-12).
 * Semantically this is a request for missing functionality to be built,
 * not approval to use an existing permission. Opening the brief changes
 * no request status: it stays pending until the capability is actually
 * implemented and its acceptance test passes.
 */
const capabilityBuildBrief = (
  capability: string,
  why: string,
  at: string
): { id: string; title: string; path: string; content: string } => {
  const slug = capability.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "capability"
  const title = `Capability Build Brief — ${capability}`
  const content = [
    `# ${title}`,
    "",
    "## What action is needed",
    "",
    "This is a **build request**, not an approval to use an existing capability. AImy is blocked until the missing capability is implemented and verified.",
    "",
    "Opening this brief does not approve, fulfill, or dismiss the request. It remains pending until the acceptance test below passes.",
    "",
    "## Requested capability",
    "",
    "```text",
    capability,
    "```",
    "",
    "## Why AImy needs it",
    "",
    why.trim() !== "" ? why : "No detail was recorded with this request.",
    "",
    "## Request record",
    "",
    `- Filed: ${at}`,
    "- Status: pending",
    "- Source: `~/.aimy/capability-requests.jsonl`",
    "",
    "## Build scope",
    "",
    "Implement the missing capability described above so AImy can complete the original task herself. Do not substitute a manual handoff, a chat-only workaround, or a claim that the task is complete.",
    "",
    "Keep the user in control of the target and content. Make the operation observable: log the attempt, the result, and any failure so the outcome can be diagnosed from evidence.",
    "",
    "## Acceptance test",
    "",
    "1. Ask AImy to perform the original blocked task using the new capability.",
    "2. Verify the result at the destination the task names.",
    "3. Verify that a failure is reported honestly and visibly, with no silent fallback.",
    "4. Mark the capability request fulfilled only after these checks pass.",
    "",
  ].join("\n")
  return {
    id: `build-brief-${slug}`,
    title,
    path: `planning/capability-request-${slug}.md`,
    content,
  }
}

// ── Validation (2026-10-12; design: planning/knowledge-and-validation-design.md)
// Validators as senses: formal-language blocks in drawer documents are
// checked when content lands, and failures/recoveries reach her as
// change notes. JSON is validated here (pure); mermaid is validated by
// the renderer, which owns the parser, and reported back via
// DrawerValidationReported. Both feed the same issue record so a
// failure is announced once and its recovery announced once.

/** Extract ```json fenced blocks from markdown and JSON.parse each. */
const jsonBlockErrors = (content: string): Array<string> => {
  const errors: Array<string> = []
  const re = /```json[ \t]*\r?\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  let block = 0
  while ((m = re.exec(content)) !== null) {
    block++
    try {
      JSON.parse(m[1]!)
    } catch (e) {
      errors.push(`json block ${block}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return errors
}

/**
 * Diff one space+language validation outcome against the issue record.
 * Returns the next record plus any change notes (failure announced once
 * per distinct error; recovery announced once).
 */
const diffValidation = (
  issues: Readonly<Record<string, string>> | undefined,
  spaceId: string,
  title: string,
  lang: string,
  errorSummary: string | null,
): { issues: Record<string, string>; notes: Array<string> } => {
  const key = `${spaceId}:${lang}`
  const next: Record<string, string> = { ...(issues ?? {}) }
  const prev = next[key]
  const notes: Array<string> = []
  if (errorSummary !== null) {
    if (prev !== errorSummary) {
      notes.push(
        `VALIDATION — the ${lang} in "${title}" (${spaceId}) is broken: ${errorSummary} It was applied/shown anyway. Fix it before building on it — the validator output above is exact.`
      )
      next[key] = errorSummary
    }
  } else if (prev !== undefined) {
    notes.push(`VALIDATION RECOVERED — the ${lang} in "${title}" (${spaceId}) now parses/renders cleanly.`)
    delete next[key]
  }
  return { issues: next, notes }
}

/** Run the local (JSON) validation for one space's new content. */
const validateSpaceJson = (
  issues: Readonly<Record<string, string>> | undefined,
  space: DrawerSpace,
): { issues: Record<string, string>; notes: Array<string> } => {
  const errors = jsonBlockErrors(space.content)
  return diffValidation(issues, space.id, space.title, "json", errors.length > 0 ? errors.join("; ") : null)
}

export const update = (
  model: Model,
  rawMessage: unknown,
): Update.Return<Model, Message, ShellServices> => {
  if (!Schema.is(Message)(rawMessage)) {
    const tag = tagOf(rawMessage)
    const reason: RejectionRecord["reason"] =
      tag !== undefined && /dial/i.test(tag)
        ? "dial-mutation-rejected"
        : tag !== undefined && !knownTag(tag)
          ? "unknown-tag"
          : "decode-failed"
    return reject(model, rawMessage, reason)
  }

  const message: Message = rawMessage
  return Message.match<Update.Return<Model, Message, ShellServices>>(message, {
    ComposerDraftChanged: ({ text }) => {
      // Draft persistence (2026-10-13): keep the stored copy
      // current so a relaunch restores the half-typed prompt.
      try {
        localStorage.setItem("aimy.composerDraft", text)
      } catch { /* storage unavailable — draft lives in memory only */ }
      return {
        model: {
          ...model,
          // Manual edit clears the voice-draft flag (user took over).
          // Preserve attachments (2026-10-11). Rebuilding the
          // composer without a historyIndex is also what ends
          // prompt-history cycling when he types (2026-10-13).
          session: {
            ...model.session,
            composer: { draft: text, attachments: model.session.composer.attachments, documents: model.session.composer.documents },
            voiceDraft: false,
          },
        },
      }
    },

    // Stop generation (2026-10-13, Kimler): Esc or the stop
    // button. What she had said so far settles as a stopped
    // message — display-parsed only; the settle machinery
    // never runs on a partial turn (a half-written tool call
    // must not execute). Clearing the streaming state is also
    // what tears the chat pump down, and its teardown cancels
    // the main-side stream.
    StreamStopRequested: () => {
      const streaming = model.session.streaming
      if (!streaming.active) return { model }
      console.warn(`[diag] update: StreamStopRequested stream=${streaming.streamId} partialChars=${streaming.text.length}`)
      let partial = ""
      try {
        partial = parseMessageTools(streaming.text).text
      } catch {
        partial = ""
      }
      const messages =
        partial.trim() !== ""
          ? [
              ...model.session.messages,
              {
                id: `${streaming.streamId}-stopped`,
                role: "assistant" as const,
                text: partial,
                at: Date.now(),
                stopped: true,
              },
            ]
          : model.session.messages
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages,
            streaming: { active: false, streamId: "", text: "", startedAt: 0 },
            speakingStreamId: undefined,
            pendingAudioChunks: [],
          },
        },
        commands: [StopNarration()],
      }
    },

    // Edit-and-resend (2026-10-13): load one of his messages
    // into the composer as a pending edit. Sending forks the
    // session at that message (see UserSentMessage); cancelling
    // clears both the flag and the box.
    UserMessageEditRequested: ({ id }) => {
      const target = model.session.messages.find((m) => m.id === id && m.role === "user")
      if (target === undefined || model.session.streaming.active) {
        console.warn(`[diag] update: UserMessageEditRequested refused id=${id}`)
        return { model }
      }
      try {
        localStorage.setItem("aimy.composerDraft", target.text)
      } catch { /* storage unavailable */ }
      console.warn(`[diag] update: UserMessageEditRequested id=${id} chars=${target.text.length}`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            pendingEditFromId: id,
            composer: {
              draft: target.text,
              attachments: model.session.composer.attachments,
              // The message's documents ride along (2026-10-13):
              // editing a prompt he gave her WITH a file should
              // not silently strip the file from the resend.
              documents: [...(target.documents ?? [])],
            },
          },
        },
      }
    },

    UserMessageEditCancelled: () => {
      try {
        localStorage.removeItem("aimy.composerDraft")
      } catch { /* storage unavailable */ }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            pendingEditFromId: undefined,
            // Cancelling the edit also unloads the documents it
            // restored — they belonged to that message, not to a
            // fresh prompt (2026-10-13).
            composer: { draft: "", attachments: model.session.composer.attachments, documents: [] },
          },
        },
      }
    },

    // Prompt-history cycling (2026-10-13): the view's decider
    // computed the recalled prompt and its position; the update
    // just lands them (attachments preserved, as on any draft
    // change). index -1 with an empty text = cycled past the
    // newest, back to a fresh box.
    ComposerHistoryStepped: ({ text, index }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          composer: {
            draft: text,
            attachments: model.session.composer.attachments,
            documents: model.session.composer.documents,
            ...(index >= 0 ? { historyIndex: index } : {}),
          },
        },
      },
    }),

    UserSentMessage: ({ id, text, at, images, documents }) => {
      if (text.trim().length === 0 && (images ?? []).length === 0 && (documents ?? []).length === 0) return { model }
      // The draft is sent — its persisted copy goes too (2026-10-13).
      try {
        localStorage.removeItem("aimy.composerDraft")
      } catch { /* storage unavailable */ }
      const sessionId = model.session.sessionId
      // Derive subject from AImy's perspective: what the user is asking about
      const subject = text.trim().slice(0, 50) + (text.trim().length > 50 ? "…" : "")
      // Ghost 2 (2026-10-10): if voiceDraft was true, input came via STT.
      // Pass viaVoice so the response can auto-trigger TTS.
      const viaVoice = model.session.voiceDraft === true
      // Barge-in (2026-10-11): the user cut in while a response was still
      // streaming or its narration was playing. The loop gets this flag so
      // it can weave the unfinished thought into its reply.
      const interrupted =
        model.session.streaming.active || model.session.speakingStreamId !== undefined
      // Attachments: use message images if provided, else composer staged.
      const msgImages = images ?? model.session.composer.attachments
      const msgDocuments = documents ?? model.session.composer.documents ?? []
      // Edit-and-resend (2026-10-13): he is sending an edited
      // earlier prompt. The thread forks at that prompt FIRST —
      // the send is stashed and lands on EditBranchReady, inside
      // the branched session, so her context and the visible
      // thread truncate together. A second send while a branch
      // is in flight is refused: the stash is the one truth.
      const editFromId = model.session.pendingEditFromId
      if (editFromId !== undefined) {
        if (model.session.pendingEditSend !== undefined) {
          console.warn("[diag] update: UserSentMessage refused — an edit branch is already in flight")
          return { model }
        }
        const upto = model.session.messages.findIndex((m) => m.id === editFromId)
        if (upto >= 0) {
          const userOrdinal = model.session.messages
            .slice(0, upto + 1)
            .filter((m) => m.role === "user").length
          console.warn(`[diag] update: edit-and-resend from=${editFromId} ordinal=${userOrdinal}`)
          return {
            model: {
              ...model,
              session: {
                ...model.session,
                pendingEditFromId: undefined,
                pendingEditSend: {
                  id,
                  fromId: editFromId,
                  text,
                  at,
                  ...(msgImages.length > 0 ? { images: [...msgImages] } : {}),
                  ...(msgDocuments.length > 0 ? { documents: [...msgDocuments] } : {}),
                },
                composer: { draft: "", attachments: [] },
                voiceDraft: false,
              },
            },
            commands: [BranchForEdit({ sessionId, userOrdinal })],
          }
        }
        console.warn(`[diag] update: edit target ${editFromId} not found; sending normally`)
      }
      const newMessages = [
        ...model.session.messages,
        { id, role: "user" as const, text, at, ...(msgImages.length > 0 ? { images: msgImages } : {}), ...(msgDocuments.length > 0 ? { documents: msgDocuments } : {}) },
      ]
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            subject,
            messages: newMessages,
            // Pin the window to the newest message (column-reverse: bottom).
            listWindow: { ...model.session.listWindow, anchorIndex: newMessages.length - 1 },
            composer: { draft: "", attachments: [] },
            promptHistory: appendedPromptHistory(model.session.promptHistory, text),
            voiceDraft: false,
            // Clear speaking indicator: user interrupted, narration stopped.
            speakingStreamId: undefined,
            // Drop pending audio chunks (2026-10-11): interrupted audio must
            // not replay when the new turn starts. The renderer stops the
            // active Audio object when it sees the chunks vanish.
            pendingAudioChunks: [],
            // Change notes were just delivered in this message's
            // [AIMY-UISTATE] marker (built from the pre-send model above)
            // — clear them so they are told exactly once (2026-10-12).
            drawer: { ...model.session.drawer, pendingNotes: [] },
          },
        },
        commands: [
          // Stop any ongoing narration: user interrupted, don't resume old content.
          StopNarration(),
          SendToInference({
            correlationId: id,
            sessionId,
            input: uiStateMarker(model) + text,
            voiceEnabled: model.session.voiceEnabled,
            viaVoice,
            interrupted,
            images: msgImages,
          }),
          PersistMemory({ correlationId: `${id}:user`, sessionId, role: "user", text }),
        ],
      }
    },

    StreamStarted: ({ streamId, sessionId, input: _input, at, viaVoice, interrupted }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          streaming: { active: true, streamId, text: "", startedAt: at, viaVoice: viaVoice ?? false, interrupted: interrupted ?? false, toolActivity: [] },
          // Clear stale speaking indicator from previous turn (2026-10-10).
          speakingStreamId: undefined,
        },
      },
    }),

    StreamChunkReceived: ({ streamId, delta }) => {
      // Stale chunk from an interrupted turn: ignore, never apply.
      if (!streamingActive(model, streamId)) return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            streaming: { ...model.session.streaming, text: model.session.streaming.text + delta },
          },
        },
      }
    },

    StreamToolCallObserved: ({ streamId, tool, resultSummary, args }) => {
      // Drawer tools bypass the streamingActive guard (2026-10-12):
      // ToolCall chunks arrive at the same time as Done, so the stream
      // is often already settled. The drawer must open anyway.
      if (tool === "drawer.preview") {
        console.log(`[diag] update: handling drawer.preview, drawer exists=${model.session.drawer !== undefined}`)
        const drawer = model.session.drawer ?? { open: false, spaces: [], activeSpaceId: null, maxSpaces: 3 }
        const safeArgs = args ?? {}
        const id = typeof safeArgs["id"] === "string" ? safeArgs["id"] : `preview-${Date.now()}`
        const title = typeof safeArgs["title"] === "string" ? safeArgs["title"] : "Preview"
        const content = typeof safeArgs["content"] === "string" ? safeArgs["content"] : ""
        const srcPath = typeof safeArgs["path"] === "string" ? safeArgs["path"] : undefined
        const existing = drawer.spaces.find((s) => s.id === id)
        // Enforce maxSpaces.
        if (!existing && drawer.spaces.length >= drawer.maxSpaces) {
          return {
            model: {
              ...model,
              session: {
                ...model.session,
                messages: [
                  ...model.session.messages,
                  {
                    id: `${streamId}-tool-${model.session.messages.length}`,
                    role: "tool",
                    text: `drawer.preview: drawer full (${drawer.maxSpaces} spaces). Close a space first.`,
                    at: model.session.streaming.startedAt,
                  },
                ],
              },
            },
          }
        }
        const at = model.session.streaming.startedAt
        const spaces = existing
          ? drawer.spaces.map((s) =>
              s.id === id
                ? {
                    ...s,
                    title,
                    content,
                    ...(srcPath !== undefined ? { path: srcPath } : {}),
                    history: pushVersion(s, title, content, at, "Updated"),
                  }
                : s
            )
          : [
              ...drawer.spaces,
              {
                id,
                title,
                kind: "preview",
                content,
                ...(srcPath !== undefined
                  ? { path: srcPath, savedContent: content }
                  : {}),
                history: [{ title, content, at, label: "Opened" }],
              },
            ]
        console.warn(`[diag] update: drawer.preview SUCCESS - open=true, spaces=${spaces.length}, active=${id}`)
        return {
          model: {
            ...model,
            session: {
              ...model.session,
              drawer: { ...drawer, open: true, spaces, activeSpaceId: id },
            },
          },
        }
      }
      if (tool === "drawer.close" && args) {
        const drawer = model.session.drawer ?? { open: false, spaces: [], activeSpaceId: null, maxSpaces: 3 }
        const id = typeof args["id"] === "string" ? args["id"] : "" 
        const spaces = drawer.spaces.filter((s) => s.id !== id)
        return {
          model: {
            ...model,
            session: {
              ...model.session,
              drawer: {
                ...drawer,
                open: spaces.length > 0 ? drawer.open : false,
                spaces,
                activeSpaceId: spaces[0]?.id ?? null,
              },
            },
          },
        }
      }
      // drawer.getState (Phase I 2026-10-12): return ACTUAL current state.
      // The tool's fallback returns "unknown" — the UI overrides with truth.
      // This is the honest check: she must call this before claiming drawer state.
      if (tool === "drawer.getState") {
        const drawer = model.session.drawer ?? { open: false, spaces: [], activeSpaceId: null, maxSpaces: 3 }
        return {
          model: {
            ...model,
            session: {
              ...model.session,
              messages: [
                ...model.session.messages,
                {
                  id: `${streamId}-tool-${model.session.messages.length}`,
                  role: "tool",
                  text: `drawer.getState: ${JSON.stringify({
                    open: drawer.open,
                    spaces: drawer.spaces.map((s) => ({
                      id: s.id,
                      title: s.title,
                      kind: s.kind,
                      path: s.path ?? null,
                      savedToDisk: !spaceDirty(s),
                      versions: (s.history ?? []).length,
                      content: s.content.length <= 20000 ? s.content : null,
                    })),
                    activeSpaceId: drawer.activeSpaceId,
                    maxSpaces: drawer.maxSpaces,
                  })}`,
                  at: model.session.streaming.startedAt,
                },
              ],
            },
          },
        }
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [
              ...model.session.messages,
              {
                id: `${streamId}-tool-${model.session.messages.length}`,
                role: "tool",
                text: `${tool}: ${resultSummary}`,
                at: model.session.streaming.startedAt,
              },
            ],
          },
        },
      }
    },

    // Tool completions forwarded by main (chat.tool IPC, 2026-10-12):
    // accumulate on the ACTIVE stream — the single-stream UI attributes
    // by activity, not by streamId (the shell and main ids differ; the
    // event's streamId is logged for diagnosis). No transcript writes,
    // no drawer effects: this channel is footer state only.
    StreamToolActivity: ({ streamId, tool, ok, conclusion }) => {
      if (!model.session.streaming.active) {
        console.warn(`[diag] update: StreamToolActivity ignored (no active stream) tool=${tool} ipcStream=${streamId}`)
        return { model }
      }
      console.warn(`[diag] update: StreamToolActivity tool=${tool} ok=${ok} ipcStream=${streamId}`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            streaming: {
              ...model.session.streaming,
              toolActivity: [...(model.session.streaming.toolActivity ?? []), { tool, ok, conclusion }],
            },
          },
        },
      }
    },

    StreamSettled: ({ streamId, text, at, usage }) => {
      // Diagnostic: log at entry (2026-10-10: responses vanishing). If this
      // doesn't appear, the message isn't dispatched or streamingActive fails.
      console.log(`[aimy] StreamSettled ENTRY: streamId=${streamId} textLen=${text.length}`)
      if (!streamingActive(model, streamId)) {
        console.log(`[aimy] StreamSettled: streaming not active for ${streamId}, ignoring`)
        return { model }
      }
      const sessionId = model.session.sessionId
      // Estimate input tokens from local message history (system prompt ~2K + messages).
      // The IPC layer provides outputTokens; input is estimated here where history lives.
      const estimateTokens = (s: string): number => Math.ceil(s.length / 4)
      const historyTokens = model.session.messages.reduce(
        (sum, m) => sum + estimateTokens(m.text),
        2000 // system prompt estimate
      )
      // Multi-block sequencing (2026-10-10): split on /// markers into
      // separate bubbles. The transcript is the sequencer — each block
      // renders and narrates in order. Parse tool calls from the full text
      // first, then split the clean text into blocks.
      // Defensive: if parsing fails, fall back to single block with raw text
      // (2026-10-10: responses vanishing).
      let parsed: { text: string; toolsUsed: string[]; narratedTexts: string[]; toolSummaries: string[] }
      let blocks: string[]
      try {
        parsed = parseMessageTools(text)
        blocks = splitBlocks(parsed.text)
      } catch (e) {
        console.error(`[aimy] StreamSettled: parse failed (${e instanceof Error ? e.message : e}), using raw text`)
        parsed = { text, toolsUsed: [], narratedTexts: [], toolSummaries: [] }
        blocks = [text]
      }
      const toolsUsed = parsed.toolsUsed
      const narratedTexts = parsed.narratedTexts
      const toolSummaries = parsed.toolSummaries
      // Footer outcomes (2026-10-12): match this stream's observed tool
      // completions to the parsed calls by name, FIFO per name — robust
      // to a blocked call in the middle (it simply never completes and
      // lands "none": untinted, no conclusion). Positional matching
      // would misattribute every outcome after a blocked call.
      const activityQueues = new Map<string, Array<{ ok: boolean; conclusion: string }>>()
      for (const a of model.session.streaming.toolActivity ?? []) {
        const q = activityQueues.get(a.tool) ?? []
        q.push({ ok: a.ok, conclusion: a.conclusion })
        activityQueues.set(a.tool, q)
      }
      const toolOutcomes = toolsUsed.map((t) => {
        const q = activityQueues.get(t)
        const hit = q !== undefined && q.length > 0 ? q.shift()! : undefined
        return hit !== undefined
          ? { status: (hit.ok ? "ok" : "failed") as "ok" | "failed", conclusion: hit.conclusion }
          : { status: "none" as const, conclusion: "" }
      })
      // Drawer preview from text (2026-10-12): ToolCall chunks are not forwarded
      // via IPC, so parse drawer.preview directly from the settled text.
      // This is the fallback that actually works.
      let drawerUpdate: typeof model.session.drawer | undefined
      // Rejection notes from this turn's drawer calls (2026-10-12):
      // stale-based previews / unlandable patch edits. Delivered to her
      // via pendingNotes in the next turn's state marker.
      const settledNotes: Array<string> = []
      try {
        const toolCalls = extractToolCalls(text)
        for (const tc of toolCalls) {
          if (tc.tool === "drawer.preview") {
            const args = tc.args as Record<string, unknown>
            const id = typeof args["id"] === "string" ? args["id"] : `preview-${Date.now()}`
            const title = typeof args["title"] === "string" ? args["title"] : "Preview"
            const content = typeof args["content"] === "string" ? args["content"] : ""
            const path = typeof args["path"] === "string" ? args["path"] : undefined
            console.warn(`[diag] StreamSettled: drawer.preview id=${id} hasPath=${path !== undefined} hasContent=${content.length > 0}`)
            const base = drawerUpdate ?? model.session.drawer ?? { open: false, spaces: [], activeSpaceId: null, maxSpaces: 3, heightRatios: {} }
            const existing = base.spaces.find((s) => s.id === id)
            // Base-version guard (2026-10-12): a replacement preview built
            // on a stale head is NOT applied — the loop-side tool check
            // normally catches this first; this is the authoritative
            // catch for mid-turn head movement. The rejection is noted
            // for her next turn's state.
            const baseVersion = typeof args["baseVersion"] === "number" ? args["baseVersion"] : undefined
            const staleBase =
              existing !== undefined &&
              baseVersion !== undefined &&
              baseVersion !== (existing.history ?? []).length
            if (staleBase && existing !== undefined) {
              console.warn(`[diag] StreamSettled: drawer.preview REJECTED stale base id=${id} base=${baseVersion} head=${(existing.history ?? []).length}`)
              settledNotes.push(
                `Your full-document preview for "${existing.title}" (${id}) was NOT shown: it was based on version ${baseVersion}, but the current version is ${(existing.history ?? []).length} — the document changed (a restore, or Kimler's direct edit). Nothing was overwritten. The current content is in your state; rebase on it and preview again with baseVersion ${(existing.history ?? []).length}, or use a patch edit instead.`
              )
            } else {
            const spaces = existing
              ? base.spaces.map((s) => s.id === id
                  ? {
                      ...s,
                      title,
                      content,
                      ...(path !== undefined ? { path } : {}),
                      history: pushVersion(s, title, content, at, "Updated"),
                    }
                  : s)
              : [
                  ...base.spaces,
                  {
                    id,
                    title,
                    kind: "preview" as const,
                    content,
                    ...(path !== undefined ? { path, savedContent: content, savedAt: at } : {}),
                    history: [{ title, content, at, label: "Opened" }],
                  },
                ]
            // Reset height ratios when space count changes (2026-10-12).
            // Otherwise preserve existing ratios.
            const oldCount = base.spaces.length
            const newCount = spaces.length
            const heightRatios = oldCount !== newCount
              ? {} // Reset to equal split
              : (base.heightRatios ?? {})
            drawerUpdate = { ...base, open: true, spaces, activeSpaceId: id, heightRatios }
            }
          }
          if (tc.tool === "drawer.reorder") {
            const args = tc.args as Record<string, unknown>
            const order = Array.isArray(args["order"])
              ? (args["order"] as unknown[]).filter((x): x is string => typeof x === "string")
              : []
            const base = drawerUpdate ?? model.session.drawer
            if (base && order.length > 0) {
              const byId = new Map(base.spaces.map((s) => [s.id, s]))
              const reordered = order.map((oid) => byId.get(oid)).filter((s) => s !== undefined)
              // Append any spaces not mentioned in the order (keep them, at the end).
              const mentioned = new Set(order)
              const rest = base.spaces.filter((s) => !mentioned.has(s.id))
              const spaces = [...reordered, ...rest]
              console.warn(`[diag] StreamSettled: drawer.reorder -> [${spaces.map((s) => s.id).join(",")}]`)
              drawerUpdate = { ...base, spaces }
            }
          }
          if (tc.tool === "drawer.close") {
            const args = tc.args as Record<string, unknown>
            const id = typeof args["id"] === "string" ? args["id"] : null
            const base = drawerUpdate ?? model.session.drawer
            if (base && id !== null) {
              const spaces = base.spaces.filter((s) => s.id !== id)
              console.warn(`[diag] StreamSettled: drawer.close id=${id} remaining=${spaces.length}`)
              drawerUpdate = {
                ...base,
                spaces,
                open: spaces.length > 0 ? base.open : false,
                activeSpaceId: base.activeSpaceId === id ? (spaces[0]?.id ?? null) : base.activeSpaceId,
                // Space count changed — reset height ratios to equal split.
                heightRatios: {},
              }
            }
          }
          if (tc.tool === "drawer.edit") {
            // Patch edit (2026-10-12): apply oldText->newText to the LIVE
            // space content. The loop-side tool already validated the
            // patch against the turn-start head; the live head may have
            // moved mid-turn (his direct edit), in which case the patch
            // does not land and she is told via pendingNotes. The patch
            // applies exactly once: the loop's per-turn text is settled
            // once, and a second identical patch would find oldText gone
            // (occurrence count 0 -> rejection note, never corruption).
            const args = tc.args as Record<string, unknown>
            const id = typeof args["id"] === "string" ? args["id"] : null
            const oldText = typeof args["oldText"] === "string" ? args["oldText"] : null
            const newText = typeof args["newText"] === "string" ? args["newText"] : null
            const newTitle = typeof args["newTitle"] === "string" ? args["newTitle"] : undefined
            const base = drawerUpdate ?? model.session.drawer
            if (base && id !== null && oldText !== null && oldText !== "" && newText !== null) {
              const space = base.spaces.find((s) => s.id === id)
              if (space !== undefined) {
                const occurrences = space.content.split(oldText).length - 1
                if (occurrences === 1) {
                  // Function replacer: newText is literal (no $ patterns).
                  const content = space.content.replace(oldText, () => newText)
                  const title = newTitle ?? space.title
                  const spaces = base.spaces.map((s) =>
                    s.id === id
                      ? { ...s, title, content, saveError: undefined, history: pushVersion(s, title, content, at, "Edited") }
                      : s
                  )
                  console.warn(`[diag] StreamSettled: drawer.edit APPLIED id=${id} head v${(space.history ?? []).length} chars ${space.content.length}->${content.length}`)
                  drawerUpdate = { ...base, spaces }
                } else {
                  console.warn(`[diag] StreamSettled: drawer.edit REJECTED id=${id} occurrences=${occurrences}`)
                  // Enriched rejection (2026-10-12, design §3.3): a bare
                  // count invites invented theories ("the space dropped").
                  // Give her the live head's facts so the miss is
                  // diagnosable: version/chars/first line for 0 matches,
                  // occurrence line numbers for ambiguous matches.
                  if (occurrences === 0) {
                    const firstLine = space.content.split("\n").find((l) => l.trim() !== "")?.trim().slice(0, 120) ?? ""
                    settledNotes.push(
                      `Your patch edit on "${space.title}" (${id}) did NOT land: the text to replace was NOT FOUND in the live version. The space is open and current — head is v${(space.history ?? []).length}, ${space.content.length} chars, first line: ${JSON.stringify(firstLine)}. You composed the patch against a different copy. The current content is in your state (UISTATE / drawer.getState) — rebuild the edit from THAT text.`
                    )
                  } else {
                    const lines: Array<number> = []
                    let at = space.content.indexOf(oldText)
                    while (at !== -1 && lines.length < 8) {
                      lines.push(space.content.slice(0, at).split("\n").length)
                      at = space.content.indexOf(oldText, at + 1)
                    }
                    settledNotes.push(
                      `Your patch edit on "${space.title}" (${id}) did NOT land: the text to replace matched ${occurrences} places (lines ${lines.join(", ")}) in the live v${(space.history ?? []).length}. Extend the match text with surrounding context so it identifies exactly one place.`
                    )
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[diag] StreamSettled: drawer parse failed: ${e}`)
      }
      // JSON validation for spaces whose content changed this settle
      // (2026-10-12): failures/recoveries join the settled notes, and
      // the issue record lands on the committed drawer. Mermaid is
      // validated by the renderer (DrawerValidationReported).
      if (drawerUpdate !== undefined) {
        const before = new Map(model.session.drawer.spaces.map((s) => [s.id, s.content]))
        let issues = drawerUpdate.validationIssues
        const validationNotes: Array<string> = []
        for (const s of drawerUpdate.spaces) {
          if (before.get(s.id) !== s.content) {
            const r = validateSpaceJson(issues, s)
            issues = r.issues
            validationNotes.push(...r.notes)
          }
        }
        if (validationNotes.length > 0) {
          console.warn(`[diag] validate: settle json notes=${validationNotes.length} spaces=${drawerUpdate.spaces.length}`)
          drawerUpdate = { ...drawerUpdate, validationIssues: issues }
          settledNotes.push(...validationNotes)
        }
      }
      // Deliver this turn's rejection notes (2026-10-12): fold them into
      // pendingNotes on the drawer state being committed, so her next
      // turn's state marker carries them even when nothing else changed.
      if (settledNotes.length > 0) {
        const baseDrawer = drawerUpdate ?? model.session.drawer
        if (baseDrawer !== undefined) {
          drawerUpdate = {
            ...baseDrawer,
            pendingNotes: [...(baseDrawer.pendingNotes ?? []), ...settledNotes],
          }
        }
      }
      // Emotion tags to emoji (2026-10-10): [happy] -> 😊 for display.
      // Tags are stripped for TTS (voice carries the emotion via exaggeration).
      const EMOTION_EMOJI: Record<string, string> = {
        happy: "😊", sad: "😢", surprised: "😮", angry: "😠",
        whispering: "🤫", laughing: "😂", laugh: "😂", chuckle: "😄", giggle: "😂",
        thinking: "🤔", confused: "😕", excited: "🤩", nervous: "😬",
        shy: "🫣", playful: "😏", sarcastic: "🙄", tired: "😮‍💨",
        curious: "🧐", determined: "😤", sigh: "😮‍💨", gasp: "😲",
        dramatic: "🎭",
      }
      const toDisplay = (t: string): string =>
        t.replace(/\[(\w+)\]/g, (m, tag) => EMOTION_EMOJI[tag.toLowerCase()] ?? m)
      // Use unique IDs to avoid DOM key collisions (2026-10-10 crash fix).
      // Always suffix with block index, even for single blocks.
      // Filter empty blocks (2026-10-11): voice-only turns (narrate with no
      // chat text) should not render empty bubbles.
      const nonEmptyBlocks = blocks.filter((b) => b.trim().length > 0)
      const blockMessages = nonEmptyBlocks.map((blockText, i) => ({
        id: `${streamId}-b${i}`,
        role: "assistant" as const,
        text: toDisplay(blockText),
        at: at + i, // preserve order; millisecond offsets keep sort stable
        ...(toolsUsed.length > 0 && i === nonEmptyBlocks.length - 1 ? { toolsUsed } : {}),
        // Spoken texts for the narrate hover tooltip (2026-10-11 debug aid).
        ...(narratedTexts.length > 0 && i === nonEmptyBlocks.length - 1 ? { narratedTexts } : {}),
        // Human-readable tool summaries for hover introspection (2026-10-11).
        ...(toolSummaries.length > 0 && i === nonEmptyBlocks.length - 1 ? { toolSummaries } : {}),
        // Per-call outcomes (2026-10-12): tag tints + conclusion tooltips.
        ...(toolOutcomes.length > 0 && i === nonEmptyBlocks.length - 1 ? { toolOutcomes } : {}),
      }))
      // Voice: narrate-only (2026-10-11). Auto-speech disabled; the `narrate`
      // tool is the sole voice channel. Chat blocks are visual-only.
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [...model.session.messages, ...blockMessages],
            streaming: { active: false, streamId: "", text: "", startedAt: 0 },
            // Drawer from text-parsed preview (2026-10-12): if drawerUpdate was set above,
            // include it; otherwise keep existing drawer state.
            ...(drawerUpdate !== undefined ? { drawer: drawerUpdate } : {}),
            // Auto-scroll to newest: set anchor to end so the virtualized list
            // renders the latest bubbles (2026-10-10: fixes glitching when
            // multi-block messages arrive). The OnScroll handler will update
            // the anchor if the user scrolls up manually.
            listWindow: {
              ...model.session.listWindow,
              anchorIndex: model.session.messages.length + blockMessages.length - 1,
            },
            contextMeter:
              usage === undefined
                ? model.session.contextMeter
                : {
                    ...model.session.contextMeter,
                    inputTokens: historyTokens,
                    outputTokens: usage.outputTokens,
                    reasoningTokens: usage.reasoningTokens,
                  },
          },
        },
        commands: [
          // Persist each block; correlate to the parent stream.
          ...blockMessages.map((m, i) =>
            PersistMemory({
              correlationId: `${m.id}:assistant`,
              sessionId,
              role: "assistant",
              text: m.text,
            })
          ),
          // Voice: narrate-only (2026-10-11).
          // Auto-speech permanently disabled — the `narrate` tool is the sole
          // voice channel. The model speaks via narrate (interaction); chat
          // blocks are visual-only (information). No auto-SpeakText dispatch.
          // TEMP DISABLED 2026-10-10: FocusComposer/ScrollToBottom/RenderMermaid
          // crash with "Schema validation failed". The command definitions
          // need rework — doing DOM ops via commands isn't the right pattern.
          // FocusComposer(),
          // ScrollToBottom(),
          // RenderMermaid() — crashes with Schema validation failed (2026-10-10 21:31).
          // Needs rework: mermaid rendering should happen in the view layer,
          // not via a command. Disabled until then.
        ],
      }
    },

    StreamFailed: ({ streamId, reason }) => {
      if (!streamingActive(model, streamId)) return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: [
              ...model.session.messages,
              {
                id: `${streamId}-error`,
                role: "assistant",
                text: `turn failed: ${reason}`,
                at: model.session.streaming.startedAt,
              },
            ],
            streaming: { active: false, streamId: "", text: "", startedAt: 0 },
          },
        },
      }
    },

    SessionBranched: ({ fromId: _fromId, newSessionId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sessionId: newSessionId,
          branchId: newSessionId,
        },
      },
    }),

    VoiceToggled: ({ enabled }) => {
      const engineState = model.session.ttsEngine.state
      const needsPanel = enabled && (engineState === "unknown" || engineState === "missing")
      try {
        localStorage.setItem("aimy.voiceEnabled", enabled ? "1" : "0")
      } catch { /* private mode */ }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            voiceEnabled: enabled,
            // First enable with no engine: open the panel so the user can
            // install it — the toggle alone can't produce speech.
            voicePanelOpen: needsPanel ? true : model.session.voicePanelOpen,
            voiceError: undefined,
          },
        },
        ...(needsPanel ? { commands: [FetchEngineStatus({})] } : {}),
      }
    },

    ChannelsReceived: ({ streamId, audioBase64, audioUnavailableReason, expressions }) => ({
      // The audio plays in the voice subscription (a side effect); the model
      // holds the payload transiently until playback starts or is skipped.
      model: {
        ...model,
        session: {
          ...model.session,
          pendingChannels: { streamId, audioBase64, audioUnavailableReason, expressions: [...expressions] },
        },
      },
    }),

    SpeechStarted: ({ streamId }) => ({
      model: {
        ...model,
        session: { ...model.session, speakingStreamId: streamId },
      },
    }),

    SpeechEnded: ({ streamId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          speakingStreamId:
            model.session.speakingStreamId === streamId ? undefined : model.session.speakingStreamId,
        },
      },
    }),

    MicPreRollChanged: ({ status }) => ({
      model: {
        ...model,
        session: { ...model.session, micPreRoll: status },
      },
    }),

    ChannelsConsumed: ({ streamId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          pendingChannels:
            model.session.pendingChannels?.streamId === streamId
              ? undefined
              : model.session.pendingChannels,
        },
      },
    }),

    AudioChunkReceived: ({ streamId, sequence, audioBase64 }) => ({
      // NOTE (2026-10-11): a streamId-based stale filter was tried here but
      // the main process broadcasts all chunks with streamId "narration"
      // (handlers.ts), so it dropped every chunk mid-turn. Stale audio after
      // an interrupt is handled by the pendingAudioChunks clear on
      // UserSentMessage + stopAllAudio() in the renderer's audio pump.
      model: {
        ...model,
        session: {
          ...model.session,
          pendingAudioChunks: [
            ...model.session.pendingAudioChunks,
            { streamId, sequence, audioBase64 },
          ],
        },
      },
    }),

    AudioDrainedReceived: ({ streamId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          audioDrainedStreamIds: model.session.audioDrainedStreamIds.includes(streamId)
            ? model.session.audioDrainedStreamIds
            : [...model.session.audioDrainedStreamIds, streamId],
        },
      },
    }),

    AudioChunksConsumed: ({ streamId, sequences }) => {
      const seqSet = new Set(sequences)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            pendingAudioChunks: model.session.pendingAudioChunks.filter(
              (c) => !(c.streamId === streamId && seqSet.has(c.sequence))
            ),
          },
        },
      }
    },

    TtsSpoken: () => ({ model }),

    /* -- voice panel -------------------------------------------- */

    VoicePanelToggled: ({ open }) => {
      const engineReady = model.session.ttsEngine.state === "ready"
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            voicePanelOpen: open,
            voiceError: undefined,
            // Auto-test provider health on open (if engine ready).
            ...(open && engineReady ? { providerTestRunning: true } : {}),
          },
        },
        ...(open
          ? {
              commands: [
                FetchEngineStatus({}),
                // Auto-run provider health check when panel opens.
                ...(engineReady ? [RunProviderTest({})] : []),
              ],
            }
          : {}),
      }
    },

    TtsInstallRequested: () => ({
      model,
      commands: [InstallEngine({})],
    }),

    VoicesRefreshRequested: () => ({
      model,
      commands: [FetchVoices({})],
    }),

    VoiceSelectRequested: ({ voiceId }) => ({
      model,
      commands: [SelectVoice({ voiceId })],
    }),

    VoiceFilePickRequested: () => ({
      model,
      commands: [PickVoiceFile({})],
    }),

    VoiceNameChanged: ({ name }) => ({
      model: {
        ...model,
        session: { ...model.session, pendingVoiceName: name },
      },
    }),

    VoiceDeleteRequested: ({ voiceId }) => ({
      model: {
        ...model,
        session: { ...model.session, pendingDeleteVoiceId: voiceId },
      },
    }),

    VoiceDeleteConfirmed: () => {
      const voiceId = model.session.pendingDeleteVoiceId
      if (voiceId === undefined) return { model }
      return {
        model: {
          ...model,
          session: { ...model.session, pendingDeleteVoiceId: undefined },
        },
        commands: [DeleteVoice({ voiceId })],
      }
    },

    VoiceDeleteCancelled: () => ({
      model: {
        ...model,
        session: { ...model.session, pendingDeleteVoiceId: undefined },
      },
    }),

    VoiceSampleRequested: ({ voiceId }) => ({
      model,
      commands: [PlayVoiceSample({ voiceId })],
    }),

    TtsEngineStatusReceived: ({ state, detail }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          ttsEngine: {
            state,
            ...(detail !== undefined ? { detail } : {}),
          },
          voiceError: undefined,
        },
      },
      ...(state === "ready" ? { commands: [FetchVoices({})] } : {}),
    }),

    TtsEngineStatusFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          ttsEngine: { state: "failed", detail: reason },
        },
      },
    }),

    TtsInstallStarted: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          ttsEngine: { state: "installing", progressMessage: "Starting…" },
          voiceError: undefined,
        },
      },
    }),

    TtsInstallFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          ttsEngine: { state: "failed", detail: reason },
        },
      },
    }),

    TtsInstallProgressReceived: ({ phase, message }) => {
      const done = phase === "done"
      const failed = phase === "error"
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            ttsEngine: done
              ? { state: "ready" }
              : failed
                ? { state: "failed", detail: message }
                : {
                    state: "installing",
                    progressPhase: phase,
                    progressMessage: message,
                  },
            voiceError: undefined,
          },
        },
        ...(done ? { commands: [FetchVoices({})] } : {}),
      }
    },

    VoicesReceived: ({ voices }) => {
      const list = [...voices]
      const current = model.session.activeVoiceId
      const stillThere = current !== undefined && list.some((v) => v.id === current)
      const def = list.find((v) => v.isDefault)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            voices: list,
            activeVoiceId: stillThere ? current : def?.id,
            voiceError: undefined,
          },
        },
      }
    },

    VoicesFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    VoiceSelected: ({ voiceId }) => ({
      model: {
        ...model,
        session: { ...model.session, activeVoiceId: voiceId, voiceError: undefined },
      },
    }),

    VoiceSelectFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    VoiceDeleted: ({ voiceId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voices: model.session.voices.filter((v) => v.id !== voiceId),
          activeVoiceId: model.session.activeVoiceId === voiceId ? undefined : model.session.activeVoiceId,
          // Don't clear voiceError here — let the user dismiss it explicitly.
        },
      },
    }),

    VoiceDeleteFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    VoiceSamplePlayed: () => ({
      model: {
        ...model,
        session: { ...model.session, playingSampleVoiceId: undefined },
      },
    }),

    VoiceSampleFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason, playingSampleVoiceId: undefined },
      },
    }),

    VoiceErrorDismissed: () => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: undefined },
      },
    }),

    VoiceSetDefaultRequested: ({ voiceId }) => ({
      model,
      commands: [SetVoiceDefault({ voiceId })],
    }),

    VoiceDefaultSet: ({ voiceId }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voices: model.session.voices.map((v) => ({
            ...v,
            isDefault: v.id === voiceId,
          })),
          voiceError: undefined,
        },
      },
    }),

    VoiceDefaultSetFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    SttSetupOpened: () => ({
      model: {
        ...model,
        session: { ...model.session, sttSetupOpen: true },
      },
    }),

    SttEngineStatusReceived: ({ state, engine, detail }) => {
      const validStates = ["unknown", "missing", "installing", "ready", "failed"] as const
      const safeState = (validStates as readonly string[]).includes(state)
        ? state as typeof validStates[number]
        : "unknown" as const
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            sttEngine: {
              state: safeState,
              ...(engine !== undefined ? { engine } : {}),
              ...(detail !== undefined ? { detail } : {}),
            },
          },
        },
      }
    },

    SttSetupClosed: () => ({
      model: {
        ...model,
        session: { ...model.session, sttSetupOpen: false },
      },
    }),

    SttModelSizeChanged: ({ engine, size }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttModelSizes: { ...model.session.sttModelSizes, [engine]: size },
        },
      },
    }),

    SttInstallRequested: ({ engine }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttEngine: { state: "installing", progressMessage: "Starting…", engine },
        },
      },
      commands: [InstallSttEngine({ engine })],
    }),

    SttInstallProgressReceived: ({ message }) => {
      // "done" phase means the install completed — mark ready and close the dialog.
      const done = message.toLowerCase().includes("installed") || message === "STT engine installed."
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            sttEngine: done
              ? { state: "ready", engine: model.session.sttEngine.engine }
              : { state: "installing", progressMessage: message, engine: model.session.sttEngine.engine },
            sttSetupOpen: done ? false : model.session.sttSetupOpen,
          },
        },
      }
    },

    SttTestRequested: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttTestRunning: true,
        },
      },
      commands: [TestSttEngine({})],
    }),
    SttTestCompleted: ({ latencyMs, modelSizeMb }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttTestRunning: false,
          sttTestResults: { latencyMs, modelSizeMb },
        },
      },
    }),
    SttTestFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          sttTestRunning: false,
          voiceError: `STT test failed: ${reason}`,
        },
      },
    }),
    MicRecordToggled: () => {
      // Toggle recording. The actual MediaRecorder lives in the renderer;
      // this flips the intent, and the renderer reports back via
      // MicRecordingStarted / MicRecordingStopped / MicFailed.
      const starting = !model.session.micRecording
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            micRecording: starting,
            ...(starting ? {} : { micTranscribing: true }),
          },
        },
        commands: starting ? [MicStartRecording({})] : [MicStopRecording({})],
      }
    },
    MicRecordingStarted: () => ({
      model: {
        ...model,
        session: { ...model.session, micRecording: true },
      },
    }),
    MicRecordingStopped: ({ audioBase64 }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          micRecording: false,
          micTranscribing: true,
        },
      },
      commands: [TranscribeMicAudio({ audioBase64 })],
    }),
    MicTranscribed: ({ text }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          micTranscribing: false,
          composer: { draft: model.session.composer.draft + text, attachments: model.session.composer.attachments },
          // Mark draft as voice-originated: enables click-to-send /
          // right-click-to-discard. Cleared on manual edit or send.
          voiceDraft: true,
        },
      },
    }),
    /** User confirmed the voice draft (click-to-send). */
    VoiceDraftSent: () => ({
      model: {
        ...model,
        session: { ...model.session, voiceDraft: false },
      },
    }),
    /** User discarded the voice draft (right-click). */
    VoiceDraftDiscarded: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voiceDraft: false,
          composer: { draft: "", attachments: [] },
        },
      },
    }),
    /** Global click confirmed voice draft — send current draft as message. */
    // Edit-and-resend (2026-10-13): the fork exists. Truncate
    // the visible thread at the edited message, adopt the new
    // session, and replay the stashed send through the normal
    // send path (recursion into update keeps ONE landing).
    EditBranchReady: ({ newSessionId }) => {
      const stash = model.session.pendingEditSend
      console.warn(`[diag] update: EditBranchReady newSession=${newSessionId} stash=${stash !== undefined}`)
      if (stash === undefined) {
        return {
          model: {
            ...model,
            session: { ...model.session, sessionId: newSessionId, branchId: newSessionId },
          },
        }
      }
      const idx = model.session.messages.findIndex((m) => m.id === stash.fromId)
      const branched: Model = {
        ...model,
        session: {
          ...model.session,
          sessionId: newSessionId,
          branchId: newSessionId,
          messages: idx >= 0 ? model.session.messages.slice(0, idx) : model.session.messages,
          pendingEditSend: undefined,
        },
      }
      return update(
        branched,
        Message.UserSentMessage({
          id: stash.id,
          text: stash.text,
          at: stash.at,
          ...(stash.images !== undefined ? { images: [...stash.images] } : {}),
          ...(stash.documents !== undefined ? { documents: [...stash.documents] } : {}),
        })
      )
    },

    // The fork failed: his edited text goes back to the
    // composer (never silently lost) and the failure is a
    // visible message in the thread.
    EditBranchFailed: ({ reason }) => {
      const stash = model.session.pendingEditSend
      console.warn(`[diag] update: EditBranchFailed reason=${reason} stash=${stash !== undefined}`)
      if (stash === undefined) return { model }
      try {
        localStorage.setItem("aimy.composerDraft", stash.text)
      } catch { /* storage unavailable */ }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            pendingEditSend: undefined,
            composer: { draft: stash.text, attachments: model.session.composer.attachments },
            messages: [
              ...model.session.messages,
              {
                id: `${stash.id}-branch-failed`,
                role: "assistant" as const,
                text: `edit-and-resend failed: ${reason}`,
                at: Date.now(),
              },
            ],
          },
        },
      }
    },

    VoiceDraftConfirmed: () => {
      const draft = model.session.composer.draft
      if (draft.trim().length === 0) {
        return { model }
      }
      // The draft is sent — its persisted copy goes too (2026-10-13).
      try {
        localStorage.removeItem("aimy.composerDraft")
      } catch { /* storage unavailable */ }
      const id = `msg-${Date.now()}`
      const sessionId = model.session.sessionId
      // Same barge-in semantics as UserSentMessage (2026-10-11).
      const interrupted =
        model.session.streaming.active || model.session.speakingStreamId !== undefined
      // Voice sends are user turns too: attach the same [AIMY-UISTATE]
      // snapshot as typed sends. This path previously sent the raw draft,
      // so a document opened in the drawer was invisible to AImy and she
      // reported the drawer as empty (field failure 2026-10-12 17:02).
      const input = uiStateMarker(model) + draft
      // Staged documents ride a voice send too (2026-10-13): the
      // composer is rebuilt empty below, so leaving them behind
      // would drop his files silently. (Staged images do not ride
      // voice sends — pre-existing behavior, unchanged.)
      const voiceDocuments = model.session.composer.documents ?? []
      const newMessages = [
        ...model.session.messages,
        { id, role: "user" as const, text: draft, at: Date.now(), ...(voiceDocuments.length > 0 ? { documents: voiceDocuments } : {}) },
      ]
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            messages: newMessages,
            // Pin the window to the newest message (2026-10-11: VoiceDraftConfirmed
            // was missing this, causing the user bubble to fall outside the
            // visible window and appear to "vanish" while responses merged).
            listWindow: { ...model.session.listWindow, anchorIndex: newMessages.length - 1 },
            composer: { draft: "", attachments: [] },
            promptHistory: appendedPromptHistory(model.session.promptHistory, draft),
            // A voice send abandons any loaded edit-and-resend
            // (2026-10-13): the branch detour is a typed-send
            // path; leaving the flag set would fork a later,
            // unrelated send.
            pendingEditFromId: undefined,
            voiceDraft: false,
            speakingStreamId: undefined,
            pendingAudioChunks: [],
            // The marker above delivered any pending UI change notes;
            // clear them so they are told exactly once, as typed sends do.
            drawer: { ...model.session.drawer, pendingNotes: [] },
          },
        },
        commands: [
          StopNarration(),
          SendToInference({ correlationId: id, sessionId, input, voiceEnabled: model.session.voiceEnabled, viaVoice: false, interrupted, images: [] }),
          PersistMemory({ correlationId: `${id}:user`, sessionId, role: "user", text: draft }),
        ],
      }
    },
    /* ── Provider registry ─────────────────────────────────────────── */
    ProvidersLoaded: ({ registry }) => {
      // Validate and merge the loaded registry.
      const r = registry as {
        providers?: Array<{
          id: string
          name: string
          category: "llm" | "vision" | "tts" | "stt" | "image"
          kind: "local" | "remote"
          enabled: boolean
          engine?: string
          endpoint?: string
          config?: Record<string, string>
          stats?: { latencyMs?: number; throughput?: number; modelSizeMb?: number; lastTestedAt?: number; testCount: number }
        }>
        activeId?: Record<string, string | undefined>
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            providers: {
              providers: (r.providers ?? []).map((p) => ({
                ...p,
                config: p.config ?? {},
                stats: p.stats ?? { testCount: 0 },
              })),
              activeId: r.activeId ?? {},
            },
          },
        },
      }
    },
    ProvidersOpened: () => ({
      model: {
        ...model,
        session: { ...model.session, providersOpen: true },
      },
    }),
    ProvidersClosed: () => ({
      model: {
        ...model,
        session: { ...model.session, providersOpen: false },
      },
    }),
    ProviderTabChanged: ({ tab }) => ({
      model: {
        ...model,
        session: { ...model.session, providerTab: tab },
      },
    }),
    ProviderAdded: ({ name, category, kind, engine, endpoint }) => {
      const id = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newProvider = {
        id,
        name,
        category: category as "llm" | "vision" | "tts" | "stt" | "image",
        kind: kind as "local" | "remote",
        enabled: true,
        ...(engine !== undefined ? { engine } : {}),
        ...(endpoint !== undefined ? { endpoint } : {}),
        config: {},
        stats: { testCount: 0 },
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            providers: {
              ...model.session.providers,
              providers: [...model.session.providers.providers, newProvider],
            },
          },
        },
      }
    },
    ProviderUpdated: ({ id, name, endpoint, engine, config }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id
                ? {
                    ...p,
                    name,
                    ...(endpoint !== undefined ? { endpoint } : {}),
                    ...(engine !== undefined ? { engine } : {}),
                    config,
                  }
                : p
            ),
          },
          // Close the edit form after saving.
          editingProviderId: undefined,
        },
      },
    }),
    ProviderDeleted: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            providers: model.session.providers.providers.filter((p) => p.id !== id),
            activeId: Object.fromEntries(
              Object.entries(model.session.providers.activeId).map(([cat, active]) => [
                cat,
                active === id ? undefined : active,
              ])
            ) as Record<string, string | undefined>,
          },
          // Close the edit form if we deleted the provider being edited.
          editingProviderId: model.session.editingProviderId === id ? undefined : model.session.editingProviderId,
        },
      },
    }),
    ProviderEditOpened: ({ id }) => {
      const p = model.session.providers.providers.find((x) => x.id === id)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            editingProviderId: id,
            editingDraft: {
              name: p?.name ?? "",
              endpoint: p?.endpoint ?? "",
              engine: p?.engine ?? "",
            },
          },
        },
      }
    },
    ProviderEditClosed: () => ({
      model: {
        ...model,
        session: { ...model.session, editingProviderId: undefined },
      },
    }),
    ProviderEditDraftChanged: ({ field, value }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          editingDraft: { ...model.session.editingDraft, [field]: value },
        },
      },
    }),
    ProviderAddOpened: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          addingProvider: true,
          addDraft: { name: "", kind: "local", engine: "", host: "", port: "" },
        },
      },
    }),
    ProviderAddClosed: () => ({
      model: {
        ...model,
        session: { ...model.session, addingProvider: false },
      },
    }),
    ProviderAddDraftChanged: ({ field, value }) => {
      const draft = model.session.addDraft
      // Auto-populate name from engine if name is empty.
      const autoName =
        field === "engine" && !draft.name.trim() ? value : draft.name
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            addDraft: {
              ...draft,
              [field]: value,
              ...(field === "engine" && !draft.name.trim() ? { name: value } : {}),
            },
          },
        },
      }
    },
    ProviderCreateFromDraft: ({ category }) => {
      const d = model.session.addDraft
      const id = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const isRemote = d.kind === "remote"
      const endpoint = isRemote && d.host ? `http://${d.host}${d.port ? `:${d.port}` : ""}` : undefined
      const newProvider = {
        id,
        name: d.name || `New ${category.toUpperCase()} provider`,
        category: category as "llm" | "vision" | "tts" | "stt" | "image",
        kind: d.kind as "local" | "remote",
        enabled: true,
        engine: !isRemote && d.engine ? d.engine : undefined,
        endpoint,
        config: {},
        stats: { testCount: 0 },
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            providers: {
              ...model.session.providers,
              providers: [...model.session.providers.providers, newProvider],
            },
            addingProvider: false,
          },
        },
      }
    },
    ProviderToggled: ({ id, enabled }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id ? { ...p, enabled } : p
            ),
          },
        },
      },
    }),
    ProviderSetActive: ({ category, id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            activeId: {
              ...model.session.providers.activeId,
              [category]: id,
            },
          },
        },
      },
    }),
    ProviderBenchmarkRequested: ({ id }) => ({
      model,
      // TODO: dispatch benchmark command via IPC
    }),
    ProviderConnectionTestRequested: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerTestResults: {
            ...model.session.providerTestResults,
            [id]: "testing...",
          },
        },
      },
    }),
    ProviderConnectionTestCompleted: ({ id, detail }) => {
      // If this is a remote LLM/vision provider, auto-request the model list.
      const provider = model.session.providers.providers.find((p) => p.id === id)
      const shouldFetchModels =
        provider?.kind === "remote" &&
        (provider.category === "llm" || provider.category === "vision") &&
        provider.endpoint
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            providerTestResults: {
              ...model.session.providerTestResults,
              [id]: `OK: ${detail}`,
            },
            // Trigger model fetch by setting empty array.
            ...(shouldFetchModels
              ? {
                  providerModels: {
                    ...model.session.providerModels,
                    [id]: [],
                  },
                }
              : {}),
          },
        },
      }
    },
    ProviderConnectionTestFailed: ({ id, reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerTestResults: {
            ...model.session.providerTestResults,
            [id]: `Failed: ${reason}`,
          },
        },
      },
    }),
    ProviderScanRequested: ({ host }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerScanRunning: true,
          providerScanHost: host,
          providerScanResults: [],
          providerScanProgress: { scanned: 0, total: 254 },
          providerScanError: undefined,
        },
      },
    }),
    ProviderScanProgress: ({ scanned, total }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerScanProgress: { scanned, total },
        },
      },
    }),
    ProviderScanCompleted: ({ host, found }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerScanRunning: false,
          providerScanResults: found,
          providerScanProgress: undefined,
        },
      },
    }),
    ProviderScanFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerScanRunning: false,
          providerScanError: reason,
          providerScanProgress: undefined,
        },
      },
    }),
    ProviderScanResultSelected: ({ host, port, service }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          addDraft: {
            ...model.session.addDraft,
            host,
            port: String(port),
            // Auto-name from the detected service.
            name: `${service} (${host}:${port})`,
          },
        },
      },
    }),
    ProviderModelsRequested: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerModels: {
            ...model.session.providerModels,
            [id]: [], // clearing triggers the subscription to fetch
          },
        },
      },
    }),
    ProviderModelsLoaded: ({ id, models }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providerModels: {
            ...model.session.providerModels,
            [id]: [...models],
          },
        },
      },
    }),
    ProviderModelSelected: ({ id, model: selectedModel }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id
                ? { ...p, config: { ...p.config, model: selectedModel } }
                : p
            ),
          },
        },
      },
    }),
    ProviderStreamingToggled: ({ id, streaming }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id
                ? { ...p, config: { ...p.config, streaming: streaming ? "true" : "false" } }
                : p
            ),
          },
        },
      },
    }),
    ProviderBenchmarkCompleted: ({ id, latencyMs, throughput, modelSizeMb }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          providers: {
            ...model.session.providers,
            providers: model.session.providers.providers.map((p) =>
              p.id === id
                ? {
                    ...p,
                    stats: {
                      latencyMs,
                      ...(throughput !== undefined ? { throughput } : {}),
                      ...(modelSizeMb !== undefined ? { modelSizeMb } : {}),
                      lastTestedAt: Date.now(),
                      testCount: p.stats.testCount + 1,
                    },
                  }
                : p
            ),
          },
        },
      },
    }),
    ProviderBenchmarkFailed: ({ id, reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          // TODO: surface error in UI
        },
      },
    }),
    MicFailed: ({ reason }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          micRecording: false,
          micTranscribing: false,
          voiceError: `Microphone: ${reason}`,
        },
      },
    }),
    PushToTalkKeyChanged: ({ key, useMouse }) => {
      try {
        localStorage.setItem("aimy.pushToTalkKey", key)
        localStorage.setItem("aimy.pushToTalkUseMouse", useMouse ? "1" : "0")
      } catch { /* ignore */ }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            pushToTalkKey: key,
            pushToTalkUseMouse: useMouse,
          },
        },
      }
    },
    MicDeviceChanged: ({ deviceId }) => {
      try {
        localStorage.setItem("aimy.micDeviceId", deviceId)
      } catch { /* ignore */ }
      return {
        model: {
          ...model,
          session: { ...model.session, micDeviceId: deviceId },
        },
      }
    },
    MicDevicesRequested: () => ({
      model,
      commands: [ListMicDevices({})],
    }),
    MicDevicesReceived: ({ devices }) => ({
      model: {
        ...model,
        session: { ...model.session, micDevices: [...devices] },
      },
    }),
    SttInstallFailed: ({ reason }) => {
      // Ignore the dummy "install started" signal from the fire-and-forget command.
      if (reason === "__install_started__") return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            sttEngine: { state: "failed", detail: reason },
          },
        },
      }
    },

    // Legacy TTS battery messages (UI removed, commands may still dispatch).
    // These are no-ops now that provider testing lives in Settings.
    ProviderTestRequested: () => ({ model }),
    ProviderTestCompleted: () => ({ model }),
    ProviderTestFailed: () => ({ model }),

    VoiceFilePicked: ({ name, audioBase64 }) => {      // Use the pending name if the user typed one, else fall back to filename.
      const finalName = model.session.pendingVoiceName.trim() || name
      return {
        model: {
          ...model,
          session: { ...model.session, pendingVoiceName: "" },
        },
        commands: [AddVoice({ name: finalName, audioBase64 })],
      }
    },

    VoiceFilePickCancelled: () => ({ model }),

    VoiceFilePickFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    VoiceAdded: ({ id, name, isDefault }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          voices: [...model.session.voices, { id, name, isDefault }],
          voiceError: undefined,
        },
      },
      // Select the new clone immediately.
      commands: [SelectVoice({ voiceId: id })],
    }),

    VoiceAddFailed: ({ reason }) => ({
      model: {
        ...model,
        session: { ...model.session, voiceError: reason },
      },
    }),

    ChatListScrolled: ({ scrollTop }) => {
      // Column-reverse layout (2026-10-10): scrollTop=0 is the visual BOTTOM
      // (newest messages). The anchor must count from the end, not the start.
      // Without this inversion, scrolling up renders the wrong window and
      // bubbles vanish (2026-10-11).
      const total = model.session.messages.length
      const fromBottom = Math.floor(scrollTop / ESTIMATED_ROW_PX)
      const anchorIndex = Math.max(0, total - 1 - fromBottom)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            listWindow: {
              ...model.session.listWindow,
              anchorIndex,
            },
          },
        },
      }
    },

    /* -- drawer (Phase I 2026-10-12) -------------------------------- */

    DrawerToggled: ({ open }) => {
      const drawer = model.session.drawer ?? { open: false, spaces: [], activeSpaceId: null, maxSpaces: 3 }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: { ...drawer, open },
          },
        },
        // Opening the drawer refreshes the home panel data (2026-10-12):
        // Continue / Needs you / What she knows read live stores.
        ...(open ? { commands: [LoadHomeData({ correlationId: "drawer-open" })] } : {}),
      }
    },

    HomeDataRefreshRequested: () => {
      // Home-data consumers outside the drawer (the composed Projects
      // destination) load through here: the same LoadHomeData command
      // as drawer-open, with no drawer state touched (2026-10-12).
      console.warn(`[diag] update: HomeDataRefreshRequested`)
      return { model, commands: [LoadHomeData({ correlationId: "panel-refresh" })] }
    },

    DrawerSpaceOpened: ({ id, title, kind, content }) => {
      const drawer = model.session.drawer
      const existing = drawer.spaces.find((s) => s.id === id)
      // Enforce maxSpaces: if at capacity and this is a new space, refuse.
      // Updating an existing space always works.
      if (!existing && drawer.spaces.length >= drawer.maxSpaces) {
        // TODO (Phase I): surface this to AImy via the tool result.
        // For now, silently refuse — the tool result says { opened: false }.
        return { model }
      }
      const spaces = existing
        ? drawer.spaces.map((s) =>
            s.id === id
              ? { ...s, title, kind, content, history: pushVersion(s, title, content, Date.now(), "Updated") }
              : s
          )
        : [
            ...drawer.spaces,
            { id, title, kind, content, history: [{ title, content, at: Date.now(), label: "Opened" }] },
          ]
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              open: true, // Opening a space auto-opens the drawer.
              spaces,
              activeSpaceId: id,
            },
          },
        },
      }
    },

    DrawerSpaceClosed: ({ id }) => {
      const drawer = model.session.drawer
      const spaces = drawer.spaces.filter((s) => s.id !== id)
      const activeSpaceId =
        drawer.activeSpaceId === id
          ? (spaces[0]?.id ?? null)
          : drawer.activeSpaceId
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              // Close the drawer if no spaces remain.
              open: spaces.length > 0 ? drawer.open : false,
              spaces,
              activeSpaceId,
              historyOpenFor: drawer.historyOpenFor === id ? null : drawer.historyOpenFor,
              editingId: drawer.editingId === id ? null : drawer.editingId,
              ...(drawer.editingId === id ? { editDraft: undefined } : {}),
            },
          },
        },
      }
    },

    DrawerSpaceSelected: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          drawer: { ...model.session.drawer, activeSpaceId: id },
        },
      },
    }),

    DrawerSpaceUpdated: ({ id, content }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          drawer: {
            ...model.session.drawer,
            spaces: model.session.drawer.spaces.map((s) =>
              s.id === id
                ? { ...s, content, history: pushVersion(s, s.title, content, Date.now(), "Updated") }
                : s
            ),
          },
        },
      },
    }),

    /* -- drawer save / download / history (2026-10-12) -------------- */

    DrawerSaveRequested: ({ id }) => {
      const drawer = model.session.drawer
      const space = drawer.spaces.find((s) => s.id === id)
      if (space === undefined) return { model }
      const path = space.path ?? defaultDocPath(space)
      // Already in sync with disk: nothing to write.
      if (space.path !== undefined && !spaceDirty(space)) return { model }
      console.warn(`[diag] update: DrawerSaveRequested id=${id} path=${path} chars=${space.content.length}`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              spaces: drawer.spaces.map((s) =>
                s.id === id ? { ...s, saveError: undefined } : s
              ),
            },
          },
        },
        commands: [SaveDocument({ spaceId: id, path, content: space.content })],
      }
    },

    DrawerSpaceSaved: ({ id, path, content }) => {
      console.warn(`[diag] update: DrawerSpaceSaved id=${id} path=${path} chars=${content.length}`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...model.session.drawer,
              spaces: model.session.drawer.spaces.map((s) =>
                s.id === id
                  ? { ...s, path, savedContent: content, savedAt: Date.now(), saveError: undefined }
                  : s
              ),
            },
          },
        },
      }
    },

    DrawerSpaceSaveFailed: ({ id, reason }) => {
      console.warn(`[diag] update: DrawerSpaceSaveFailed id=${id} reason=${reason}`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...model.session.drawer,
              spaces: model.session.drawer.spaces.map((s) =>
                s.id === id ? { ...s, saveError: reason } : s
              ),
            },
          },
        },
      }
    },

    /* -- direct editing (2026-10-12) -------------------------------- */

    DrawerEditStarted: ({ id }) => {
      const drawer = model.session.drawer
      const space = drawer.spaces.find((s) => s.id === id)
      if (space === undefined) return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: { ...drawer, editingId: id, editDraft: space.content, historyOpenFor: null },
          },
        },
      }
    },

    DrawerEditDraftChanged: ({ text }) => {
      const drawer = model.session.drawer
      if (drawer.editingId === null || drawer.editingId === undefined) return { model }
      return {
        model: {
          ...model,
          session: { ...model.session, drawer: { ...drawer, editDraft: text } },
        },
      }
    },

    DrawerEditApplied: ({ id }) => {
      const drawer = model.session.drawer
      if (drawer.editingId !== id) return { model }
      const draft = drawer.editDraft
      const spaces = draft === undefined
        ? drawer.spaces
        : drawer.spaces.map((s) =>
            s.id === id
              ? { ...s, content: draft, history: pushVersion(s, s.title, draft, Date.now(), "Edited") }
              : s
          )
      console.warn(`[diag] update: DrawerEditApplied id=${id} chars=${draft?.length ?? -1}`)
      const editedSpace = spaces.find((s) => s.id === id)
      // JSON validation of his edit (2026-10-12): his hand can break a
      // block too — she hears about it the same way.
      const editValidation = draft !== undefined && editedSpace !== undefined
        ? validateSpaceJson(drawer.validationIssues, editedSpace)
        : null
      const appliedNotes: Array<string> = [...(drawer.pendingNotes ?? [])]
      if (draft !== undefined && editedSpace !== undefined) {
        appliedNotes.push(
          `Kimler edited "${editedSpace.title}" (${id}) directly in the drawer. That edit is the current version (v${(editedSpace.history ?? []).length}) — base any further changes on the current content in your state, not on your last-sent copy.`
        )
      }
      if (editValidation !== null) appliedNotes.push(...editValidation.notes)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              spaces,
              editingId: null,
              editDraft: undefined,
              ...(editValidation !== null ? { validationIssues: editValidation.issues } : {}),
              ...(appliedNotes.length > (drawer.pendingNotes ?? []).length
                ? { pendingNotes: appliedNotes }
                : {}),
            },
          },
        },
      }
    },

    DrawerEditCancelled: ({ id }) => {
      const drawer = model.session.drawer
      if (drawer.editingId !== id) return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: { ...drawer, editingId: null, editDraft: undefined },
          },
        },
      }
    },

    // Validator report from the renderer (2026-10-12): mermaid render
    // success/failure for a drawer space, delivered via the
    // aimy:validation DOM event + subscription. Diffed against the
    // issue record so she hears about a failure once and its recovery
    // once — as change notes in her next turn, never as UI noise.
    DrawerValidationReported: ({ spaceId, lang, ok, error }) => {
      const drawer = model.session.drawer
      const space = drawer.spaces.find((s) => s.id === spaceId)
      const title = space?.title ?? spaceId
      const summary = ok ? null : (error ?? "unknown error").slice(0, 400)
      console.warn(`[diag] validate: space=${spaceId} lang=${lang} ${ok ? "ok" : `error ${JSON.stringify(summary?.slice(0, 120))}`}`)
      const { issues, notes } = diffValidation(drawer.validationIssues, spaceId, title, lang, summary)
      if (notes.length === 0 && (drawer.validationIssues ?? {})[`${spaceId}:${lang}`] === (ok ? undefined : summary)) {
        return { model }
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              validationIssues: issues,
              ...(notes.length > 0
                ? { pendingNotes: [...(drawer.pendingNotes ?? []), ...notes] }
                : {}),
            },
          },
        },
      }
    },

    DrawerHistoryToggled: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          drawer: {
            ...model.session.drawer,
            historyOpenFor: model.session.drawer.historyOpenFor === id ? null : id,
          },
        },
      },
    }),

    DrawerRawToggled: ({ id }) => {
      console.warn(`[diag] update: DrawerRawToggled id=${id}`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...model.session.drawer,
              spaces: model.session.drawer.spaces.map((s) =>
                s.id === id ? { ...s, showRaw: s.showRaw !== true } : s
              ),
            },
          },
        },
      }
    },

    /* -- drawer home panel (2026-10-12) ------------------------------ */

    /* -- HomeDash (2026-10-13) -------------------------------------- */

    HomedashLoaded: ({ widgets }) => {
      console.warn(`[diag] update: HomedashLoaded widgets=${widgets.map((w) => `${w.id}@${w.priority}`).join(",")}`)
      // Voice alerts ride the globenews entries (2026-10-13):
      // mirror them onto the drawer so the desk/feed strip and
      // the live news.voiceAlerts events share one state field.
      const voiceAlerts = widgets.find((w) => w.voiceAlerts !== undefined)?.voiceAlerts
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...model.session.drawer,
              dash: { widgets },
              ...(voiceAlerts !== undefined ? { voiceAlerts } : {}),
            },
          },
        },
      }
    },

    HomedashFailed: ({ reason }) => {
      console.warn(`[diag] update: HomedashFailed ${reason}`)
      return { model }
    },

    HomedashRefreshRequested: () => ({
      model,
      commands: [LoadHomedash({ correlationId: "dash-refresh" })],
    }),

    HomedashSettingChanged: ({ widgetId, key, value }) => ({
      model,
      commands: [
        ApplyHomedashSetting({ correlationId: "dash-setting", widgetId, key, value }),
      ],
    }),

    NewsReadRequested: ({ id }) => ({
      model,
      commands: [MarkNewsRead({ correlationId: "news-read", id })],
    }),

    NewsOpenRequested: ({ id }) => ({
      model,
      commands: [LoadNewsArticle({ correlationId: "news-open", id })],
    }),

    NewsArticleLoaded: ({ id, title, content, url }) => {
      console.warn(`[diag] update: NewsArticleLoaded id=${id} chars=${content.length}`)
      // One space per event (id `news-<eventId>`); re-clicking an
      // updated article refreshes it in place. path carries the
      // source URL, so a space is never mistaken for a local file.
      return { model: openInDrawer(model, { id: `news-${id}`, title, content, path: url }) }
    },

    NewsArticleFailed: ({ id, reason }) => {
      console.warn(`[diag] update: NewsArticleFailed id=${id} reason=${reason}`)
      return { model }
    },

    NewsRefreshRequested: () => ({
      model,
      commands: [RefreshNews({ correlationId: "news-refresh" })],
    }),

    NewsRegionToggled: ({ region }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          drawer: {
            ...model.session.drawer,
            newsRegion:
              region === "global" || region === "national" || region === "local"
                ? region
                : "local",
          },
        },
      },
    }),

    NewsFocusChanged: ({ id, kind }) => {
      const drawer = model.session.drawer
      // A feature ending (empty id) clears only a director
      // feature — never a selection the user made.
      if (id === "" && drawer.newsFocusKind !== "featured") return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              newsFocusId: id,
              newsFocusKind: id === "" ? "" : kind,
            },
          },
        },
      }
    },

    // Voice alerts (2026-10-13, Threat Channel §8): the active
    // set is main-process truth — the announcer publishes it on
    // every change; the strip renders straight from this field.
    VoiceAlertsChanged: ({ alerts }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          drawer: { ...model.session.drawer, voiceAlerts: alerts },
        },
      },
    }),

    VoiceAlertDismissRequested: ({ id }) => ({
      model,
      commands: [DismissVoiceAlert({ correlationId: "voice-dismiss", id })],
    }),

    HomeDataLoaded: ({ recents, requests, cards, project, projectList, chats, memories, journal, promptHistory }) => {
      console.warn(`[diag] update: HomeDataLoaded recents=${recents.length} requests=${requests.length} cards=${cards.length} project=${project?.id ?? "none"} runs=${project?.runs.length ?? 0} projectList=${projectList.length} chats=${chats.length} memories=${memories.length} prompts=${promptHistory.length}`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            // Global prompt history (2026-10-13): the persisted
            // list is the floor; anything sent this session is
            // already in it (chat.send persists before the turn
            // runs), so replacing is safe.
            promptHistory: [...promptHistory],
            drawer: {
              ...model.session.drawer,
              homeData: { recents, requests, cards, project, projectList, chats, memories, journal },
            },
          },
        },
      }
    },

    HomeDataFailed: ({ reason }) => {
      console.warn(`[diag] update: HomeDataFailed reason=${reason}`)
      return { model }
    },

    HomeRecentClicked: ({ path }) => {
      console.warn(`[diag] update: HomeRecentClicked path=${path}`)
      return { model, commands: [LoadHomeDocument({ path })] }
    },

    HomeDocumentLoaded: ({ path, content }) => {
      console.warn(`[diag] update: HomeDocumentLoaded path=${path} chars=${content.length}`)
      const seed = docSpaceSeed(path, content)
      return { model: openInDrawer(model, { id: seed.id, title: seed.title, content, path }) }
    },

    // Document links (2026-10-13, Kimler's spec): a library
    // link clicked inside a document or a chat message. The
    // load carries the click mode + containing space; placement
    // happens when the content lands (LinkedDocumentLoaded).
    DocLinkClicked: ({ path, mode, spaceId }) => {
      console.warn(`[diag] update: DocLinkClicked path=${path} mode=${mode} space=${spaceId || "chat"}`)
      return { model, commands: [LoadLinkedDocument({ path, mode, spaceId })] }
    },

    LinkedDocumentLoaded: ({ path, content, mode, spaceId }) => {
      console.warn(
        `[diag] update: LinkedDocumentLoaded path=${path} chars=${content.length} mode=${mode} space=${spaceId || "chat"}`
      )
      const seed = docSpaceSeed(path, content)
      const drawer = model.session.drawer
      // Already open anywhere: focus it (content refreshed) —
      // a second space for the same document is never useful,
      // whichever mode the click asked for.
      const alreadyOpen = drawer.spaces.find((s) => s.path === path)
      if (alreadyOpen !== undefined) {
        return { model: openInDrawer(model, { id: seed.id, title: seed.title, content, path }) }
      }
      if (mode === "same" && spaceId !== "") {
        const clicked = drawer.spaces.find((s) => s.id === spaceId)
        const idTaken = drawer.spaces.some((s) => s.id === seed.id && s.id !== spaceId)
        if (clicked !== undefined && !idTaken) {
          // Replace the clicked space's document IN ITS SLOT:
          // same position, the target's own identity — unless
          // the space holds unsaved edits, which are never
          // silently discarded (fall back to a normal open).
          if (!spaceDirty(clicked)) {
            const at = Date.now()
            const replacement: DrawerSpace = {
              id: seed.id,
              title: seed.title,
              kind: "preview",
              content,
              path,
              savedContent: content,
              savedAt: at,
              history: [{ title: seed.title, content, at, label: "Opened" }],
            }
            const spaces = drawer.spaces.map((s) => (s.id === spaceId ? replacement : s))
            console.warn(`[diag] update: doc link replaced space ${spaceId} with ${seed.id}`)
            return {
              model: {
                ...model,
                session: {
                  ...model.session,
                  drawer: { ...drawer, open: true, activeSpaceId: seed.id, spaces },
                },
              },
            }
          }
          console.warn(`[diag] update: doc link kept dirty space ${spaceId}; opening alongside`)
        }
      }
      return { model: openInDrawer(model, { id: seed.id, title: seed.title, content, path }) }
    },

    LinkedDocumentLoadFailed: ({ path, reason }) => {
      console.warn(`[diag] update: LinkedDocumentLoadFailed path=${path} reason=${reason}`)
      return { model }
    },

    HomeDocumentLoadFailed: ({ path, reason }) => {
      console.warn(`[diag] update: HomeDocumentLoadFailed path=${path} reason=${reason}`)
      return { model }
    },

    HomeRequestBuildBriefClicked: ({ capability, at }) => {
      console.warn(`[diag] update: HomeRequestBuildBriefClicked capability=${capability}`)
      return { model, commands: [LoadHomeRequestBrief({ capability, at })] }
    },

    HomeRequestBriefLoaded: ({ capability, why, at }) => {
      const drawer = model.session.drawer
      const brief = capabilityBuildBrief(capability, why, at)
      const now = Date.now()
      console.warn(`[diag] update: HomeRequestBriefLoaded capability=${capability} whyChars=${why.length} briefChars=${brief.content.length} path=${brief.path}`)
      const existing = drawer.spaces.find((s) => s.id === brief.id || s.path === brief.path)
      if (existing !== undefined) {
        const spaces = existing.content === brief.content
          ? drawer.spaces
          : drawer.spaces.map((s) =>
              s.id === existing.id
                ? {
                    ...s,
                    title: brief.title,
                    content: brief.content,
                    path: brief.path,
                    saveError: undefined,
                    history: pushVersion(s, brief.title, brief.content, now, "Build brief"),
                  }
                : s
            )
        return {
          model: {
            ...model,
            session: {
              ...model.session,
              drawer: { ...drawer, open: true, activeSpaceId: existing.id, spaces },
            },
          },
        }
      }
      if (drawer.spaces.length >= drawer.maxSpaces) {
        console.warn(`[diag] update: HomeRequestBriefLoaded refused (maxSpaces) capability=${capability}`)
        return { model }
      }
      const space: DrawerSpace = {
        id: brief.id,
        title: brief.title,
        kind: "preview",
        content: brief.content,
        path: brief.path,
        history: [{ title: brief.title, content: brief.content, at: now, label: "Build brief" }],
      }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              open: true,
              activeSpaceId: brief.id,
              spaces: [...drawer.spaces, space],
              // Space count changed — reset height ratios to equal split.
              heightRatios: {},
            },
          },
        },
      }
    },

    HomeRequestBriefLoadFailed: ({ capability, reason }) => {
      console.warn(`[diag] update: HomeRequestBriefLoadFailed capability=${capability} reason=${reason}`)
      return { model }
    },

    HomeRequestDismissClicked: ({ capability, at }) => {
      console.warn(`[diag] update: HomeRequestDismissClicked capability=${capability}`)
      return { model, commands: [DismissHomeRequest({ capability, at })] }
    },

    HomeRequestDismissed: ({ capability }) => {
      console.warn(`[diag] update: HomeRequestDismissed capability=${capability}`)
      return { model, commands: [LoadHomeData({ correlationId: "dismiss-refresh" })] }
    },

    HomeRequestDismissFailed: ({ reason }) => {
      console.warn(`[diag] update: HomeRequestDismissFailed reason=${reason}`)
      return { model }
    },

    /* -- project UI (2026-10-12): switcher / create / move / add ------ */

    HomeProjectSwitchClicked: ({ id }) => {
      console.warn(`[diag] update: HomeProjectSwitchClicked id=${id}`)
      return { model, commands: [SwitchHomeProject({ id })] }
    },

    HomeProjectNewClicked: () => {
      console.warn(`[diag] update: HomeProjectNewClicked`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: { ...model.session.drawer, projectFormOpen: true, projectDraftName: "", projectDraftPurpose: "" },
          },
        },
      }
    },

    HomeProjectFormCancelled: () => ({
      model: {
        ...model,
        session: {
          ...model.session,
          drawer: { ...model.session.drawer, projectFormOpen: false },
        },
      },
    }),

    HomeProjectDraftNameChanged: ({ value }) => ({
      model: {
        ...model,
        session: { ...model.session, drawer: { ...model.session.drawer, projectDraftName: value } },
      },
    }),

    HomeProjectDraftPurposeChanged: ({ value }) => ({
      model: {
        ...model,
        session: { ...model.session, drawer: { ...model.session.drawer, projectDraftPurpose: value } },
      },
    }),

    HomeProjectCreateSubmitted: () => {
      const drawer = model.session.drawer
      const name = (drawer.projectDraftName ?? "").trim()
      if (name === "") {
        console.warn(`[diag] update: HomeProjectCreateSubmitted ignored (empty name)`)
        return { model }
      }
      const purpose = (drawer.projectDraftPurpose ?? "").trim()
      console.warn(`[diag] update: HomeProjectCreateSubmitted name=${name}`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: { ...drawer, projectFormOpen: false },
          },
        },
        commands: [CreateHomeProject({ name, purpose })],
      }
    },

    HomeProjectActionDone: () => {
      console.warn(`[diag] update: HomeProjectActionDone — refreshing home data`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: { ...model.session.drawer, assetMoveFor: null },
          },
        },
        commands: [LoadHomeData({ correlationId: "project-action" })],
      }
    },

    HomeAssetMoveMenuToggled: ({ key }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          drawer: {
            ...model.session.drawer,
            assetMoveFor: model.session.drawer.assetMoveFor === key ? null : key,
          },
        },
      },
    }),

    HomeAssetMoveTargetClicked: ({ fromId, toId, kind, title, path }) => {
      console.warn(`[diag] update: HomeAssetMoveTargetClicked [${kind}] "${title}" ${fromId} -> ${toId}`)
      return {
        model,
        commands: [MoveHomeAsset({ fromId, toId, kind, title, path: path ?? "" })],
      }
    },

    HomeRecentAddToProjectClicked: ({ path, title }) => {
      const project = model.session.drawer.homeData?.project
      if (project === null || project === undefined) {
        console.warn(`[diag] update: HomeRecentAddToProjectClicked ignored (no active project)`)
        return { model }
      }
      console.warn(`[diag] update: HomeRecentAddToProjectClicked path=${path} project=${project.id}`)
      return { model, commands: [AddHomeRecentToProject({ projectId: project.id, path, title })] }
    },

    DrawerVersionRestored: ({ id, index }) => {
      const drawer = model.session.drawer
      const space = drawer.spaces.find((s) => s.id === id)
      if (space === undefined) return { model }
      const version = (space.history ?? [])[index]
      if (version === undefined) return { model }
      const restored: DrawerSpace = {
        ...space,
        title: version.title,
        content: version.content,
        history: pushVersion(space, version.title, version.content, Date.now(), "Restored"),
        saveError: undefined,
      }
      console.warn(`[diag] update: DrawerVersionRestored id=${id} index=${index} label=${version.label} title=${JSON.stringify(version.title)} path=${space.path ?? "(none)"}`)
      // JSON validation of the restored content (2026-10-12).
      const restoreValidation = validateSpaceJson(drawer.validationIssues, restored)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              spaces: drawer.spaces.map((s) => (s.id === id ? restored : s)),
              historyOpenFor: null,
              validationIssues: restoreValidation.issues,
              // Tell her next turn (2026-10-12): the head was rewound by
              // hand — her copies from before the restore are superseded.
              pendingNotes: [
                ...(drawer.pendingNotes ?? []),
                `Kimler restored "${space.title}" (${id}) from its history to the version from ${new Date(version.at).toLocaleString()} titled "${version.title}". That is the current document now (v${restored.history?.length ?? 0})${space.path !== undefined ? ", and it was written back to disk" : ""}. Any copy you hold from before the restore is SUPERSEDED — work from the current content in your state.`,
                ...restoreValidation.notes,
              ],
            },
          },
        },
        // Kimler's spec: restoring also updates the on-disk file to that
        // version (when the space is bound to a path).
        ...(space.path !== undefined
          ? { commands: [SaveDocument({ spaceId: id, path: space.path, content: version.content })] }
          : {}),
      }
    },

    PermissionRequested: ({ requestId, tool, argsSummary, riskTier, context, at }) => {
      if (model.permissions.pending.some((p) => p.requestId === requestId)) {
        return { model }
      }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            pending: [
              ...model.permissions.pending,
              { requestId, tool, argsSummary, riskTier, context, at },
            ],
          },
        },
      }
    },

    PermissionAutoAllowed: ({ requestId, at }) => {
      if (model.permissions.decisions.some((d) => d.requestId === requestId)) {
        return { model }
      }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            decisions: [
              ...model.permissions.decisions,
              { requestId, decision: "allowed-by-policy", at },
            ],
          },
        },
      }
    },

    PermissionCheckFailed: ({ requestId, denied, reason: _reason, at }) => {
      if (!denied) return { model }
      if (model.permissions.decisions.some((d) => d.requestId === requestId)) {
        return { model }
      }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            decisions: [
              ...model.permissions.decisions,
              { requestId, decision: "denied", at },
            ],
          },
        },
      }
    },

    PermissionGranted: ({ requestId, scope, at }) => {
      const pending = model.permissions.pending.find((p) => p.requestId === requestId)
      if (pending === undefined) return { model }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            pending: model.permissions.pending.filter((p) => p.requestId !== requestId),
            decisions: [
              ...model.permissions.decisions,
              {
                requestId,
                decision: scope === "always" ? "granted-always" : "granted-once",
                at,
              },
            ],
          },
        },
      }
    },

    PermissionDenied: ({ requestId, at }) => {
      // Denial kills the intent (Hermes #65592): the prompt is dropped and the
      // decision is terminal. The kernel's one-shot approve() is never called
      // for this requestId, so the agent loop's execute() fails typed — the
      // loop is structurally barred from re-attempting via another tool.
      const pending = model.permissions.pending.find((p) => p.requestId === requestId)
      if (pending === undefined) return { model }
      return {
        model: {
          ...model,
          permissions: {
            ...model.permissions,
            pending: model.permissions.pending.filter((p) => p.requestId !== requestId),
            decisions: [
              ...model.permissions.decisions,
              { requestId, decision: "denied", at },
            ],
          },
        },
      }
    },

    MemoryPersisted: (_msg) => ({ model }),

    MemoryPersistFailed: (_msg) => ({ model }),

    /* ── Image attachments (2026-10-11: drag-and-drop) ─────────────── */
    ImageDropped: ({ id, dataUrl, name, mimeType }) => {
      // Max 4 images per message.
      const current = model.session.composer.attachments
      if (current.length >= 4) return { model }
      // 10MB total limit (approximate via dataUrl length).
      const totalBytes = current.reduce((n, a) => n + a.dataUrl.length, 0) + dataUrl.length
      if (totalBytes > 10 * 1024 * 1024 * 1.37) return { model } // base64 ~1.37x
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            composer: {
              ...model.session.composer,
              attachments: [...current, { id, dataUrl, name, mimeType }],
            },
          },
        },
      }
    },

    DocumentDropped: ({ id, name, text }) => {
      // Max 4 documents per message; total staged text capped
      // (the pump inlines at most ~20k chars into the turn —
      // staging far beyond that would pretend she read it all).
      const current = model.session.composer.documents ?? []
      if (current.length >= 4) {
        console.warn(`[diag] update: DocumentDropped refused (already 4 documents): ${name}`)
        return { model }
      }
      const totalChars = current.reduce((n, d) => n + d.text.length, 0) + text.length
      if (totalChars > 200_000) {
        console.warn(`[diag] update: DocumentDropped refused (staged text would exceed 200k chars): ${name}`)
        return { model }
      }
      console.warn(`[diag] update: DocumentDropped ${name} (${text.length} chars)`)
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            composer: {
              ...model.session.composer,
              documents: [...current, { id, name, text }],
            },
          },
        },
      }
    },

    AttachmentRemoved: ({ id }) => ({
      model: {
        ...model,
        session: {
          ...model.session,
          composer: {
            ...model.session.composer,
            attachments: model.session.composer.attachments.filter((a) => a.id !== id),
            documents: (model.session.composer.documents ?? []).filter((d) => d.id !== id),
          },
        },
      },
    }),

    /* ── Drawer space resize (2026-10-12: vertical stacked panes) ─── */
    DrawerSpaceResized: ({ aboveId, belowId, aboveRatio, belowRatio }) => {
      const drawer = model.session.drawer
      if (!drawer) return { model }
      return {
        model: {
          ...model,
          session: {
            ...model.session,
            drawer: {
              ...drawer,
              heightRatios: {
                ...(drawer.heightRatios ?? {}),
                [aboveId]: aboveRatio,
                [belowId]: belowRatio,
              },
            },
          },
        },
      }
    },
  })
}

/** Re-exported for the foldChild composition contract (integrator pass). */
export { RequestPermission, SendToInference }
