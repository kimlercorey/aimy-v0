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
