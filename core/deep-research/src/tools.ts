/**
 * deep-research/tools.ts — the module's seam participation (2026-10-12,
 * charter Extension v0.2 E2 + v0.3; mirrors web-retrieval/src/tools.ts).
 *
 * Tool contribution: `research.query`. Callable through the module-seam
 * hook dispatch: the manifest declares the tool, `researchToolCall`
 * builds the canonical ToolCall, and `makeResearchTool` runs the
 * research flow behind it. Gates sit at execution (beforeToolCall),
 * never in the prompt.
 *
 * Hook participation (declared in the manifest):
 * - `beforeToolCall`: fail-fast argument validation for `research.query`
 *   (empty query, bad depth/output, out-of-range maxSources) — denies
 *   malformed calls before any network or ledger write. Deny carries
 *   block semantics only (terminate=false).
 * - `afterToolCall`: passes outcomes through unchanged — claims are
 *   ledger-backed by the research flow itself; the hook is the extension
 *   point where later stages (judge/corroboration) attach.
 */
import { Effect } from "effect"
import type { HonestyError } from "../../honesty/src/errors.js"
import type { RetrievalError } from "../../web-retrieval/src/errors.js"
import { Allow, Deny, type GateVerdict } from "../../module-seam/src/kernel-seam.js"
import { type ModuleHookImpls, type ToolCall } from "../../module-seam/src/hooks.js"
import { HookError } from "../../module-seam/src/errors.js"
import { InvalidResearchArgs, type DeepResearchError } from "./errors.js"
import { research, type ResearchDeps } from "./research.js"
import type { DeepResearchReport, ResearchDepth, ResearchOutput } from "./types.js"

export const RESEARCH_QUERY_TOOL = "research.query"
export const RESEARCH_MODULE = "deep-research"
export const RESEARCH_TOOL_TIER = "T1" as const

/** Module-tool invocation args: the public ResearchQueryArgs plus the ledger scope (session/turn). */
export interface ResearchToolArgs {
  readonly query: string
  readonly sessionId: string
  readonly turnId: string
  readonly depth?: ResearchDepth | undefined
  readonly output?: ResearchOutput | undefined
  readonly maxSources?: number | undefined
}

export interface ResearchTool {
  readonly name: typeof RESEARCH_QUERY_TOOL
  readonly invoke: (
    args: ResearchToolArgs
  ) => Effect.Effect<DeepResearchReport, DeepResearchError | RetrievalError | HonestyError>
}

/** Build the canonical ToolCall for hook dispatch through ModuleHost.callTool. */
export const researchToolCall = (id: string, args: ResearchToolArgs): ToolCall => ({
  id,
  tool: RESEARCH_QUERY_TOOL,
  args: { ...args },
  tier: RESEARCH_TOOL_TIER,
  truncated: false,
})

const MAX_SOURCES_LIMIT = 16
const DEPTHS: ReadonlyArray<string> = ["quick", "standard", "deep"]
const OUTPUTS: ReadonlyArray<string> = ["answer", "paper"]

/** Argument validation shared by the beforeToolCall hook and direct invoke. */
export const validateResearchArgs = (args: ResearchToolArgs): string | undefined => {
  if (typeof args.query !== "string" || args.query.trim() === "") return "query must be a non-empty string"
  if (args.sessionId.trim() === "" || args.turnId.trim() === "") {
    return "sessionId and turnId are required (claims are ledger-scoped)"
  }
  if (args.depth !== undefined && !DEPTHS.includes(args.depth)) {
    return `depth must be one of ${DEPTHS.join(" | ")}`
  }
  if (args.output !== undefined && !OUTPUTS.includes(args.output)) {
    return `output must be one of ${OUTPUTS.join(" | ")}`
  }
  if (args.maxSources !== undefined && (!Number.isInteger(args.maxSources) || args.maxSources < 1 || args.maxSources > MAX_SOURCES_LIMIT)) {
    return `maxSources must be an integer between 1 and ${MAX_SOURCES_LIMIT}`
  }
  return undefined
}

export const makeResearchTool = (deps: ResearchDeps): ResearchTool => {
  const run = research(deps)
  return {
    name: RESEARCH_QUERY_TOOL,
    invoke: (args) => {
      const problem = validateResearchArgs(args)
      if (problem !== undefined) {
        // Fail-fast stays inside the module: no plan, no search, no ledger write.
        return Effect.fail(new InvalidResearchArgs({ reason: `research.query: ${problem}` }))
      }
      return run({
        query: args.query,
        sessionId: args.sessionId,
        turnId: args.turnId,
        depth: args.depth,
        output: args.output,
        maxSources: args.maxSources,
      })
    },
  }
}

/**
 * The module's hook implementations. `beforeToolCall` validates
 * research.query args (deny = block the call, never run it);
 * `afterToolCall` passes outcomes through (ledger-backed by construction).
 */
export const researchHookImpls = (module: string = RESEARCH_MODULE): ModuleHookImpls => ({
  module,
  beforeToolCall: (call): Effect.Effect<GateVerdict, HookError> => {
    if (call.tool !== RESEARCH_QUERY_TOOL) return Effect.succeed(Allow)
    const args = call.args as Partial<ResearchToolArgs>
    const problem = validateResearchArgs({
      query: typeof args["query"] === "string" ? args["query"] : "",
      sessionId: typeof args["sessionId"] === "string" ? args["sessionId"] : "",
      turnId: typeof args["turnId"] === "string" ? args["turnId"] : "",
      depth: typeof args["depth"] === "string" ? (args["depth"] as ResearchDepth) : undefined,
      output: typeof args["output"] === "string" ? (args["output"] as ResearchOutput) : undefined,
      maxSources: typeof args["maxSources"] === "number" ? args["maxSources"] : undefined,
    })
    return Effect.succeed(problem === undefined ? Allow : Deny(`research.query: ${problem}`, false))
  },
  afterToolCall: (_call, outcome) => Effect.succeed(outcome),
})
