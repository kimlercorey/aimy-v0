/**
 * chat/src/research.ts — the M4 Track 3 chat extension: "research <query>".
 *
 * Additive wiring only: no core lib's public contract is changed here. The
 * web-research module is installed from its REAL SKILL.md (packageModule,
 * tier T1), enabled, and started on the chat's ModuleHost; one "research
 * <query>" line runs through the full seam — manifest enforcement, module
 * hooks (before/afterToolCall), DirectGate execution — and the research
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
import type { HttpClientShape } from "../../web-research/src/http.js"
import { RESEARCH_QUERY_TOOL, RESEARCH_TOOL_TIER } from "../../web-research/src/tools.js"
import {
  RESEARCH_MODULE,
  makeDuckDuckGoHtmlProvider,
  makeResearchTool,
  researchToolCall,
  type ResearchError,
  type ResearchReport,
  type ResearchTool
} from "../../web-research/src/index.js"

export type { ResearchTool }

export { RESEARCH_MODULE }

/** Capability tier the chat runs the web-research module at (T1: DirectGate). */
export const RESEARCH_TIER = "T1" as const

/** Filesystem location of the packaged web-research SKILL.md (this repo). */
export const webResearchDir = (): string =>
  fileURLToPath(new URL("../../web-research", import.meta.url))

/** Install + enable + start web-research from its SKILL.md. Atomic install. */
export const bootResearchModule = (
  host: ModuleHostApi,
  dir: string = webResearchDir()
): Effect.Effect<ModulePackage, ModuleError | SandboxViolation | TrustDecisionRequired> =>
  Effect.gen(function* () {
    const pkg = yield* packageModule(dir, { tier: RESEARCH_TIER })
    yield* host.install(pkg)
    yield* host.enable(RESEARCH_MODULE)
    yield* host.start(RESEARCH_MODULE)
    return pkg
  })

/** The research tool bound to the chat's HTTP + honesty services. */
export const makeResearchToolForChat = (
  http: HttpClientShape,
  honesty: HonestyServiceShape
): ResearchTool =>
  makeResearchTool({ provider: makeDuckDuckGoHtmlProvider({ http }), http, honesty })

/**
 * The research tool as a MODEL-CALLABLE agent tool (not just the CLI
 * `research <query>` prefix). Shared by the CLI chat and the desktop engine:
 * one tool definition, one description, so the model sees the same contract
 * everywhere. `getTool` closes over the boot-stashed tool ref — the loop only
 * runs tools during chat, after boot. invoke() is called directly, NOT via
 * host.callTool: the loop's runTurn already dispatches
 * beforeToolCall/afterToolCall hooks, and double dispatch would double-fire
 * the module's hooks.
 */
export const makeResearchAgentTool = (
  getTool: () => ResearchTool | undefined
): AgentToolDef => ({
  name: RESEARCH_QUERY_TOOL,
  tier: RESEARCH_TOOL_TIER,
  description:
    "Search the public web and return a sourced answer where every factual claim carries a verification badge ([verified]/[unverified]/[failed]). Use this when the user asks about current events, facts beyond training data, or anything needing up-to-date or external information — never claim you lack web access while this tool is listed.",
  argsHint: '{ "query": "<search query>", "maxSources": 3 }',
  run: (args, ctx) => {
    const tool = getTool()
    if (tool === undefined) return Effect.fail(new Error("research module is not booted"))
    const query = typeof args["query"] === "string" ? args["query"] : ""
    const maxSources = typeof args["maxSources"] === "number" ? args["maxSources"] : undefined
    return Effect.map(
      tool.invoke({ query, sessionId: ctx.sessionId, turnId: ctx.turnId, maxSources }),
      (report) => report.answer
    )
  }
})

/** Every typed failure one research pass can produce. */
export type ResearchViaSeamError =
  | ResearchError
  | HonestyError
  | PermissionDenied
  | TurnTerminated
  | HookError
  | SandboxViolation
  | ModuleError

/**
 * One "research <query>" through the full seam: manifest check, module
 * hooks, DirectGate execution, claims in the shared honesty ledger.
 */
export const researchViaSeam = (
  host: ModuleHostApi,
  tool: ResearchTool,
  query: string,
  sessionId: string,
  turnId: string
): Effect.Effect<ResearchReport, ResearchViaSeamError> => {
  const args = { query, sessionId, turnId }
  return host.callTool(RESEARCH_MODULE, researchToolCall(`${turnId}:research`, args), tool.invoke(args))
}
