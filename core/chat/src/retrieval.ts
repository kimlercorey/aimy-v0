/**
 * chat/src/retrieval.ts — the M4 Track 3 chat extension: "retrieval <query>".
 *
 * Additive wiring only: no core lib's public contract is changed here. The
 * web-retrieval module is installed from its REAL SKILL.md (packageModule,
 * tier T1), enabled, and started on the chat's ModuleHost; one "retrieval
 * <query>" line runs through the full seam — manifest enforcement, module
 * hooks (before/afterToolCall), DirectGate execution — and the retrieval
 * tool records every claim in the shared HonestyService ledger.
 *
 * The module's SKILL.md declares exactly one static egress host
 * (html.duckduckgo.com); result URLs are governed by the declared fetch
 * policy (https-only, result-hosts-only), enforced before any socket opens.
 */
import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import type { HonestyError } from "../../honesty/src/errors.js"
import type { HonestyServiceShape } from "../../honesty/src/service.js"
import type { AgentToolDef } from "../../agent-loop/src/tools.js"
import {
  type HookError,
  type ModuleError,
  type ModuleHostApi,
  type ModulePackage,
  type PermissionDenied,
  type TrustDecisionRequired,
  type TurnTerminated,
  packageModule
} from "../../module-seam/src/index.js"
import type { SandboxViolation } from "../../substrate/errors.js"
import type { HttpClientShape } from "../../web-retrieval/src/http.js"
import { RETRIEVAL_QUERY_TOOL, RETRIEVAL_TOOL_TIER } from "../../web-retrieval/src/tools.js"
import {
  RETRIEVAL_MODULE,
  makeDuckDuckGoHtmlProvider,
  makeRetrievalTool,
  retrievalToolCall,
  type RetrievalError,
  type RetrievalReport,
  type RetrievalTool
} from "../../web-retrieval/src/index.js"

export type { RetrievalTool }

export { RETRIEVAL_MODULE }

/** Capability tier the chat runs the web-retrieval module at (T1: DirectGate). */
export const RETRIEVAL_TIER = "T1" as const

/** Filesystem location of the packaged web-retrieval SKILL.md (this repo). */
export const webRetrievalDir = (): string =>
  fileURLToPath(new URL("../../web-retrieval", import.meta.url))

/** Install + enable + start web-retrieval from its SKILL.md. Atomic install. */
export const bootRetrievalModule = (
  host: ModuleHostApi,
  dir: string = webRetrievalDir()
): Effect.Effect<ModulePackage, ModuleError | SandboxViolation | TrustDecisionRequired> =>
  Effect.gen(function* () {
    const pkg = yield* packageModule(dir, { tier: RETRIEVAL_TIER })
    yield* host.install(pkg)
    yield* host.enable(RETRIEVAL_MODULE)
    yield* host.start(RETRIEVAL_MODULE)
    return pkg
  })

/** The retrieval tool bound to the chat's HTTP + honesty services. */
export const makeRetrievalToolForChat = (
  http: HttpClientShape,
  honesty: HonestyServiceShape
): RetrievalTool =>
  makeRetrievalTool({ provider: makeDuckDuckGoHtmlProvider({ http }), http, honesty })

/**
 * The retrieval tool as a MODEL-CALLABLE agent tool (not just the CLI
 * `retrieval <query>` prefix). Shared by the CLI chat and the desktop engine:
 * one tool definition, one description, so the model sees the same contract
 * everywhere. `getTool` closes over the boot-stashed tool ref — the loop only
 * runs tools during chat, after boot. invoke() is called directly, NOT via
 * host.callTool: the loop's runTurn already dispatches
 * beforeToolCall/afterToolCall hooks, and double dispatch would double-fire
 * the module's hooks.
 */
export const makeRetrievalAgentTool = (
  getTool: () => RetrievalTool | undefined
): AgentToolDef => ({
  name: RETRIEVAL_QUERY_TOOL,
  tier: RETRIEVAL_TOOL_TIER,
  description:
    "Search the public web and return a sourced answer where every factual claim carries a verification badge ([verified]/[unverified]/[failed]). Use this when the user asks about current events, facts beyond training data, or anything needing up-to-date or external information — never claim you lack web access while this tool is listed.",
  argsHint: '{ "query": "<search query>", "maxSources": 3 }',
  run: (args, ctx) => {
    const tool = getTool()
    if (tool === undefined) return Effect.fail(new Error("retrieval module is not booted"))
    const query = typeof args["query"] === "string" ? args["query"] : ""
    const maxSources = typeof args["maxSources"] === "number" ? args["maxSources"] : undefined
    return Effect.map(
      tool.invoke({ query, sessionId: ctx.sessionId, turnId: ctx.turnId, maxSources }),
      (report) => report.answer
    )
  }
})

/** Every typed failure one retrieval pass can produce. */
export type RetrievalViaSeamError =
  | RetrievalError
  | HonestyError
  | PermissionDenied
  | TurnTerminated
  | HookError
  | SandboxViolation
  | ModuleError

/**
 * One "retrieval <query>" through the full seam: manifest check, module
 * hooks, DirectGate execution, claims in the shared honesty ledger.
 */
export const retrievalViaSeam = (
  host: ModuleHostApi,
  tool: RetrievalTool,
  query: string,
  sessionId: string,
  turnId: string
): Effect.Effect<RetrievalReport, RetrievalViaSeamError> => {
  const args = { query, sessionId, turnId }
  return host.callTool(RETRIEVAL_MODULE, retrievalToolCall(`${turnId}:retrieval`, args), tool.invoke(args))
}
