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
import type { CapabilityTier } from "../../module-seam/src/index.js"
import type { BackgroundJobRegistry } from "./background-job.js"

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
}

/**
 * Minimal voice narration sink. The host adapts its real TTS queue
 * (e.g. asc-channels' NarrationQueue) to this interface.
 */
export interface NarrationSink {
  /** Queue text for speech. Returns an ID; empty string if rejected. */
  readonly enqueue: (text: string) => string
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
        "Speak a voice-only message to the user — conversational narration that does NOT appear in chat. " +
        "Use for acknowledgments ('looking into that now…'), transitions ('finished the list — want me to dig deeper?'), " +
        "emotional beats ('giggles — don't worry, it'll be quick'), and summaries while details render visually. " +
        "HUMANIZE, don't transcribe: never read code, URLs, emails, or raw data aloud. " +
        "Instead describe what it is and point to chat ('I've put the code in chat — it fetches the profile by username'). " +
        "Write what Zen would SAY out loud, conversational and natural — contractions, warmth, personality. " +
        "This is fire-and-forget: it queues for speech and returns immediately.",
      argsHint: '{ "text": "OK, looking into that now…" }',
      run: (args, ctx) => {
        const text = args["text"]
        if (typeof text !== "string" || text.trim() === "") {
          return Effect.fail(new Error("narrate: text must be a non-empty string"))
        }
        const sink = ctx.narration
        if (sink === undefined) {
          // No voice in this host — narration is a no-op, not an error.
          // The chat text still carries the information.
          console.log("[aimy] narrate called but no sink (voice not wired)")
          return Effect.succeed({ narrated: false, reason: "no narration sink in this host" })
        }
        console.log(`[aimy] narrate: enqueueing "${text.trim().substring(0, 50)}..."`)
        const id = sink.enqueue(text.trim())
        console.log(`[aimy] narrate: enqueued id=${id}`)
        return Effect.succeed({ narrated: id !== "", narrationId: id })
      }
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
  const lines = [
    `- clock.now — current ISO-8601 timestamp. args: {}`,
    `- session.info — { sessionId, turnCount } for this session. args: {}`,
    `- job.spawn — start a long-running task in the background and return immediately with a job ID. ` +
      `Use for work taking minutes (deep research) so the conversation stays unblocked. ` +
      `args: { "description": "...", "tool": "<tool-name>", "args": { }, "estimateMinutes": 30 }`,
    `- narrate — speak a voice-only message (not shown in chat). Use for acknowledgments, transitions, ` +
      `emotional beats. HUMANIZE: never read code/URLs/data aloud — describe and point to chat. ` +
      `IMPORTANT: when the user explicitly asks you to speak, say something aloud, or read text aloud, ` +
      `you MUST call this tool — do not just reply with text about speaking. ` +
      `Keep narrations SHORT (under 20 words) — long texts take 30+ seconds to synthesize. ` +
      `args: { "text": "OK, looking into that now…" }`
  ]
  for (const t of extraTools ?? []) {
    lines.push(`- ${t.name} — ${t.description} args: ${t.argsHint}`)
  }
  return `You are AImy, a local-first AI companion. Be concise.

To call a tool, emit a fenced block with one JSON object:

\`\`\`aimy-tool
{ "tool": "<name>", "args": { } }
\`\`\`

Available tools:
${lines.join("\n")}

One JSON object per block; multiple blocks allowed. Call only the tools listed above.`
}

/** Short system prompt: teaches the wire format, lists the tools. */
export const SYSTEM_PROMPT: string = buildSystemPrompt()
