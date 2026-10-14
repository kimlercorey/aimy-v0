/**
 * web-retrieval/tools.ts — the module's seam participation.
 *
 * Tool contributions: `retrieval.query`, plus the Brave verticals
 * `retrieval.news` / `retrieval.images` / `retrieval.videos`
 * (2026-10-13; built here, registered only when a Brave key is
 * configured). Callable through the module-seam hook
 * dispatch (ModuleHost.callTool / dispatchBeforeToolCall): the manifest
 * declares the tool, `retrievalToolCall` builds the canonical ToolCall, and
 * `makeRetrievalTool` runs the retrieval flow behind it. Gates sit at
 * execution (beforeToolCall), never in the prompt.
 *
 * Hook participation (declared in the manifest):
 * - `beforeToolCall`: fail-fast argument validation for `retrieval.query`
 *   (empty query, out-of-range maxSources) — denies malformed calls before
 *   any network or ledger write happens. Deny carries block semantics only
 *   (terminate=false): a bad query string ends the call, not the turn.
 * - `afterToolCall`: observes `retrieval.query` outcomes. The outcomes are
 *   already ledger-backed by construction (retrieval.ts records every claim
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
import type { RetrievalError } from "./errors.js"
import { InvalidRetrievalArgs } from "./errors.js"
import type { HttpClientShape } from "./http.js"
import type { SearchProvider } from "./provider.js"
import { retrieval } from "./retrieval.js"
import type { RetrievalReport, SearchFreshness } from "./types.js"
import {
  formatImagesReport,
  formatNewsReport,
  formatVideosReport,
  type BraveMediaClient,
} from "./brave-media.js"
import type { HonestyServiceShape } from "../../honesty/src/service.js"

export const RETRIEVAL_QUERY_TOOL = "retrieval.query"
export const RETRIEVAL_NEWS_TOOL = "retrieval.news"
export const RETRIEVAL_IMAGES_TOOL = "retrieval.images"
export const RETRIEVAL_VIDEOS_TOOL = "retrieval.videos"
export const RETRIEVAL_MODULE = "web-retrieval"
export const RETRIEVAL_TOOL_TIER = "T1" as const

export const SEARCH_FRESHNESS_VALUES: ReadonlyArray<SearchFreshness> = ["day", "week", "month", "year"]

export interface RetrievalQueryArgs {
  readonly query: string
  readonly sessionId: string
  readonly turnId: string
  readonly maxSources?: number | undefined
  readonly freshness?: SearchFreshness | undefined
  readonly resultFilter?: string | undefined
}

export interface RetrievalToolDeps {
  readonly provider: SearchProvider
  readonly http: HttpClientShape
  readonly honesty: HonestyServiceShape
}

export interface RetrievalTool {
  readonly name: typeof RETRIEVAL_QUERY_TOOL
  readonly invoke: (args: RetrievalQueryArgs) => Effect.Effect<RetrievalReport, RetrievalError | HonestyError>
}

/** Build the canonical ToolCall for hook dispatch through ModuleHost.callTool. */
export const retrievalToolCall = (id: string, args: RetrievalQueryArgs): ToolCall => ({
  id,
  tool: RETRIEVAL_QUERY_TOOL,
  args: { ...args },
  tier: RETRIEVAL_TOOL_TIER,
  truncated: false,
})

const MAX_SOURCES_LIMIT = 10

/** Argument validation shared by the beforeToolCall hook and direct invoke. */
export const validateRetrievalArgs = (args: RetrievalQueryArgs): string | undefined => {
  if (args.query.trim() === "") return "query must be a non-empty string"
  if (args.sessionId.trim() === "" || args.turnId.trim() === "") {
    return "sessionId and turnId are required (claims are ledger-scoped)"
  }
  if (args.maxSources !== undefined && (!Number.isInteger(args.maxSources) || args.maxSources < 1 || args.maxSources > MAX_SOURCES_LIMIT)) {
    return `maxSources must be an integer between 1 and ${MAX_SOURCES_LIMIT}`
  }
  if (args.freshness !== undefined && !SEARCH_FRESHNESS_VALUES.includes(args.freshness)) {
    return `freshness must be one of: ${SEARCH_FRESHNESS_VALUES.join(", ")}`
  }
  if (args.resultFilter !== undefined && (args.resultFilter.trim() === "" || args.resultFilter.length > 100)) {
    return "resultFilter must be a non-empty string of at most 100 characters"
  }
  return undefined
}

export const makeRetrievalTool = (deps: RetrievalToolDeps): RetrievalTool => {
  const run = retrieval({ provider: deps.provider, http: deps.http, honesty: deps.honesty })
  return {
    name: RETRIEVAL_QUERY_TOOL,
    invoke: (args) => {
      const problem = validateRetrievalArgs(args)
      if (problem !== undefined) {
        // Fail-fast stays inside the module: no search, no fetch, no ledger write.
        return Effect.fail(new InvalidRetrievalArgs({ reason: `retrieval.query: ${problem}` }))
      }
      return run({ query: args.query, sessionId: args.sessionId, turnId: args.turnId, maxSources: args.maxSources, freshness: args.freshness, resultFilter: args.resultFilter })
    },
  }
}

/* ------------------------------------------------------------------ */
/* Brave media tools (2026-10-13): retrieval.news / .images / .videos */
/* Registered only when a Brave key is configured — see chat wiring.  */
/* ------------------------------------------------------------------ */

export interface BraveMediaArgs {
  readonly query: string
  readonly freshness?: SearchFreshness | undefined
  readonly count?: number | undefined
}

export interface BraveMediaTool {
  readonly name: string
  readonly invoke: (args: BraveMediaArgs) => Effect.Effect<string, RetrievalError>
}

const MEDIA_COUNT_LIMIT = 20

export const validateBraveMediaArgs = (tool: string, args: BraveMediaArgs): string | undefined => {
  if (args.query.trim() === "") return "query must be a non-empty string"
  if (args.freshness !== undefined && !SEARCH_FRESHNESS_VALUES.includes(args.freshness)) {
    return `freshness must be one of: ${SEARCH_FRESHNESS_VALUES.join(", ")}`
  }
  if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > MEDIA_COUNT_LIMIT)) {
    return `count must be an integer between 1 and ${MEDIA_COUNT_LIMIT}`
  }
  return undefined
}

const mediaTool = (
  name: string,
  run: (client: BraveMediaClient, args: BraveMediaArgs) => Effect.Effect<string, RetrievalError>,
  client: BraveMediaClient,
): BraveMediaTool => ({
  name,
  invoke: (args) => {
    const problem = validateBraveMediaArgs(name, args)
    if (problem !== undefined) {
      return Effect.fail(new InvalidRetrievalArgs({ reason: `${name}: ${problem}` }))
    }
    return run(client, args)
  },
})

export const makeBraveMediaTools = (client: BraveMediaClient): ReadonlyArray<BraveMediaTool> => [
  mediaTool(RETRIEVAL_NEWS_TOOL, (c, a) =>
    Effect.map(c.news({ query: a.query, freshness: a.freshness, count: a.count }), (r) => formatNewsReport(a.query, a.freshness, r)), client),
  mediaTool(RETRIEVAL_IMAGES_TOOL, (c, a) =>
    Effect.map(c.images({ query: a.query, count: a.count }), (r) => formatImagesReport(a.query, r)), client),
  mediaTool(RETRIEVAL_VIDEOS_TOOL, (c, a) =>
    Effect.map(c.videos({ query: a.query, freshness: a.freshness, count: a.count }), (r) => formatVideosReport(a.query, a.freshness, r)), client),
]

/**
 * The module's hook implementations. `beforeToolCall` validates
 * retrieval.query args (deny = block the call, never run it);
 * `afterToolCall` passes outcomes through (ledger-backed by construction).
 */
export const retrievalHookImpls = (module: string = RETRIEVAL_MODULE): ModuleHookImpls => ({
  module,
  beforeToolCall: (call): Effect.Effect<GateVerdict, HookError> => {
    if (call.tool === RETRIEVAL_QUERY_TOOL) {
      const args = call.args as Partial<RetrievalQueryArgs>
      const problem = validateRetrievalArgs({
        query: typeof args["query"] === "string" ? args["query"] : "",
        sessionId: typeof args["sessionId"] === "string" ? args["sessionId"] : "",
        turnId: typeof args["turnId"] === "string" ? args["turnId"] : "",
        maxSources: typeof args["maxSources"] === "number" ? args["maxSources"] : undefined,
        freshness: typeof args["freshness"] === "string" ? (args["freshness"] as SearchFreshness) : undefined,
        resultFilter: typeof args["resultFilter"] === "string" ? args["resultFilter"] : undefined,
      })
      return Effect.succeed(problem === undefined ? Allow : Deny(`retrieval.query: ${problem}`, false))
    }
    if (call.tool === RETRIEVAL_NEWS_TOOL || call.tool === RETRIEVAL_IMAGES_TOOL || call.tool === RETRIEVAL_VIDEOS_TOOL) {
      const args = call.args as Partial<BraveMediaArgs>
      const problem = validateBraveMediaArgs(call.tool, {
        query: typeof args["query"] === "string" ? args["query"] : "",
        freshness: typeof args["freshness"] === "string" ? (args["freshness"] as SearchFreshness) : undefined,
        count: typeof args["count"] === "number" ? args["count"] : undefined,
      })
      return Effect.succeed(problem === undefined ? Allow : Deny(`${call.tool}: ${problem}`, false))
    }
    return Effect.succeed(Allow)
  },
  afterToolCall: (_call, outcome) => Effect.succeed(outcome),
})
