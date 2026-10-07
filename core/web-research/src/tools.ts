/**
 * web-research/tools.ts — the module's seam participation.
 *
 * Tool contribution: `research.query`. Callable through the module-seam hook
 * dispatch (ModuleHost.callTool / dispatchBeforeToolCall): the manifest
 * declares the tool, `researchToolCall` builds the canonical ToolCall, and
 * `makeResearchTool` runs the research flow behind it. Gates sit at
 * execution (beforeToolCall), never in the prompt.
 *
 * Hook participation (declared in the manifest):
 * - `beforeToolCall`: fail-fast argument validation for `research.query`
 *   (empty query, out-of-range maxSources) — denies malformed calls before
 *   any network or ledger write happens. Deny carries block semantics only
 *   (terminate=false): a bad query string ends the call, not the turn.
 * - `afterToolCall`: observes `research.query` outcomes. The outcomes are
 *   already ledger-backed by construction (research.ts records every claim
 *   through HonestyService before returning), so the hook passes the outcome
 *   through unchanged — its role is the documented extension point where a
 *   future verification arm would attach judge verdicts.
 */
import { Effect } from "effect"
import type { HonestyError } from "../../honesty/src/errors.js"
import {
  Allow,
  Deny,
  type GateVerdict,
} from "../../module-seam/src/kernel-seam.js"
import { type ModuleHookImpls, type ToolCall } from "../../module-seam/src/hooks.js"
import { HookError } from "../../module-seam/src/errors.js"
import type { ResearchError } from "./errors.js"
import { InvalidResearchArgs } from "./errors.js"
import type { HttpClientShape } from "./http.js"
import type { SearchProvider } from "./provider.js"
import { research } from "./research.js"
import type { ResearchReport } from "./types.js"
import type { HonestyServiceShape } from "../../honesty/src/service.js"

export const RESEARCH_QUERY_TOOL = "research.query"
export const RESEARCH_MODULE = "web-research"
export const RESEARCH_TOOL_TIER = "T1" as const

export interface ResearchQueryArgs {
  readonly query: string
  readonly sessionId: string
  readonly turnId: string
  readonly maxSources?: number | undefined
}

export interface ResearchToolDeps {
  readonly provider: SearchProvider
  readonly http: HttpClientShape
  readonly honesty: HonestyServiceShape
}

export interface ResearchTool {
  readonly name: typeof RESEARCH_QUERY_TOOL
  readonly invoke: (args: ResearchQueryArgs) => Effect.Effect<ResearchReport, ResearchError | HonestyError>
}

/** Build the canonical ToolCall for hook dispatch through ModuleHost.callTool. */
export const researchToolCall = (id: string, args: ResearchQueryArgs): ToolCall => ({
  id,
  tool: RESEARCH_QUERY_TOOL,
  args: { ...args },
  tier: RESEARCH_TOOL_TIER,
  truncated: false,
})

const MAX_SOURCES_LIMIT = 10

/** Argument validation shared by the beforeToolCall hook and direct invoke. */
export const validateResearchArgs = (args: ResearchQueryArgs): string | undefined => {
  if (args.query.trim() === "") return "query must be a non-empty string"
  if (args.sessionId.trim() === "" || args.turnId.trim() === "") {
    return "sessionId and turnId are required (claims are ledger-scoped)"
  }
  if (args.maxSources !== undefined && (!Number.isInteger(args.maxSources) || args.maxSources < 1 || args.maxSources > MAX_SOURCES_LIMIT)) {
    return `maxSources must be an integer between 1 and ${MAX_SOURCES_LIMIT}`
  }
  return undefined
}

export const makeResearchTool = (deps: ResearchToolDeps): ResearchTool => {
  const run = research({ provider: deps.provider, http: deps.http, honesty: deps.honesty })
  return {
    name: RESEARCH_QUERY_TOOL,
    invoke: (args) => {
      const problem = validateResearchArgs(args)
      if (problem !== undefined) {
        // Fail-fast stays inside the module: no search, no fetch, no ledger write.
        return Effect.fail(new InvalidResearchArgs({ reason: `research.query: ${problem}` }))
      }
      return run({ query: args.query, sessionId: args.sessionId, turnId: args.turnId, maxSources: args.maxSources })
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
    const args = call.args as Partial<ResearchQueryArgs>
    const problem = validateResearchArgs({
      query: typeof args["query"] === "string" ? args["query"] : "",
      sessionId: typeof args["sessionId"] === "string" ? args["sessionId"] : "",
      turnId: typeof args["turnId"] === "string" ? args["turnId"] : "",
      maxSources: typeof args["maxSources"] === "number" ? args["maxSources"] : undefined,
    })
    return Effect.succeed(problem === undefined ? Allow : Deny(`research.query: ${problem}`, false))
  },
  afterToolCall: (_call, outcome) => Effect.succeed(outcome),
})
