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
 * (M4 follow-up: the model could not see module tools — `research.query`
 * existed but was only reachable via a CLI prefix command. Fixed here.)
 */
import { Effect } from "effect"
import type { CapabilityTier } from "../../module-seam/src/index.js"

/** What a tool may observe about the turn it runs in. */
export interface BuiltinToolContext {
  readonly sessionId: string
  /** Completed assistant turns in this session before the current turn. */
  readonly turnCount: number
  /** The current turn's id (for ledger attribution). */
  readonly turnId: string
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
    `- session.info — { sessionId, turnCount } for this session. args: {}`
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
