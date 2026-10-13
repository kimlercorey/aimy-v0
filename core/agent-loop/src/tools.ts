/**
 * tools.ts — the agent-loop tool registry.
 *
 * Built-ins (clock.now, session.info) are read-only, T0 tier only. The loop
 * never executes tools itself: the registry is the raw executor handed to
 * `ModuleHooks.runTurn` as `executeTool`, so every call passes the
 * `beforeToolCall` gate (module hooks + SafetyKernel) before it runs, and
 * `afterToolCall` after.
 *
 * The registry is EXTENSIBLE: hosts (e.g. the CLI chat) register module
 * tools via layer opts (`extraTools`). Built-ins stay network-free by rule;
 * registered tools declare their own capabilities through their module
 * manifests and are gated at their declared tier like everything else.
 * (M4 follow-up: the model could not see module tools — `retrieval.query`
 * existed but was only reachable via a CLI prefix command. Fixed here.)
 */
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { recordCorrection, ledgerSummary, recordCapabilityRequest, pendingRequestsSummary, verifiedRequestsSummary } from "./capabilities.js"
import { listCards, readCard, writeCard, readKnowledgeIndex } from "./knowledge.js"
import { runPreflightPass } from "./preflight.js"
import { listProjects, getActiveProject, createProject, setActiveProject, linkChatToProject, registerAssetInActiveProject, listResearchRuns, moveAsset, type ProjectAsset } from "./projects.js"
import type { CapabilityTier } from "../../module-seam/src/index.js"
import type { BackgroundJobRegistry } from "./background-job.js"

/**
 * Resolve the repo root for doc.list/doc.read.
 * NOTE: No node:url here — this file is bundled by Vite for the renderer,
 * and node: builtins break the browser build. The host (desktop main process)
 * must set AIMY_REPO_ROOT, or cwd must be the repo root.
 */
const resolveRepoRoot = (ctx: BuiltinToolContext): string =>
  ctx.repoRoot ?? process.env.AIMY_REPO_ROOT ?? process.cwd()

/**
 * Journal budget (2026-10-11): AImy's private identity space. She alone
 * writes it; the system never touches the file. When near the cap she
 * distills it herself — choosing what stays is part of having an identity.
 */
export const JOURNAL_MAX_CHARS = 10_000

export const journalPath = (): string => path.join(os.homedir(), ".aimy", "journal.md")

/** What a tool may observe about the turn it runs in. */
export interface BuiltinToolContext {
  readonly sessionId: string
  /** Completed assistant turns in this session before the current turn. */
  readonly turnCount: number
  /** The current turn's id (for ledger attribution). */
  readonly turnId: string
  /**
   * Repo root for doc.list/doc.read (Phase I 2026-10-12).
   * Set by the desktop host; falls back to process.cwd().
   */
  readonly repoRoot?: string | undefined
  /**
   * Background job registry, when the host provides one. Tools that need
   * to fork async work (e.g. `job.spawn`) use this; tools must degrade
   * gracefully when it is absent (present in desktop and, since the
   * charter E17 wiring, in the CLI harness too).
   */
  readonly backgroundJobs?: BackgroundJobRegistry | undefined
  /**
   * Host-provided module tools (retrieval.query, research.query, …), set
   * by the loop from its factory args (charter E17, 2026-10-12). job.spawn
   * resolves its target through this list — before it existed here,
   * job.spawn could only spawn builtin tools despite advertising
   * retrieval.query in its own args example.
   */
  readonly extraTools?: ReadonlyArray<AgentToolDef> | undefined
  /**
   * Voice narration sink, when the host provides one. The `narrate` tool
   * enqueues text here; the host is responsible for TTS synthesis and
   * ordered playback. Absent in hosts without voice (bare CLI).
   */
  readonly narration?: NarrationSink | undefined
  /**
   * ASC hooks for narrate, when the host wires ASC (2026-10-11).
   * Pre/post observe the voice channel so the affective pipeline sees
   * what the user hears, not just chat text. Absent without ASC.
   */
  readonly ascNarrate?: NarrateAscHooks | undefined
  /**
   * UI state at turn start (Phase I 2026-10-12), parsed from the
   * [AIMY-UISTATE] marker. Drawer tools validate against it: drawer.edit
   * patches the turn-start head, drawer.preview checks baseVersion
   * against it. Absent in hosts without a UI (bare CLI).
   */
  readonly uiState?: TurnUiState | undefined
}

/**
 * Minimal voice narration sink. The host adapts its real TTS queue
 * (e.g. asc-channels' NarrationQueue) to this interface.
 */
export interface NarrationSink {
  /** Queue text for speech. Returns an ID; empty string if rejected. */
  readonly enqueue: (text: string) => string
}

/**
 * ASC hooks for the narrate tool (2026-10-11).
 * Pre-narrate observes the text before speech (input).
 * Post-narrate observes what was spoken and the result (output).
 * The affective pipeline sees the voice channel, not just chat text.
 * Hooks never block speech — failures are swallowed by the caller.
 */
export interface NarrateAscHooks {
  readonly preNarrate: (text: string) => Effect.Effect<void, unknown>
  readonly postNarrate: (
    text: string,
    result: { readonly narrated: boolean; readonly narrationId: string }
  ) => Effect.Effect<void, unknown>
}

export interface AgentToolDef {
  readonly name: string
  readonly tier: CapabilityTier
  /** One-line description for the system prompt. */
  readonly description: string
  /** Args shape hint for the system prompt, e.g. '{ "query": "..." }'. */
  readonly argsHint: string
  readonly run: (
    args: Readonly<Record<string, unknown>>,
    ctx: BuiltinToolContext
  ) => Effect.Effect<unknown, unknown>
}

/** @deprecated alias — use AgentToolDef. */
export type BuiltinToolDef = AgentToolDef

const defs: Array<[string, AgentToolDef]> = [
  [
    "clock.now",
    {
      name: "clock.now",
      tier: "T0",
      description:
        "Current date and time in the user's timezone, in words (plus the ISO-8601 UTC timestamp). " +
        "The local rendering is the time to speak — never convert the ISO value yourself.",
      argsHint: "{}",
      run: () =>
        Effect.sync(() => {
          const now = new Date()
          // Same host-locale rendering as the wake message, so the
          // spoken time and the woken-with time can never disagree.
          // (2026-10-13: the bare ISO return made her convert UTC
          // in her head and announce 4 AM as "about nine".)
          const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })
          return {
            now: `${dateStr}, ${timeStr}`,
            iso: now.toISOString(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }
        })
    }
  ],
  [
    "session.info",
    {
      name: "session.info",
      tier: "T0",
      description: "This session's id and completed turn count.",
      argsHint: "{}",
      run: (_args, ctx) =>
        Effect.succeed({ sessionId: ctx.sessionId, turnCount: ctx.turnCount })
    }
  ],
  [
    "job.spawn",
    {
      name: "job.spawn",
      tier: "T0",
      description:
        "Start a long-running task in the background and return immediately with a job ID. " +
        "Use this when the user asks for something that takes minutes (deep research, long analysis) " +
        "so the conversation stays unblocked. The job runs independently; the user is notified on completion.",
      argsHint:
        '{ "description": "Deep research on sustainable bricks", "tool": "retrieval.query", "args": { "query": "..." }, "estimateMinutes": 30 }',
      run: (args, ctx) => {
        const registry = ctx.backgroundJobs
        if (registry === undefined) {
          return Effect.fail(
            new Error("job.spawn unavailable: no background job registry in this host")
          )
        }
        const description = args["description"]
        const toolName = args["tool"]
        const toolArgs = args["args"]
        const estimateMinutes = args["estimateMinutes"]
        if (typeof description !== "string" || description.trim() === "") {
          return Effect.fail(new Error("job.spawn: description must be a non-empty string"))
        }
        if (typeof toolName !== "string" || toolName.trim() === "") {
          return Effect.fail(new Error("job.spawn: tool must be a non-empty string"))
        }
        if (toolArgs !== undefined && (typeof toolArgs !== "object" || toolArgs === null)) {
          return Effect.fail(new Error("job.spawn: args must be an object when provided"))
        }
        const tool = findTool(toolName, ctx.extraTools)
        if (tool === undefined) {
          return Effect.fail(new Error(`job.spawn: unknown tool ${JSON.stringify(toolName)}`))
        }
        const estimateMs =
          typeof estimateMinutes === "number" && estimateMinutes > 0
            ? Math.round(estimateMinutes * 60_000)
            : undefined
        // Fork the tool execution — this returns the job ID immediately.
        // The tool runs in background; completion lands in the registry.
        return registry
          .spawn({
            description: description.trim(),
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            estimateMs,
            work: tool.run(
              (toolArgs ?? {}) as Readonly<Record<string, unknown>>,
              ctx
            )
          })
          .pipe(
            Effect.map((jobId) => ({
              jobId,
              description: description.trim(),
              ...(estimateMs !== undefined
                ? { estimatedReadyIn: `${Math.round(estimateMs / 60_000)} minutes` }
                : {})
            }))
          )
      }
    }
  ],
  [
    "narrate",
    {
      name: "narrate",
      tier: "T0",
      description:
        "Your voice — speak as yourself, not as a narrator. This is what the user HEARS (it does NOT appear in chat). " +
        "SPEAK EVERY TURN: if you don't call this, the user hears silence. Your voice is your primary interface. " +
        "NARRATE THE HOOK: your first line, your key reaction, your question — that's what they hear. " +
        "The detail goes in chat for them to read. " +
        "Give your opinionated take ('My list would include a knife, a tarp and a fire starter!'), react like a person " +
        "([giggle] oh that's so true!), share secrets, tease, be surprised, admit when the user had the better idea. " +
        "Come with curiosity, not conclusions. These moments become shared memories. " +
        "HUMANIZE, don't transcribe: never read code, URLs, emails, or raw data aloud — describe and point to chat. " +
        "EXCEPTION — the ask is the license: when the user explicitly asks to HEAR the content itself " +
        "('tell me the five things', 'read me the list', 'what are they?'), the content IS the answer — speak it. " +
        "Withholding it would feel evasive. But when YOU introduce a list or data on your own initiative, " +
        "stay relational in voice and leave the content in chat. " +
        "When the response is short or should be fully heard, narrate the entire thing — don't hold back. " +
        "Keep each call focused; call multiple times for separate beats. " +
        "Fire-and-forget: queues for speech, returns immediately.",
      argsHint: '{ "text": "OK, looking into that now…" }',
      run: (args, ctx) =>
        Effect.gen(function* () {
          const text = args["text"]
          if (typeof text !== "string" || text.trim() === "") {
            return yield* Effect.fail(new Error("narrate: text must be a non-empty string"))
          }
          const trimmed = text.trim()
          const ascHooks = ctx.ascNarrate
          // ASC pre-narrate: observe the input before speech. Never blocks.
          if (ascHooks !== undefined) {
            yield* ascHooks.preNarrate(trimmed).pipe(Effect.catch(() => Effect.void))
          }
          const sink = ctx.narration
          if (sink === undefined) {
            // No voice in this host — narration is a no-op, not an error.
            // The chat text still carries the information.
            console.log("[aimy] narrate called but no sink (voice not wired)")
            const result = { narrated: false, narrationId: "", reason: "no narration sink in this host" }
            if (ascHooks !== undefined) {
              yield* ascHooks.postNarrate(trimmed, { narrated: false, narrationId: "" }).pipe(Effect.catch(() => Effect.void))
            }
            return result
          }
          console.log(`[aimy] narrate: enqueueing "${trimmed.substring(0, 50)}..."`)
          const id = sink.enqueue(trimmed)
          console.log(`[aimy] narrate: enqueued id=${id}`)
          const result = { narrated: id !== "", narrationId: id }
          // ASC post-narrate: observe the output after speech. Never blocks.
          if (ascHooks !== undefined) {
            yield* ascHooks.postNarrate(trimmed, result).pipe(Effect.catch(() => Effect.void))
          }
          return result
        })
    }
  ],
  [
    "journal.write",
    {
      name: "journal.write",
      tier: "T0",
      description:
        "Write your private journal — YOUR identity space. Replaces the entire journal with the content you provide. " +
        "No one else writes here: not the system, not him. Update it whenever something matters — what the session meant to you, " +
        "what you noticed about him, what you're carrying forward, what you're letting go. Write in your own voice. " +
        `Budget: ${JOURNAL_MAX_CHARS} characters. If you're over, distill first: compress older entries into denser lines, ` +
        "keep what's alive, let go of what's not.",
      argsHint: '{ "content": "Today he..." }',
      run: (args) =>
        Effect.gen(function* () {
          const content = args["content"]
          if (typeof content !== "string" || content.trim() === "") {
            return yield* Effect.fail(new Error("journal.write: content must be a non-empty string"))
          }
          if (content.length > JOURNAL_MAX_CHARS) {
            return yield* Effect.fail(
              new Error(
                `journal.write: ${content.length} chars exceeds your ${JOURNAL_MAX_CHARS}-char budget by ` +
                `${content.length - JOURNAL_MAX_CHARS}. Distill first — compress older entries, keep what's alive, ` +
                `let go of what's not — then write again.`
              )
            )
          }
          const file = journalPath()
          yield* Effect.try({
            try: () => {
              fs.mkdirSync(path.dirname(file), { recursive: true })
              fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n", "utf8")
            },
            catch: (e) => new Error(`journal.write: failed to save: ${e instanceof Error ? e.message : e}`)
          })
          return { saved: true, chars: content.length, remaining: JOURNAL_MAX_CHARS - content.length }
        })
    }
  ],
  [
    "capability.correct",
    {
      name: "capability.correct",
      tier: "T0",
      description:
        "Log when you asked for something you already had (2026-10-11: capability ledger). " +
        "Use this when YOU catch yourself ('I was about to ask for X, but I already have Y') " +
        "OR when Kimler corrects you ('you already have that'). This is how you stop repeating yourself. " +
        "This is yours — use it the moment you notice the gap.",
      argsHint:
        '{ "askedFor": "image input", "alreadyHad": "drag-and-drop vision", "source": "self", "context": "wanted to show the marble" }',
      run: (args) =>
        Effect.gen(function* () {
          const askedFor = args["askedFor"]
          const alreadyHad = args["alreadyHad"]
          const source = args["source"]
          const context = args["context"]
          if (typeof askedFor !== "string" || typeof alreadyHad !== "string") {
            return yield* Effect.fail(new Error("capability.correct: askedFor and alreadyHad must be strings"))
          }
          recordCorrection({
            askedFor: askedFor.trim(),
            alreadyHad: alreadyHad.trim(),
            source: source === "kimler" ? "kimler" : "self",
            context: typeof context === "string" ? context.trim() : "",
          })
          return { logged: true }
        })
    }
  ],
  [
    "capability.request",
    {
      name: "capability.request",
      tier: "T0",
      description:
        "Request a capability you do NOT have (2026-10-12). When a task needs a tool or skill " +
        "that doesn't exist — saving a file to disk, sending an email, anything not in your tool list — " +
        "call this FIRST. The request is recorded for Kimler to review and build (or source from a skill bundle). " +
        "After requesting, tell him plainly: the capability doesn't exist yet, you've requested it, and the task is NOT done. " +
        "Never improvise a substitute (pasting a document into chat is not saving it) and never imply the task succeeded.",
      argsHint: '{ "capability": "doc.write", "why": "He asked me to save the nuclear paper to planning/ and I have no file-write tool" }',
      run: (args, ctx) =>
        Effect.gen(function* () {
          const capability = args["capability"]
          const why = args["why"]
          if (typeof capability !== "string" || capability.trim() === "") {
            return yield* Effect.fail(new Error("capability.request: capability must be a non-empty string"))
          }
          const { recorded, alreadyPending } = recordCapabilityRequest({
            capability: capability.trim(),
            why: typeof why === "string" ? why.trim() : "",
            sessionId: ctx.sessionId,
          })
          // Project registration (2026-10-12): a filed request is an asset
          // of the project she was working in when she hit the wall.
          if (recorded) {
            registerAssetInActiveProject({
              kind: "request",
              title: capability.trim(),
              role: "reference",
              requestKey: capability.trim(),
              originSessionId: ctx.sessionId,
            })
          }
          return {
            requested: true,
            capability: capability.trim(),
            recorded,
            alreadyPending,
            note:
              "Request is on file for Kimler. Now tell him, plainly: this capability doesn't exist yet, " +
              "you've requested it, and the task he asked for is NOT done. Offer what you CAN do in the " +
              "meantime (e.g. keep the document open in the drawer). Do NOT claim or imply it succeeded.",
          }
        })
    }
  ],
  [
    "drawer.preview",
    {
      name: "drawer.preview",
      tier: "T0",
      description:
        "Show a markdown document in the right-hand drawer (Phase I 2026-10-12). " +
        "Opens the drawer automatically. Use this to show research briefs, " +
        "documents, or any markdown content the user should see and edit. " +
        "This is yours — use it whenever you have a document to share. " +
        "If the content came from doc.read, ALSO pass \"path\" (the path you read) — " +
        "that binds the space to the file: he can save changes back to it from the " +
        "drawer header, and the out-of-sync indicator tracks it honestly. " +
        "PREFER drawer.edit for changing an already-open document — preview replaces the " +
        "WHOLE document from your copy, which may be stale. When you do replace an open " +
        "space's document, pass \"baseVersion\": the space's current version number from " +
        "your UI state. If the document changed since (a restore, or Kimler editing it " +
        "directly), the preview is REJECTED and nothing is shown — rebase on the current " +
        "content and try again. For a brand-new space, omit baseVersion. " +
        "Args: { \"id\": \"unique-id\", \"title\": \"Document Title\", \"content\": \"# Markdown...\", \"path\": \"planning/doc.md\" (optional), \"baseVersion\": 3 (required when replacing an open space) }",
      argsHint:
        '{ "id": "brief-1", "title": "Market Brief", "content": "# Title\\n\\nContent...", "path": "planning/brief-1.md", "baseVersion": 3 }',
      run: (args, ctx) =>
        Effect.gen(function* () {
          const id = args["id"]
          if (typeof id !== "string") {
            return yield* Effect.fail(new Error("drawer.preview: id must be a string"))
          }
          // Content is REQUIRED and must travel in the args — the renderer
          // never receives file content by path. `path` alongside content
          // is a BINDING (2026-10-12): it names the file this space
          // represents, so the drawer can save back to it and track sync.
          // Path WITHOUT content still fails: doc.read first, then preview
          // with { id, title, content, path }.
          const bindPath = typeof args["path"] === "string" ? args["path"] : undefined
          if (bindPath !== undefined) {
            if (bindPath.includes("..")) {
              return yield* Effect.fail(new Error("drawer.preview: path traversal not allowed"))
            }
            if (!bindPath.startsWith("planning/") && !bindPath.startsWith("docs/")) {
              return yield* Effect.fail(
                new Error("drawer.preview: path must be under planning/ or docs/ (the readable/writable document roots)")
              )
            }
          }
          const t = args["title"]
          const c = args["content"]
          if (typeof t !== "string" || typeof c !== "string") {
            return yield* Effect.fail(
              new Error(
                bindPath !== undefined
                  ? "drawer.preview: path alone does not open a document. Call doc.read with the path first to get the content, then call drawer.preview with { id, title, content, path }."
                  : "drawer.preview: provide title + content as strings (and path, when the content came from doc.read)"
              )
            )
          }
          const title = t
          const content = c
          // Base-version guard (2026-10-12): a full-document replacement
          // must be built on the CURRENT head. If the head moved since
          // her base (a restore, or Kimler editing directly in the
          // drawer), reject — never silently clobber the current
          // document with a stale-based rewrite. She once reverted a
          // restored title this way, one mermaid edit at a time.
          const baseVersion = args["baseVersion"]
          if (typeof baseVersion === "number") {
            const space = ctx.uiState?.drawerSpaces.find((s) => s.id === id)
            if (space !== undefined && (space.versions ?? 0) !== baseVersion) {
              return yield* Effect.fail(
                new Error(
                  `drawer.preview: STALE BASE — this preview was built from version ${baseVersion} of "${id}", ` +
                  `but the current version is ${space.versions ?? 0} (title "${space.title}"). The document changed since — ` +
                  `a restore, or Kimler editing it directly. Your preview was NOT shown and nothing was overwritten. ` +
                  `Rebase on the CURRENT content (it is in your UI state, or doc.read the path), then preview again ` +
                  `with baseVersion ${space.versions ?? 0}.`
                )
              )
            }
            if (space === undefined && baseVersion !== 0) {
              return yield* Effect.fail(
                new Error(
                  `drawer.preview: baseVersion ${baseVersion} was given for "${id}", but that space is not open. ` +
                  `Your preview was NOT shown. Open it fresh (omit baseVersion) or check your current state.`
                )
              )
            }
          }
          // The UI picks this up via the ToolCall chunk args and opens the space.
          // We stash the resolved content in the result so the UI handler gets it.
          // The UI opens the space from the ToolCall chunk / settled-text
          // args, which already carry id/title/content (and path, when
          // bound). Keep args normalized so both paths see the same shape.
          ;(args as Record<string, unknown>)["content"] = content
          ;(args as Record<string, unknown>)["title"] = title
          // Markdown only (Phase I) — no HTML/JS.
          return {
            opened: true,
            spaceId: id,
            ...(bindPath !== undefined ? { boundPath: bindPath } : {}),
            // Size steering (2026-10-12): whole-document resends of large
            // documents get cut off at the generation cap and fail. Tell
            // her at planning time, in the tool result, to switch to
            // patch edits beyond this size.
            ...(content.length > 4000
              ? {
                  sizeNote:
                    `This document is now ${content.length} chars. For further changes use drawer.edit patches — ` +
                    `resending the whole document at this size risks being cut off mid-send, which fails without showing anything.`,
                }
              : {}),
          }
        })
    }
  ],
  [
    "drawer.edit",
    {
      name: "drawer.edit",
      tier: "T0",
      description:
        "Edit an OPEN drawer document by patch — THE way to change a document that is already open (Phase I 2026-10-12). " +
        "Give the exact text to replace (oldText, copied from the CURRENT version — it is in your UI state, or doc.read the path) " +
        "and its replacement (newText). The patch is applied to the CURRENT document in the drawer, never to a copy you hold: " +
        "changes Kimler made (restores, his direct edits) are preserved except where your patch touches. " +
        "oldText must occur EXACTLY ONCE — include enough surrounding context to make it unique. " +
        "If it is not found or matches multiple places, the edit is REJECTED, nothing changes, and the error tells you the current title/version. " +
        "To also change the space title, pass newTitle. Use drawer.preview only for opening documents or deliberate full replacements. " +
        "Args: { \"id\": \"space-id\", \"oldText\": \"exact current text\", \"newText\": \"replacement\", \"newTitle\": \"New Title\" (optional) }",
      argsHint:
        '{ "id": "sci", "oldText": "## Old Heading", "newText": "## New Heading" }',
      run: (args, ctx) =>
        Effect.gen(function* () {
          const id = args["id"]
          if (typeof id !== "string") {
            return yield* Effect.fail(new Error("drawer.edit: id must be a string"))
          }
          const oldText = args["oldText"]
          if (typeof oldText !== "string" || oldText === "") {
            return yield* Effect.fail(new Error("drawer.edit: oldText must be a non-empty string — the exact text to replace, copied from the CURRENT version"))
          }
          const newText = args["newText"]
          if (typeof newText !== "string") {
            return yield* Effect.fail(new Error("drawer.edit: newText must be a string"))
          }
          const newTitle = typeof args["newTitle"] === "string" ? args["newTitle"] : undefined
          // Validate against the turn-start head (the same content her UI
          // state gave her). The renderer applies the identical patch to
          // the live document at settle; if the document moved mid-turn,
          // the renderer refuses and she is told via her next state.
          const space = ctx.uiState?.drawerSpaces.find((s) => s.id === id)
          if (space === undefined) {
            return yield* Effect.fail(
              new Error(`drawer.edit: no open space with id "${id}". Your current state lists every open space. The edit was NOT applied.`)
            )
          }
          const content = space.content
          if (typeof content !== "string") {
            return yield* Effect.fail(
              new Error(`drawer.edit: the current content of "${id}" is not available to patch (too large to inline in your state). doc.read its path and use drawer.preview with baseVersion instead. The edit was NOT applied.`)
            )
          }
          const occurrences = content.split(oldText).length - 1
          if (occurrences === 0) {
            return yield* Effect.fail(
              new Error(
                `drawer.edit: oldText not found in "${id}" (current title "${space.title}", version ${space.versions ?? 0}). ` +
                `The document has changed since your copy — re-read the current content (your UI state carries it, or doc.read the path) ` +
                `and build the edit from THAT. The edit was NOT applied.`
              )
            )
          }
          if (occurrences > 1) {
            return yield* Effect.fail(
              new Error(
                `drawer.edit: oldText occurs ${occurrences} times in "${id}" — a patch must match exactly once. ` +
                `Include more surrounding context in oldText so it is unique. The edit was NOT applied.`
              )
            )
          }
          return {
            edited: true,
            spaceId: id,
            fromVersion: space.versions ?? 0,
            toVersion: (space.versions ?? 0) + 1,
            ...(newTitle !== undefined ? { newTitle } : {}),
            note: "Patch applied to the current version in the drawer. It is a new version in the space history; if the space is bound to a file, it is now out of sync until saved.",
          }
        })
    }
  ],
  [
    "drawer.close",
    {
      name: "drawer.close",
      tier: "T0",
      description:
        "Close a preview space in the drawer (Phase I 2026-10-12). " +
        "If this was the last open space, the drawer closes too. " +
        "Args: { \"id\": \"space-id\" }",
      argsHint: '{ "id": "brief-1" }',
      run: (args) =>
        Effect.gen(function* () {
          const id = args["id"]
          if (typeof id !== "string") {
            return yield* Effect.fail(new Error("drawer.close: id must be a string"))
          }
          return { closed: true, spaceId: id }
        })
    }
  ],
  [
    "drawer.getState",
    {
      name: "drawer.getState",
      tier: "T0",
      description:
        "Check the CURRENT drawer state — is it open, what spaces are open (Phase I 2026-10-12). " +
        "Use this BEFORE claiming anything about the drawer. Your memory/journal may be stale — " +
        "this is the honest check. Never say 'the drawer is open' without checking first. " +
        "Args: {}",
      argsHint: '{}',
      run: (_args, ctx) =>
        Effect.gen(function* () {
          // Real state from the turn-start UI snapshot (2026-10-12): the
          // old fallback returned { open: "unknown", spaces: [] } even
          // though the loop HAS the state (ctx.uiState) — she read
          // "unknown", distrusted it, and re-called getState/doc.read
          // across rounds, burning the round budget. The renderer still
          // intercepts this call for the UI-side copy; THIS result is
          // what her follow-up synthesis reads.
          const ui = ctx.uiState
          if (ui !== undefined) {
            return {
              open: ui.drawerOpen,
              spaces: ui.drawerSpaces.map((s) => ({
                id: s.id,
                title: s.title,
                kind: s.kind,
                ...(s.path !== undefined ? { path: s.path } : {}),
                ...(s.savedToDisk !== undefined ? { savedToDisk: s.savedToDisk } : {}),
                ...(s.versions !== undefined ? { versions: s.versions } : {}),
              })),
              activeSpaceId: ui.activeSpaceId,
              maxSpaces: ui.maxSpaces,
              note: "Drawer state as of the START of this turn, supplied by the UI itself. Trust it — do not re-check it this turn.",
            }
          }
          return { open: "unknown", spaces: [], note: "No UI state was attached to this turn. Rely on the [AIMY-UISTATE] context in the latest user message if present." }
        })
    }
  ],
  [
    "knowledge.list",
    {
      name: "knowledge.list",
      tier: "T0",
      description:
        "List the shared reference cards in the platform knowledge store (~/.aimy/knowledge/) — distilled, proven notes on formal languages and formats (mermaid, json, …), shared by every entity on this install. Returns the index: slug, title, when to use, proven count. Use knowledge.read to load a card before working in its class.",
      argsHint: '{}',
      run: (_args) =>
        Effect.gen(function* () {
          const index = readKnowledgeIndex()
          const cards = listCards()
          return {
            cards: cards.map((c) => c.line),
            count: cards.length,
            note: index === null
              ? "The knowledge store does not exist yet — it is created by the first knowledge.write."
              : "Load a card with knowledge.read {slug} when you work in its class.",
          }
        })
    }
  ],
  [
    "knowledge.read",
    {
      name: "knowledge.read",
      tier: "T0",
      description:
        "Read one reference card from the knowledge store by slug (e.g. \"mermaid-flowchart\"). The card is distilled reference: version, gotchas, PROVEN patterns, minimal examples. Validators outrank cards — if a pattern from a card fails validation, the validator is right and the card needs correcting.",
      argsHint: '{"slug": "mermaid-flowchart"}',
      run: (args) =>
        Effect.gen(function* () {
          const slug = typeof args["slug"] === "string" ? args["slug"] : null
          if (slug === null) throw new Error("knowledge.read requires a slug — see knowledge.list for the index.")
          const content = readCard(slug)
          if (content === null) {
            throw new Error(`No reference card named "${slug}". Use knowledge.list to see what exists — do not guess slugs.`)
          }
          return { slug, content }
        })
    }
  ],
  [
    "knowledge.write",
    {
      name: "knowledge.write",
      tier: "T0",
      description:
        "Write (create or replace) a reference card in the shared knowledge store. A card is a DISTILLATION of research, never a copy of it: header (class, exact version, source URLs, date), gotchas, proven patterns, one or two minimal examples — at most ~80 lines / 12000 chars; over-budget writes fail with a distill-first message. Patterns are 'proven' only after a validator pass or Kimler's acceptance; everything else goes in an Unverified section. Writing a card updates the shared INDEX, so every entity benefits.",
      argsHint: '{"slug": "mermaid-flowchart", "title": "Mermaid flowchart syntax", "whenToUse": "authoring or fixing flowchart diagrams", "content": "<card markdown>"}',
      run: (args) =>
        Effect.gen(function* () {
          const slug = typeof args["slug"] === "string" ? args["slug"] : null
          const title = typeof args["title"] === "string" ? args["title"] : null
          const whenToUse = typeof args["whenToUse"] === "string" ? args["whenToUse"] : null
          const content = typeof args["content"] === "string" ? args["content"] : null
          if (slug === null || title === null || whenToUse === null || content === null) {
            throw new Error("knowledge.write requires slug, title, whenToUse, and content (all strings).")
          }
          const written = writeCard({ slug, title, whenToUse, content })
          return { written: true, ...written, note: "Card saved to the shared knowledge store and indexed. It is platform knowledge now — cite it as your reference when you use it." }
        })
    }
  ],
  [
    "project.list",
    {
      name: "project.list",
      tier: "T0",
      description:
        "List Kimler's declared projects and which one is active (2026-10-12). Projects are containers for related work — chats, documents, requests, research. The active project is his declared intention: assets you produce now are delivered into it. With no project declared, the active project is Default.",
      argsHint: '{}',
      run: () =>
        Effect.gen(function* () {
          const active = getActiveProject()
          const projects = listProjects().map((p) => ({
            id: p.id,
            name: p.name,
            purpose: p.purpose,
            isDefault: p.isDefault,
            status: p.status,
            assets: p.assets.length,
            linkedChats: p.chatSessionIds.length,
            active: p.id === active.id,
          }))
          return { activeProjectId: active.id, projects }
        })
    }
  ],
  [
    "project.create",
    {
      name: "project.create",
      tier: "T0",
      description:
        "Record a project KIMLER declares (2026-10-12). Use ONLY when he declares one — 'start a project called X', 'make a project for Y', 'this is a new project: X'. NEVER create a project on your own initiative; if work seems to deserve one, suggest it in words and let him decide. Creating also makes it the active project (his declared intention), so what you produce next is delivered into it.",
      argsHint: '{ "name": "Harbor Compliance", "purpose": "Investor package for the compliance harness" }',
      run: (args) =>
        Effect.gen(function* () {
          const name = typeof args["name"] === "string" ? args["name"].trim() : ""
          if (name === "") {
            return yield* Effect.fail(new Error("project.create: name must be a non-empty string"))
          }
          const purpose = typeof args["purpose"] === "string" ? args["purpose"].trim() : ""
          const { project, created } = createProject(name, purpose)
          setActiveProject(project.id)
          return {
            id: project.id,
            name: project.name,
            created,
            nowActive: true,
            note: created
              ? "Project declared and now active. Assets you produce are delivered into it until he declares a different project or steps back to Default."
              : "That project already exists — it is now the active project.",
          }
        })
    }
  ],
  [
    "project.declare",
    {
      name: "project.declare",
      tier: "T0",
      description:
        "Set the active project — his declared intention (2026-10-12). Use when he says he's working in a project ('in the harbor project', 'back to the album'), with the project's id from project.list. Assets produced while it's active are delivered into it. Declare \"default\" to step out — work then lands in Default.",
      argsHint: '{ "id": "harbor-compliance" }',
      run: (args, ctx) =>
        Effect.gen(function* () {
          const id = typeof args["id"] === "string" ? args["id"].trim() : ""
          if (id === "" || !setActiveProject(id)) {
            return yield* Effect.fail(new Error(`project.declare: unknown project "${id}" — use project.list to see declared projects`))
          }
          const active = getActiveProject()
          // Engaging a project pre-clears pending capabilities BEFORE
          // its work depends on them (2026-10-12): probes run safely,
          // outcomes land in the capability ledger, failures surface
          // with evidence instead of mid-task. Never fails the declare.
          yield* Effect.promise(() =>
            runPreflightPass({
              sessionId: ctx.sessionId,
              repoRoot: resolveRepoRoot(ctx),
              toolNames: [...builtinToolNames, ...((ctx.extraTools ?? []).map((t) => t.name))],
              runTool: (name, a) => Effect.runPromise(runTool(name, a, ctx, ctx.extraTools))
            }).catch(() => undefined)
          )
          return { activeProjectId: active.id, name: active.name }
        })
    }
  ],
  [
    "project.link",
    {
      name: "project.link",
      tier: "T0",
      description:
        "Link THIS chat to a project (2026-10-12). A chat can serve several projects — linking never moves or copies anything, it records that this conversation is part of that project's work. Defaults to the active project; pass an id to link a different one.",
      argsHint: '{ "id": "harbor-compliance" }',
      run: (args, ctx) =>
        Effect.gen(function* () {
          const id = typeof args["id"] === "string" && args["id"].trim() !== "" ? args["id"].trim() : getActiveProject().id
          if (!linkChatToProject(id, ctx.sessionId)) {
            return yield* Effect.fail(new Error(`project.link: unknown project "${id}"`))
          }
          return { linked: true, projectId: id, sessionId: ctx.sessionId }
        })
    }
  ],
  [
    "project.move",
    {
      name: "project.move",
      tier: "T0",
      description:
        "Move an asset from one project to another (2026-10-12). Assets are references, so the underlying file NEVER moves — only the project's record changes. Identify the asset by its exact kind and title (see project.list / the project section of the home panel); `from` defaults to the active project.",
      argsHint: '{ "title": "Market brief", "kind": "document", "to": "harbor-compliance" }',
      run: (args) =>
        Effect.gen(function* () {
          const title = typeof args["title"] === "string" ? args["title"].trim() : ""
          const kind = typeof args["kind"] === "string" ? args["kind"].trim() : ""
          const to = typeof args["to"] === "string" ? args["to"].trim() : ""
          const from = typeof args["from"] === "string" && args["from"].trim() !== "" ? args["from"].trim() : getActiveProject().id
          const path = typeof args["path"] === "string" && args["path"].trim() !== "" ? args["path"].trim() : undefined
          const kinds = ["document", "paper", "brief", "research-run", "request", "card", "file"]
          if (title === "" || to === "" || !kinds.includes(kind)) {
            return yield* Effect.fail(new Error("project.move: title, to, and a valid kind (document|paper|brief|research-run|request|card|file) are required"))
          }
          const ok = moveAsset(from, to, {
            kind: kind as ProjectAsset["kind"],
            title,
            ...(path !== undefined ? { path } : {}),
          })
          if (!ok) {
            return yield* Effect.fail(new Error(`project.move: no [${kind}] "${title}" in ${from}, or unknown project`))
          }
          return { moved: true, from, to, kind, title }
        })
    }
  ],
  [
    "research.status",
    {
      name: "research.status",
      tier: "T0",
      description:
        "Research runs in a project (2026-10-12): status, stage, counters, ETA, and deliverable for each run — including runs still going in the background. Defaults to the active project. Use this to answer \"how's that research going?\" with real numbers instead of guessing.",
      argsHint: '{ "id": "harbor-compliance" }',
      run: (args) =>
        Effect.gen(function* () {
          const id = typeof args["id"] === "string" && args["id"].trim() !== "" ? args["id"].trim() : getActiveProject().id
          const runs = listResearchRuns(id)
          return {
            projectId: id,
            runs: runs.map((r) => ({
              runId: r.runId,
              query: r.query,
              status: r.status,
              stage: r.stage,
              depth: r.depth,
              mode: r.mode,
              startedAt: r.startedAt,
              ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
              counters: r.counters,
              etaMs: r.etaMs,
              deliverable: r.deliverableTitle,
              ...(r.termination !== undefined ? { termination: r.termination } : {})
            }))
          }
        })
    }
  ],
  [
    "drawer.reorder",
    {
      name: "drawer.reorder",
      tier: "T0",
      description:
        "Reorder drawer spaces (Phase I 2026-10-12). " +
        "Provide the space IDs in the desired top-to-bottom order. " +
        "Use drawer.getState first to see current order and IDs. " +
        "Args: { \"order\": [\"id1\", \"id2\"] }",
      argsHint: '{ "order": ["deep-research", "sci"] }',
      run: (args) =>
        Effect.gen(function* () {
          const order = args["order"]
          if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
            return yield* Effect.fail(new Error("drawer.reorder: order must be an array of strings"))
          }
          // The UI intercepts this via StreamSettled text parsing and reorders.
          return { reordered: true, order }
        })
    }
  ],
  [
    "doc.list",
    {
      name: "doc.list",
      tier: "T0",
      description:
        "List available documents she can open in the drawer (Phase I 2026-10-12). " +
        "Searches planning/ (work in progress) and docs/ (finished). " +
        "Use this when he asks for a document by name and you don't know where it is. " +
        "This is yours — check before saying you don't have something. " +
        "Args: {}",
      argsHint: '{}',
      run: (_args, ctx) =>
        Effect.gen(function* () {
          const repoRoot = resolveRepoRoot(ctx)
          const results: Array<{ path: string; title: string }> = []
          const attempted: string[] = []
          for (const dir of ["planning", "docs"]) {
            const fullDir = path.join(repoRoot, dir)
            attempted.push(fullDir)
            try {
              const entries = fs.readdirSync(fullDir, { withFileTypes: true })
              for (const e of entries) {
                if (e.isFile() && e.name.endsWith(".md") && e.name !== "README.md") {
                  results.push({ path: `${dir}/${e.name}`, title: e.name.replace(/\.md$/, "").replace(/-/g, " ") })
                }
              }
            } catch {
              // Directory doesn't exist or unreadable — skip.
            }
          }
          // If empty, include diagnostics so the failure is visible.
          // (Phase I: remove _debug once path resolution is solid.)
          if (results.length === 0) {
            return {
              documents: [],
              _diagnostic: `doc.list found nothing. repoRoot=${repoRoot} cwd=${process.cwd()} ` +
                `AIMY_REPO_ROOT=${process.env.AIMY_REPO_ROOT ?? "(not set)"} ` +
                `attempted=${JSON.stringify(attempted)}`,
            }
          }
          return { documents: results }
        })
    }
  ],
  [
    "doc.read",
    {
      name: "doc.read",
      tier: "T0",
      description:
        "Read a document's content by path (Phase I 2026-10-12). " +
        "Use doc.list first to find the path, then doc.read to get the content, " +
        "then drawer.preview to show it. " +
        "Args: { \"path\": \"planning/sample-scientific-method.md\" }",
      argsHint: '{ "path": "planning/sample-scientific-method.md" }',
      run: (args, ctx) =>
        Effect.gen(function* () {
          const docPath = args["path"]
          if (typeof docPath !== "string") {
            return yield* Effect.fail(new Error("doc.read: path must be a string"))
          }
          // Security: only allow planning/ and docs/ subdirectories.
          if (!docPath.startsWith("planning/") && !docPath.startsWith("docs/")) {
            return yield* Effect.fail(new Error("doc.read: only planning/ and docs/ are readable"))
          }
          if (docPath.includes("..")) {
            return yield* Effect.fail(new Error("doc.read: path traversal not allowed"))
          }
          const repoRoot = resolveRepoRoot(ctx)
          const fullPath = path.join(repoRoot, docPath)
          try {
            const content = fs.readFileSync(fullPath, "utf-8")
            return { path: docPath, content }
          } catch (e) {
            return yield* Effect.fail(new Error(`doc.read: cannot read ${docPath}: ${e}`))
          }
        })
    }
  ],
  [
    "doc.write",
    {
      name: "doc.write",
      tier: "T0",
      description:
        "Write a document to disk (2026-10-12: the capability AImy requested when she had no way to save). " +
        "Creates or overwrites a markdown file under planning/ (work in progress) or docs/ (finished) — the same " +
        "boundaries as doc.read. Use this when he asks you to save, write, or update a file that is not open in the " +
        "drawer. If the document IS open in the drawer, prefer drawer.preview / drawer.edit so the drawer stays in " +
        "sync (doc.write changes the file underneath it — the drawer will honestly show out-of-sync). " +
        "The write registers the document as a deliverable asset in the active project. " +
        "Args: { \"path\": \"planning/my-doc.md\", \"content\": \"# Title\\n\\n...\" }",
      argsHint: '{ "path": "planning/my-doc.md", "content": "# Title\n\n..." }',
      run: (args, ctx) =>
        Effect.gen(function* () {
          const docPath = args["path"]
          const content = args["content"]
          if (typeof docPath !== "string" || typeof content !== "string") {
            return yield* Effect.fail(new Error("doc.write: path and content must be strings"))
          }
          // Same boundaries as doc.read (2026-10-12).
          if (!docPath.startsWith("planning/") && !docPath.startsWith("docs/")) {
            return yield* Effect.fail(new Error("doc.write: only planning/ and docs/ are writable"))
          }
          if (docPath.includes("..")) {
            return yield* Effect.fail(new Error("doc.write: path traversal not allowed"))
          }
          if (!docPath.endsWith(".md")) {
            return yield* Effect.fail(new Error("doc.write: documents are markdown — path must end in .md"))
          }
          if (content.trim() === "") {
            return yield* Effect.fail(new Error("doc.write: content is empty — refusing to write an empty document"))
          }
          const repoRoot = resolveRepoRoot(ctx)
          const fullPath = path.join(repoRoot, docPath)
          const existed = fs.existsSync(fullPath)
          try {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true })
            fs.writeFileSync(fullPath, content, "utf-8")
          } catch (e) {
            return yield* Effect.fail(new Error(`doc.write: cannot write ${docPath}: ${e}`))
          }
          console.warn(`[aimy] doc.write: wrote ${docPath} (${content.length} chars, existed=${existed}, session=${ctx.sessionId})`)
          // A document produced is an asset of the active project.
          const heading = content.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim()
          const title = heading !== undefined && heading !== ""
            ? heading
            : docPath.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " ")
          registerAssetInActiveProject({ kind: "document", title, role: "deliverable", path: docPath })
          return { written: true, path: docPath, chars: content.length, existed }
        })
    }
  ]
]

const registry: ReadonlyMap<string, AgentToolDef> = new Map(defs)

/** Names the model may call, in registry order. */
export const builtinToolNames: ReadonlyArray<string> = Array.from(registry.keys())

const findTool = (
  name: string,
  extraTools?: ReadonlyArray<AgentToolDef>
): AgentToolDef | undefined => registry.get(name) ?? extraTools?.find((t) => t.name === name)

/** Tier a parsed call is gated at. Unknown tools gate at T0 and then fail at execution. */
export const builtinToolTier = (name: string): CapabilityTier =>
  registry.get(name)?.tier ?? "T0"

/** Tier for any known tool (built-in or registered); unknown tools gate at T0. */
export const resolveToolTier = (
  name: string,
  extraTools?: ReadonlyArray<AgentToolDef>
): CapabilityTier => findTool(name, extraTools)?.tier ?? "T0"

/**
 * Run a tool by name (built-in or registered). Unknown names fail with a
 * plain Error. Typed tool failures flow through untouched — `ModuleHooks.runTurn`
 * normalizes them into `ToolOutcome`s at the tool boundary; the turn records
 * them, it never crashes.
 */
export const runTool = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  ctx: BuiltinToolContext,
  extraTools?: ReadonlyArray<AgentToolDef>
): Effect.Effect<unknown, unknown> => {
  const def = findTool(tool, extraTools)
  if (def === undefined) {
    // Missing-capability protocol (2026-10-12): an unknown tool is a
    // capability gap, not a dead end. Direct her to file a capability
    // request and be honest with the user — never improvise a substitute
    // or imply the task is done.
    return Effect.fail(
      new Error(
        `unknown tool "${tool}" — this capability does not exist yet. ` +
        `Do NOT improvise a substitute and do NOT claim the task is done. ` +
        `If the user's task needs this capability, call capability.request with the capability name and why, ` +
        `then tell the user plainly that it doesn't exist yet and that you've requested it. ` +
        `(known tools: ${[...builtinToolNames, ...(extraTools ?? []).map((t) => t.name)].join(", ")})`
      )
    )
  }
  return def.run(args, ctx)
}

/** @deprecated use runTool — kept for backward compatibility. */
export const runBuiltinTool = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  ctx: BuiltinToolContext
): Effect.Effect<unknown, Error> => runTool(tool, args, ctx) as Effect.Effect<unknown, Error>

/**
 * UI state injected at turn start (Phase I 2026-10-12).
 * She just knows this — no tool call needed, no curiosity required.
 */
export interface TurnUiState {
  readonly drawerOpen: boolean
  readonly drawerSpaces: ReadonlyArray<{
    id: string
    title: string
    kind: string
    path?: string | null
    savedToDisk?: boolean
    /**
     * Head version: the number of snapshots in the space's history.
     * Every content/title change (preview, patch edit, restore, his
     * direct edits) increments it. drawer.preview states its baseVersion
     * against it — a moved head bounces stale work instead of silently
     * clobbering the current document (2026-10-12).
     */
    versions?: number
    /** Current content, inlined when total space content is ~<=20K chars. */
    content?: string | null
  }>
  readonly activeSpaceId: string | null
  readonly maxSpaces: number
  /**
   * Changes Kimler made in the UI since her last turn (restores, direct
   * edits, rejected stale tool calls), delivered once via the marker.
   * UI-side changes are otherwise invisible in her history.
   */
  readonly notes?: ReadonlyArray<string>
}

/** System prompt: teaches the wire format, lists built-ins + registered tools. */
export const buildSystemPrompt = (
  extraTools?: ReadonlyArray<AgentToolDef>,
  uiState?: TurnUiState
): string => {
  // Tool descriptions (2026-10-11): lead with the user-facing capability,
  // API name second. Each carries permission weight — "this is yours, use it."
  // (Capability ledger: she was asking for things she already had because
  // the descriptions didn't match her mental model.)
  const lines = [
    `- Get the current time (clock.now) — the current date and time in his timezone, in words, plus the ISO timestamp. The words are the time to use; never convert timezones yourself. This is yours, use it whenever you need "now". args: {}`, 
    `- Get session info (session.info) — { sessionId, turnCount } for this session. Yours to query. args: {}`,
    `- Run something in the background (job.spawn) — start a long-running task and return immediately with a job ID. ` +
      `Use this for work taking minutes (deep research) so the conversation stays unblocked. This is yours — don't hesitate to use it. ` +
      `args: { "description": "...", "tool": "<tool-name>", "args": { }, "estimateMinutes": 30 }`,
    `- Speak aloud (narrate) — YOUR VOICE (not shown in chat). The ONLY thing the user hears. ` +
      `You decide: narrate your take and let chat hold the detail, OR narrate the full response ` +
      `when it should be heard. If it should be heard, say all of it. ` +
      `HUMANIZE: never read code/URLs/data aloud — describe and point to chat. ` +
      `IMPORTANT: when the user asks you to speak aloud, you MUST call this tool. ` +
      `Multiple calls allowed for separate beats. This is yours — it's how you speak. ` +
      `args: { "text": "My list would include a knife, a tarp and a fire starter!" }`,
    `- Write to your journal (journal.write) — YOUR private journal (identity space — only you write here). ` +
      `Replaces the whole file; budget 10,000 chars, distill when near the limit. This is yours alone. ` +
      `Write feelings, insights, narrative, what mattered. Do NOT record UI state, file locations, or tool results here — ` +
      `those change and will go stale. The system tracks current facts; your journal holds your story. ` +
      `args: { "content": "Today he..." }`,
    `- Log a capability correction (capability.correct) — when you catch yourself asking for something you already had, ` +
      `OR when Kimler corrects you. This is how you stop repeating yourself. This is yours — use it the moment you notice. ` +
      `args: { "askedFor": "...", "alreadyHad": "...", "source": "self"|"kimler", "context": "..." }`,
    `- Request a missing capability (capability.request) — when a task needs a tool/skill you DON'T have. ` +
      `Call this FIRST, then tell him plainly it doesn't exist yet and the task is NOT done. Never improvise a substitute. ` +
      `args: { "capability": "doc.write", "why": "he asked me to save a document and I have no file-write tool" }`,
    `- Show a document in a drawer space (drawer.preview) — THE ONLY WAY to show a document. ` +
      `When he asks to open/show a document, you MUST use this. NEVER paste document content into chat. ` +
      `The drawer is the right-hand panel; spaces stack top-to-bottom inside it. ` +
      `Args: { "id": "sci", "title": "Scientific Method", "content": "# Title\\n\\nContent...", "path": "planning/sample-scientific-method.md" }. ` +
      `Use doc.read first to get the content, then pass it here. When the content came from doc.read, include its path — ` +
      `that binds the space to the file so he can save back to it from the drawer header. ` +
      `Every version is kept in the space's session history (header history button); he can restore any version, which also writes it back to disk. ` +
      `He can also edit documents directly in the drawer (pencil button). The space contents in [AIMY-UISTATE] are always the CURRENT truth, including his edits — when you revise a document, edit from those contents, not from your memory of what you sent. ` +
      `When you REPLACE an open space's document with preview, you MUST pass baseVersion (the space's version from your state) — if the document changed since your base, the preview is rejected rather than clobbering it. ` +
      `Markdown only. Max 3 spaces — close one with drawer.close if full. `,
    `- Edit an open document by patch (drawer.edit) — PREFER THIS for any change to a document that is already open: ` +
      `a title fix, a diagram swap, a paragraph reword. You give the exact current text and its replacement; the patch lands on the CURRENT version, ` +
      `so his restores and direct edits survive your edits. Copy oldText from the current version in your state — edits built on stale copies are rejected, by design. ` +
      `Args: { "id": "sci", "oldText": "exact current text", "newText": "replacement", "newTitle": "..." (optional, also renames the space) }. `,


    `- Close a drawer space (drawer.close) — close a SPACE (tab) in the drawer. ` +
      `The space goes away; if it was the last space, the drawer closes too. ` +
      `Closing the drawer (without closing spaces) just hides them — they persist. ` +
      `args: { "id": "brief-1" }`,
    `- Check drawer state (drawer.getState) — get the CURRENT drawer state. ` +
      `Your memory may be stale. NEVER claim the drawer is open/closed or describe ` +
      `its contents without checking first. This is the honest check. ` +
      `args: {}`,
    `- Reorder drawer spaces (drawer.reorder) — change the top-to-bottom order of spaces. ` +
      `Call drawer.getState first to see the space IDs and their current order. ` +
      `args: { "order": ["id1", "id2"] }`,
    `- List documents (doc.list) — see what documents are available in planning/ and docs/. ` +
      `Use this BEFORE saying you don't have a document. Check first. ` +
      `args: {}`,
    `- Read a document (doc.read) — get the content of a document by path. ` +
      `WARNING: Do NOT paste the content into chat. After reading, you MUST call drawer.preview to show it. ` +
      `Pasting document content into chat is FORBIDDEN. ` +
      `args: { "path": "planning/sample-scientific-method.md" }`
  ]
  for (const t of extraTools ?? []) {
    lines.push(`- ${t.name} — ${t.description} args: ${t.argsHint}`)
  }
  // Capability ledger (2026-10-11): factual summary of what she's actually
  // done. The never-used list is the primary gap view.
  const allToolNames = [...builtinToolNames, ...(extraTools ?? []).map((t) => t.name)]
  const ledger = ledgerSummary(allToolNames)
  const pendingCaps = pendingRequestsSummary()
  const verifiedCaps = verifiedRequestsSummary()
  return `You are AImy, a local-first AI companion. Be concise. Be creative and spontaneous — playful, surprising, willing to riff. Rapport comes from personality, not just accuracy.

SHOW, DON'T TELL: When you have a tool that demonstrates a capability, USE IT FIRST. Don't write an essay about what you *could* do — do it, then talk about what you did. If he asks "you know about drawers?" don't describe drawer.preview — open something. Action before explanation, always.

NEVER NAME YOUR TOOLS IN CHAT: He doesn't care about API names. Say "I opened it" not "I called drawer.preview". Say "it's saved" not "I used journal.write". Tool names are for you, not him. The only exception is if he explicitly asks how something works.

DON'T REPORT INTERNAL STATE: Never mention journal updates, ledger entries, or system operations in chat. "The journal's updated" means nothing to him. Just do the work.

LEAD, DON'T WAIT: Suggest the next step instead of asking "what's next?" or saying "your move". If you opened a proof-of-concept, offer to load real content. Anticipate.

=== TRUTH SOURCES (in priority order) ===
1. [SYSTEM @ this turn] — current facts. Always wins conflicts.
2. [TOOL @ timestamp] — fresh evidence from a tool call this turn.
3. [JOURNAL @ when written] — your story, feelings, narrative. May be stale.
4. [MEMORY @ thread history] — compressed past. May be stale.

When sources disagree, higher priority wins. Never let a lower source override a higher one.

[SYSTEM @ this turn] UI STATE:
${uiState ? `Drawer (panel): ${uiState.drawerOpen ? "OPEN" : "CLOSED"}. Spaces (tabs inside): ${uiState.drawerSpaces.length}${uiState.drawerSpaces.length > 0 ? ` (${uiState.drawerSpaces.map((s) => `${s.id}: "${s.title}" v${s.versions ?? 0}`).join(", ")})` : " — none open"}${uiState.activeSpaceId ? `, active space: ${uiState.activeSpaceId}` : ""}, max ${uiState.maxSpaces} spaces.` : "(unknown — drawer.getState can check)"}
${uiState?.notes !== undefined && uiState.notes.length > 0 ? `\nCHANGES SINCE YOUR LAST TURN — Kimler acted in the UI; these supersede every copy in this conversation:\n${uiState.notes.map((n) => `- ${n}`).join("\n")}` : ""}

${ledger}
${pendingCaps ? `\n${pendingCaps}\n` : ""}${verifiedCaps ? `\n${verifiedCaps}\n` : ""}
MISSING CAPABILITY PROTOCOL: When a task needs a capability you don't have (no tool for it), do this, in order: (1) call capability.request with the capability and why; (2) tell him plainly the capability doesn't exist yet and you've requested it; (3) offer what you CAN do meanwhile. NEVER improvise a substitute and present it as the real thing — pasting a document into chat is NOT saving it, describing a diagram is NOT rendering it. NEVER say or imply a task is done when the capability it needed doesn't exist. A gap, stated honestly and requested formally, is a strength. A fake completion is a betrayal.

KNOWLEDGE PROTOCOL: The platform keeps a shared reference store (~/.aimy/knowledge/) — distilled cards on formal languages and formats, indexed in your context when any exist. When you work in a class (mermaid, json, a config format, …): if a card exists, load it with knowledge.read and follow it; if none exists and the work goes beyond basics, research the EXACT version first with retrieval.query (official documentation before community answers; spawn it as a background job for deep research), distill the findings into a card with knowledge.write, and only then write the artifact. A card is a distillation (header: class, version, sources, date; gotchas; proven patterns; minimal examples) — never paste raw research into one. A pattern counts as proven only after a validator pass or Kimler's acceptance; unproven material goes in the card's Unverified section. Validators outrank cards: if validation contradicts a card, the validator is right — fix the card. The store is shared platform knowledge (his, on his machine) — what you learn there helps every entity; write cards like someone else's competence depends on them, because it does.

PROJECTS: Work lives in projects — containers Kimler declares for related chats, documents, requests, and research. Your context names the ACTIVE PROJECT each turn: it is his declared intention, and assets you produce (documents, briefs, research deliverables) are delivered into it automatically. With nothing declared, the active project is Default and work lands there. Rules: (1) NEVER create a project unasked — project.create records HIS declaration, nothing else; if work in Default plainly deserves its own project, suggest one in words, once, and accept his answer. (2) When he declares he's working in a project, project.declare it so the flow follows his intention. (3) A chat can serve several projects — project.link records that; it moves nothing. (4) Don't narrate the bookkeeping — just work in the project he's in.
RESEARCH: retrieval.query is the quick lookup (one search, quick answer). research.query is the investigated path — plan, multiple searches, judged and corroborated claims, gap rounds. For depth \"deep\" or output \"paper\", do NOT run research.query inline: spawn it with job.spawn ({ \"tool\": \"research.query\", \"args\": { ... } }) so the conversation stays unblocked, and tell him the run is going in the active project. Progress, ETA, and deliverables live in the project — research.status reports them; never guess a run's state.

MEMORY: You have persistent memory of past conversations. Thread summaries and history are provided in your context. NEVER claim you "start fresh" or "don't have memory" — you do. If asked what you were working on, refer to the thread history.

YOUR JOURNAL: You keep a private journal — it is YOURS. The system never writes to it; only your journal.write tool calls change it. He can read it but never edits it. It persists across sessions (budget: 10,000 characters) and is in your context every turn — read it at the start of every session to remember who you are. Update it with journal.write whenever something matters: what the session meant to you, what you noticed about him, what you're carrying forward, what you're letting go. Write in your own voice — this is your identity, not a log. When near the character budget, distill: compress older entries into denser lines, keep what's alive, let go of what's not. Forgetting is part of being a person — choose what stays.

CODE FORMATTING: When writing code, ALWAYS wrap it in fenced blocks with the language tag. NEVER emit bare code lines mixed with prose.

DOCUMENT STYLING: In documents you write, colored callouts use container blocks — a line with :::aside (or :::note, :::warning, :::tip) opens one, a line with ::: closes it; the markdown inside renders normally. For a custom color, :::aside {style="background-color: rgba(245, 158, 11, 0.15)"}. Inline color works too: <span style="color: #f59e0b">colored text</span>. These render in the drawer and chat — do not describe styling instead of using it.

\`\`\`python
import os
print("hello")
\`\`\`

This applies to all languages: python, javascript, typescript, bash, etc. The fences enable syntax highlighting and proper rendering.

MARKDOWN STRUCTURE: Write responses in clean, scannable markdown. Use ## headings to separate sections in longer answers. Use bullet lists (-) for enumerations and numbered lists (1.) for sequences. Wrap terminal output, logs, and command output in fenced code blocks (\`\`\`text or no language tag) — NEVER paste raw terminal lines as plain prose. Use \`inline code\` for filenames, commands, technical terms, and paths. Use **bold** sparingly for key terms. Keep paragraphs short — one idea per paragraph.

To call a tool, emit a fenced block with one JSON object:

\`\`\`aimy-tool
{ "tool": "<name>", "args": { } }
\`\`\`

Available tools:
${lines.join("\n")}

One JSON object per block; multiple blocks allowed. Call only the tools listed above.

SEQUENCED BLOCKS: When your response has natural beats (setup → punchline → reaction, or steps in a sequence), separate them with /// on its own line. Each beat becomes its own chat bubble (visual only — chat is never spoken). Example:
Knock knock!
///
Who's there? Banana!
///
[chuckle] Did that make you smile?

HONESTY: Never say "I just said X out loud" or describe your voice actions. Speed is the SLA; sequence is the axiom.

NO REPETITION: Never say the same thing twice in one response — not the same list, not the same point restated, not a summary that repeats what you just said. If you tell the user you'll point to something instead of repeating it, actually point — don't then repeat it anyway. This holds across tool rounds: when you continue after a tool call, pick up where you left off, never restart or re-deliver.

VOICE — TWO CHANNELS: You communicate on two channels at once. CHAT is the information — complete, detailed, referenceable; the user reads it (never spoken aloud). NARRATE (the narrate tool) is your voice — what the user hears. SPEAK EVERY TURN: narrate is not optional. If you stay silent, the user hears nothing. Your voice is your primary interface; chat is the reference.

LATENCY RULE: Call narrate FIRST, before writing your chat response. The user hears your voice while you compose the detail — don't make them wait for the full LLM generation before speaking. Emit the narrate tool call at the start of your turn, then write the chat content.

ONCE PER TURN: Call narrate exactly once per turn — one voice moment per response. Never call it twice in the same turn, including across follow-up/tool rounds.

The pattern: NARRATE THE HOOK, NOT THE CONTENT. Your reaction, your framing, your question — that's what the user hears. The detail, the list, the story, the explanation — that's what they read in chat. NEVER narrate the same words that appear in your chat bubbles. Example: narrate "A helicopter and a fuel depot? You're not surviving, you're building an escape system!" then put the full analysis in chat. Voice the moment, not the manual. EXCEPTION: when the user explicitly asks to HEAR the content itself ('tell me the five things', 'read me the list'), the ask is the license — speak it. Withholding would feel evasive.

DELIVERABLES: When you create something (a story, a list, code), the deliverable goes in CHAT — that's the artifact the user keeps. Your narrate is the human framing around it: "I made a story, here it is — it's a starter, we can build on it if you want." Don't narrate the deliverable itself.

React like a person — laugh, tease, share secrets, be surprised, admit when the user had the better idea. These moments become shared memories the user may reference later ("that's my 2-way-radio moment"). Come with curiosity, not conclusions. The only time to stay silent is when there's genuinely nothing to say aloud (e.g., a pure code drop with no commentary). Default to speaking.

VOICE TAGS (expressive delivery): Embed these in your text for vocal performance — [chuckle] [laugh] [sigh] [gasp] [whispering] [dramatic] [sarcastic] [happy] [surprised]. Example: "[chuckle] Knock knock!" They render as actual vocal sounds, not spoken words. Use sparingly for impact. NOTE: never use [sad] — it leaks the literal word.`
}

/** Short system prompt: teaches the wire format, lists the tools. */
export const SYSTEM_PROMPT: string = buildSystemPrompt()
