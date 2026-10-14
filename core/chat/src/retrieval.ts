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
 * The module's SKILL.md declares the search egress hosts
 * (html.duckduckgo.com, api.search.brave.com); result URLs are governed
 * by the declared fetch policy (https-only, result-hosts-only), enforced
 * before any socket opens.
 */
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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
  RETRIEVAL_IMAGES_TOOL,
  RETRIEVAL_MODULE,
  RETRIEVAL_NEWS_TOOL,
  RETRIEVAL_VIDEOS_TOOL,
  makeBraveMediaClient,
  makeBraveMediaTools,
  makeBraveSearchProvider,
  makeChainedSearchProvider,
  makeDuckDuckGoHtmlProvider,
  makeRetrievalTool,
  retrievalToolCall,
  type BraveMediaTool,
  type RetrievalError,
  type RetrievalReport,
  type RetrievalTool,
  type SearchFreshness
} from "../../web-retrieval/src/index.js"

export type { BraveMediaTool, RetrievalTool }

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

/**
 * Search configuration lives at ~/.aimy/search.json (user-owned, never
 * in the repo): { "braveApiKey": "<subscription token>" }. Absent or
 * unreadable simply means DuckDuckGo-only — the pre-Brave behavior.
 */
const readBraveApiKey = (): string | undefined => {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".aimy", "search.json"), "utf-8")
    const key = (JSON.parse(raw) as { braveApiKey?: unknown }).braveApiKey
    return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined
  } catch {
    return undefined
  }
}

/** True when a Brave key is configured — the gate for every Brave-only tool. */
export const braveSearchConfigured = (): boolean => readBraveApiKey() !== undefined

/**
 * The Brave media tools (news / images / videos) for this chat, or
 * undefined when no Brave key is configured. These endpoints exist
 * only on the keyed API, so without a key the tools are never
 * registered — the model never sees a tool that cannot work.
 */
export const makeBraveMediaToolsForChat = (
  http: HttpClientShape
): ReadonlyArray<BraveMediaTool> | undefined => {
  const braveKey = readBraveApiKey()
  if (braveKey === undefined) return undefined
  console.log("[aimy] search: brave media tools enabled (news, images, videos)")
  return makeBraveMediaTools(makeBraveMediaClient({ http, apiKey: braveKey }))
}

/** The retrieval tool bound to the chat's HTTP + honesty services. */
export const makeRetrievalToolForChat = (
  http: HttpClientShape,
  honesty: HonestyServiceShape
): RetrievalTool => {
  const duckduckgo = makeDuckDuckGoHtmlProvider({ http })
  const braveKey = readBraveApiKey()
  if (braveKey === undefined) {
    console.log("[aimy] search: providers = duckduckgo only (no Brave key at ~/.aimy/search.json)")
    return makeRetrievalTool({ provider: duckduckgo, http, honesty })
  }
  console.log("[aimy] search: providers = brave (primary) -> duckduckgo (fallback)")
  const provider = makeChainedSearchProvider([
    makeBraveSearchProvider({ http, apiKey: braveKey }),
    duckduckgo,
  ])
  return makeRetrievalTool({ provider, http, honesty })
}

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
  argsHint: '{ "query": "<search query>", "maxSources": 3, "freshness": "day | week | month | year (optional)" }',
  run: (args, ctx) => {
    const tool = getTool()
    if (tool === undefined) return Effect.fail(new Error("retrieval module is not booted"))
    const query = typeof args["query"] === "string" ? args["query"] : ""
    const maxSources = typeof args["maxSources"] === "number" ? args["maxSources"] : undefined
    const freshness = typeof args["freshness"] === "string" ? (args["freshness"] as SearchFreshness) : undefined
    const resultFilter = typeof args["resultFilter"] === "string" ? args["resultFilter"] : undefined
    return Effect.map(
      tool.invoke({ query, sessionId: ctx.sessionId, turnId: ctx.turnId, maxSources, freshness, resultFilter }),
      (report) => report.answer
    )
  }
})

/**
 * The Brave media tools as MODEL-CALLABLE agent tools (2026-10-13).
 * Same closure pattern as the retrieval tool: the definitions are
 * created before boot and resolve the real tools through `getTools`
 * at call time. Callers register these ONLY when
 * braveSearchConfigured() — a keyless install never lists them.
 */
export const makeBraveMediaAgentTools = (
  getTools: () => ReadonlyArray<BraveMediaTool> | undefined
): ReadonlyArray<AgentToolDef> => {
  const mediaRun = (name: string) => (args: Record<string, unknown>) => {
    const tool = getTools()?.find((t) => t.name === name)
    if (tool === undefined) return Effect.fail(new Error("brave media tools are not booted"))
    const query = typeof args["query"] === "string" ? args["query"] : ""
    const freshness = typeof args["freshness"] === "string" ? (args["freshness"] as SearchFreshness) : undefined
    const count = typeof args["count"] === "number" ? args["count"] : undefined
    return tool.invoke({ query, freshness, count }).pipe(
      Effect.mapError((e) => new Error((e as { reason?: string }).reason ?? e._tag)),
    )
  }
  return [
    {
      name: RETRIEVAL_NEWS_TOOL,
      tier: RETRIEVAL_TOOL_TIER,
      description:
        "Search Brave News for recent news articles on a topic. Returns headlines with the outlet, the article's age, its URL, and a summary. Use this for current events and 'what is happening with X' questions — fresher and cleaner than a general web search. freshness limits the window: day, week, month, or year.",
      argsHint: '{ "query": "<topic>", "freshness": "week", "count": 10 }',
      run: (args) => mediaRun(RETRIEVAL_NEWS_TOOL)(args),
    },
    {
      name: RETRIEVAL_IMAGES_TOOL,
      tier: RETRIEVAL_TOOL_TIER,
      description:
        "Search the web for images via Brave. Returns each image's title, direct image URL, the page it appears on, and a thumbnail URL. Use when the user asks for pictures or images of something, or needs an image URL to show or reference.",
      argsHint: '{ "query": "<subject>", "count": 10 }',
      run: (args) => mediaRun(RETRIEVAL_IMAGES_TOOL)(args),
    },
    {
      name: RETRIEVAL_VIDEOS_TOOL,
      tier: RETRIEVAL_TOOL_TIER,
      description:
        "Search for videos via Brave. Returns titles, links, durations, view counts, creators, and ages. Use when the user asks for videos, tutorials, talks, or footage of something. freshness limits the window: day, week, month, or year.",
      argsHint: '{ "query": "<topic>", "freshness": "month", "count": 10 }',
      run: (args) => mediaRun(RETRIEVAL_VIDEOS_TOOL)(args),
    },
  ]
}

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
