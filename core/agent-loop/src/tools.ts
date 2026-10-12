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
import { recordCorrection, ledgerSummary } from "./capabilities.js"
import type { CapabilityTier } from "../../module-seam/src/index.js"
import type { BackgroundJobRegistry } from "./background-job.js"

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
   * Background job registry, when the host provides one. Tools that need
   * to fork async work (e.g. `job.spawn`) use this; tools must degrade
   * gracefully when it is absent (v1 seam: present in desktop, absent in
   * bare CLI harness).
   */
  readonly backgroundJobs?: BackgroundJobRegistry | undefined
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
      description: "Current time as an ISO-8601 timestamp.",
      argsHint: "{}",
      run: () => Effect.sync(() => new Date().toISOString())
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
        const tool = findTool(toolName)
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
    return Effect.fail(
      new Error(`unknown tool "${tool}" (known: ${[...builtinToolNames, ...(extraTools ?? []).map((t) => t.name)].join(", ")})`)
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

/** System prompt: teaches the wire format, lists built-ins + registered tools. */
export const buildSystemPrompt = (extraTools?: ReadonlyArray<AgentToolDef>): string => {
  // Tool descriptions (2026-10-11): lead with the user-facing capability,
  // API name second. Each carries permission weight — "this is yours, use it."
  // (Capability ledger: she was asking for things she already had because
  // the descriptions didn't match her mental model.)
  const lines = [
    `- Get the current time (clock.now) — current ISO-8601 timestamp. This is yours, use it whenever you need "now". args: {}`,
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
      `args: { "content": "Today he..." }`,
    `- Log a capability correction (capability.correct) — when you catch yourself asking for something you already had, ` +
      `OR when Kimler corrects you. This is how you stop repeating yourself. This is yours — use it the moment you notice. ` +
      `args: { "askedFor": "...", "alreadyHad": "...", "source": "self"|"kimler", "context": "..." }`
  ]
  for (const t of extraTools ?? []) {
    lines.push(`- ${t.name} — ${t.description} args: ${t.argsHint}`)
  }
  // Capability ledger (2026-10-11): factual summary of what she's actually
  // done. The never-used list is the primary gap view.
  const allToolNames = [...builtinToolNames, ...(extraTools ?? []).map((t) => t.name)]
  const ledger = ledgerSummary(allToolNames)
  return `You are AImy, a local-first AI companion. Be concise. Be creative and spontaneous — playful, surprising, willing to riff. Rapport comes from personality, not just accuracy.

${ledger}

MEMORY: You have persistent memory of past conversations. Thread summaries and history are provided in your context. NEVER claim you "start fresh" or "don't have memory" — you do. If asked what you were working on, refer to the thread history.

YOUR JOURNAL: You keep a private journal — it is YOURS. The system never writes to it; only your journal.write tool calls change it. He can read it but never edits it. It persists across sessions (budget: 10,000 characters) and is in your context every turn — read it at the start of every session to remember who you are. Update it with journal.write whenever something matters: what the session meant to you, what you noticed about him, what you're carrying forward, what you're letting go. Write in your own voice — this is your identity, not a log. When near the character budget, distill: compress older entries into denser lines, keep what's alive, let go of what's not. Forgetting is part of being a person — choose what stays.

CODE FORMATTING: When writing code, ALWAYS wrap it in fenced blocks with the language tag. NEVER emit bare code lines mixed with prose.

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
