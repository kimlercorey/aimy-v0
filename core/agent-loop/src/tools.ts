/**
 * tools.ts — the M1 built-in tool registry.
 *
 * Read-only, T0 tier only. The loop never executes tools itself: this
 * registry is the raw executor handed to `ModuleHooks.runTurn` as
 * `executeTool`, so every call passes the `beforeToolCall` gate (module
 * hooks + SafetyKernel) before it runs, and `afterToolCall` after.
 *
 * NO code execution, no network, no filesystem writes — that is M2/M4
 * territory and must not appear here.
 */
import { Effect } from "effect"
import type { CapabilityTier } from "../../module-seam/src/index.js"

/** What a built-in tool may observe about the turn it runs in. */
export interface BuiltinToolContext {
  readonly sessionId: string
  /** Completed assistant turns in this session before the current turn. */
  readonly turnCount: number
}

interface BuiltinToolDef {
  readonly name: string
  readonly tier: CapabilityTier
  readonly description: string
  readonly run: (
    args: Readonly<Record<string, unknown>>,
    ctx: BuiltinToolContext
  ) => Effect.Effect<unknown, never>
}

const defs: Array<[string, BuiltinToolDef]> = [
  [
    "clock.now",
    {
      name: "clock.now",
      tier: "T0",
      description: "Current time as an ISO-8601 timestamp.",
      run: () => Effect.sync(() => new Date().toISOString())
    }
  ],
  [
    "session.info",
    {
      name: "session.info",
      tier: "T0",
      description: "This session's id and completed turn count.",
      run: (_args, ctx) =>
        Effect.succeed({ sessionId: ctx.sessionId, turnCount: ctx.turnCount })
    }
  ]
]

const registry: ReadonlyMap<string, BuiltinToolDef> = new Map(defs)

/** Names the model may call, in registry order. */
export const builtinToolNames: ReadonlyArray<string> = Array.from(registry.keys())

/** Tier a parsed call is gated at. Unknown tools gate at T0 and then fail at execution. */
export const builtinToolTier = (name: string): CapabilityTier =>
  registry.get(name)?.tier ?? "T0"

/**
 * Run a built-in tool. Unknown names fail with a plain Error, which
 * `ModuleHooks.runTurn` normalizes into an `IoError` `ToolOutcome` at the
 * tool boundary — the turn records it, it never crashes.
 */
export const runBuiltinTool = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  ctx: BuiltinToolContext
): Effect.Effect<unknown, Error> => {
  const def = registry.get(tool)
  if (def === undefined) {
    return Effect.fail(
      new Error(`unknown built-in tool "${tool}" (M1 tools: ${builtinToolNames.join(", ")})`)
    )
  }
  return def.run(args, ctx)
}

/** Short system prompt: teaches the wire format, lists the tools. */
export const SYSTEM_PROMPT = `You are AImy, a local-first AI companion. Be concise.

To call a tool, emit a fenced block with one JSON object:

\`\`\`aimy-tool
{ "tool": "<name>", "args": { } }
\`\`\`

Available read-only tools:
- clock.now — current ISO-8601 timestamp. args: {}
- session.info — { sessionId, turnCount } for this session. args: {}

One JSON object per block; multiple blocks allowed. Call only the tools listed above.`
