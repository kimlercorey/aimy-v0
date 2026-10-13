/**
 * chat/src/research.ts — the deep-research chat extension (2026-10-12;
 * charter planning/deep-research-spec.md, Extension v0.2 E2/E3 + v0.3
 * E13/E16). Mirrors chat/src/retrieval.ts: the module is installed from
 * its REAL SKILL.md (packageModule, tier T1), enabled, and started on the
 * host's ModuleHost; the model calls it as the `research.query` agent
 * tool; the CLI gets a `research <query>` prefix.
 *
 * Project binding (E13): every run belongs to the project active at run
 * start (else Default), recorded on the run and never changed mid-run.
 * Requestor visibility (E16): a run record (run.json) is written into
 * the project's research directory at start — with the deliverable spec
 * fixed up front — and updated at completion/failure. etaMs stays null
 * until the sectioned engine (E15) can estimate from real progress;
 * a null ETA is honest, a fabricated one is not.
 *
 * The PlanModel adapter over InferencePool lives here (planner.ts's seam):
 * generateText(system, user) → pool.generate powerhouse, one call.
 */
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { HonestyServiceShape } from "../../honesty/src/service.js"
import type { AgentToolDef } from "../../agent-loop/src/tools.js"
import { getActiveProject, listProjects, projectSlug, registerAsset } from "../../agent-loop/src/projects.js"
import type { InferencePoolService } from "../../inference-pool/index.js"
import {
  type HookError,
  type ModuleError,
  type ModuleHostApi,
  type ModulePackage,
  type PermissionDenied,
  type SandboxViolation,
  type TrustDecisionRequired,
  packageModule
} from "../../module-seam/src/index.js"
import type { HttpClientShape } from "../../web-retrieval/src/http.js"
import { makeDuckDuckGoHtmlProvider } from "../../web-retrieval/src/index.js"
import {
  DEPTH_BUDGETS,
  PlanError,
  RESEARCH_MODULE,
  RESEARCH_QUERY_TOOL,
  RESEARCH_TOOL_TIER,
  makeResearchTool,
  type DeepResearchReport,
  type PlanModel,
  type ResearchDepth,
  type ResearchOutput,
  type ResearchStageEvent,
  type ResearchTool
} from "../../deep-research/src/index.js"

export type { ResearchTool }
export { RESEARCH_MODULE }

/** Capability tier the chat runs the deep-research module at (T1: DirectGate). */
export const RESEARCH_TIER = "T1" as const

/** Filesystem location of the packaged deep-research SKILL.md (this repo). */
export const deepResearchDir = (): string =>
  fileURLToPath(new URL("../../deep-research", import.meta.url))

/** Install + enable + start deep-research from its SKILL.md. Atomic install. */
export const bootResearchModule = (
  host: ModuleHostApi,
  dir: string = deepResearchDir()
): Effect.Effect<ModulePackage, ModuleError | SandboxViolation | TrustDecisionRequired> =>
  Effect.gen(function* () {
    const pkg = yield* packageModule(dir, { tier: RESEARCH_TIER })
    yield* host.install(pkg)
    yield* host.enable(RESEARCH_MODULE)
    yield* host.start(RESEARCH_MODULE)
    return pkg
  })

/**
 * The PlanModel adapter: InferencePool satisfies the planner's narrow
 * generateText seam. One powerhouse generate per call; any pool failure
 * becomes a PlanError, which the planner degrades to the honest fallback
 * plan (never a failed run).
 */
export const makePoolPlanModel = (pool: InferencePoolService): PlanModel => ({
  generateText: (system: string, user: string) =>
    pool
      .generate(
        {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          params: {},
          maxTokens: 1200
        },
        { mode: "powerhouse" }
      )
      .pipe(
        Effect.map((r) => r.text),
        Effect.mapError(
          (e) => new PlanError({ reason: `inference pool generate failed: ${e instanceof Error ? e.message : String(e)}` })
        )
      )
})

/** The research tool bound to the chat's HTTP + honesty services + pool model. */
export const makeResearchToolForChat = (
  http: HttpClientShape,
  honesty: HonestyServiceShape,
  model: PlanModel,
  onStage?: ((event: ResearchStageEvent) => void) | undefined
): ResearchTool =>
  makeResearchTool({ provider: makeDuckDuckGoHtmlProvider({ http }), http, honesty, model, onStage })

// ── Run records (E13/E16) ─────────────────────────────────────────────

export interface ResearchRunRecord {
  readonly runId: string
  readonly projectId: string
  readonly query: string
  readonly mode: ResearchOutput
  readonly depth: ResearchDepth
  readonly status: "scheduled" | "running" | "done" | "failed"
  /** Set when the run was scheduled for a future start (E15 startAt). */
  readonly schedule?: { readonly startAt: string }
  readonly startedAt: string
  readonly updatedAt: string
  readonly finishedAt?: string
  readonly stage: string
  readonly counters: {
    readonly searches: number
    readonly fetches: number
    readonly claims: number
    readonly clusters: number
    readonly rounds: number
  }
  readonly budget: { readonly rounds: number; readonly queries: number; readonly fetches: number }
  readonly deliverable: {
    readonly title: string
    readonly path: string | null
    readonly structure: ReadonlyArray<string>
  }
  readonly etaMs: number | null
  readonly termination?: string
  readonly failureReason?: string
}

const PAPER_STRUCTURE: ReadonlyArray<string> = [
  "Visual summary",
  "Summary",
  "Findings (by sub-question)",
  "Comparison (if applicable)",
  "Disputes & uncertainty",
  "Gaps & follow-ups",
  "Sources"
]

const researchRunDir = (projectId: string, runId: string): string =>
  path.join(os.homedir(), ".aimy", "projects", projectId, "research", runId)

const writeRunRecord = (record: ResearchRunRecord): void => {
  try {
    const dir = researchRunDir(record.projectId, record.runId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(record, null, 2), "utf8")
  } catch (e) {
    console.error(`[research] run record write failed (${e instanceof Error ? e.message : e})`)
  }
}

const deliverableFor = (
  query: string,
  output: ResearchOutput
): ResearchRunRecord["deliverable"] =>
  output === "paper"
    ? {
        title: `Research — ${query.length > 80 ? `${query.slice(0, 80)}…` : query}`,
        path: `planning/research-${projectSlug(query).slice(0, 48)}.md`,
        structure: PAPER_STRUCTURE
      }
    : { title: `Answer — ${query.length > 80 ? `${query.slice(0, 80)}…` : query}`, path: null, structure: ["Chat answer with per-claim badges"] }

/**
 * Subject-locality guard (2026-10-12, after the first live runs): web
 * research cannot answer a question whose subject is AImy herself, one
 * of her declared projects, or other local state — that knowledge
 * lives in local files, and charter E10 already bars searching local
 * content. The first live run burned its entire budget discovering
 * that an hours-old local project has no web footprint. The guard
 * fires only on the narrow signature — a local subject + a
 * what-is/its-state ask + NO external-research anchor (industry,
 * best practices, competitors, comparisons) — so legitimate external
 * research FOR a project (the gap-analysis shape) passes untouched.
 * Returns a refusal she can act on, or null to proceed.
 */
export const localSubjectRefusal = (
  query: string,
  projectNames: ReadonlyArray<string>
): string | null => {
  const q = query.trim().toLowerCase()
  if (q === "") return null
  const mentionsProject = projectNames.some((n) => n.trim() !== "" && q.includes(n.trim().toLowerCase()))
  const mentionsSelf =
    /\baimy\b/.test(q) && /(project|interface|app|architecture|design|codebase)/.test(q)
  if (!mentionsProject && !mentionsSelf) return null
  const asksAboutState =
    /^(what is|what's|describe|investigate its|the current state of)/.test(q) ||
    /(investigate|describe|explain|document)( its| the)? (architecture|components|purpose|current state|contents)/.test(q) ||
    /current state of/.test(q)
  if (!asksAboutState) return null
  const externalAnchor =
    /(best practices?|industry|competitor|compar|state of the art|leading (products|tools|frameworks|apps)|market (research|analysis)|how (do|does) (other|leading|modern))/.test(q)
  if (externalAnchor) return null
  return (
    `research.query REFUSED before spending any budget: this question's subject is LOCAL — AImy, her projects, or local files. ` +
    `Web research cannot answer it (local content is never web-searched, and an unpublished local subject has no web footprint — a run would burn its whole budget finding nothing). ` +
    `Do instead, in this turn: (1) if he wants the CURRENT STATE of the local subject, answer from local sources — project files (doc.read / doc.list), the project record, this conversation; ` +
    `(2) if he wants research FOR that subject (industry best practices, references, comparisons — the usual intent when he names a project), re-issue research.query with THAT external question, stated explicitly. ` +
    `Tell him plainly which reading you took and why.`
  )
}

/** A boot-stashed factory: builds the module tool, optionally wired to a per-run stage sink. */
export type ResearchToolFactory = (
  onStage?: ((event: ResearchStageEvent) => void) | undefined
) => ResearchTool | undefined

/**
 * The research tool as a MODEL-CALLABLE agent tool, shared by the CLI
 * chat and the desktop engine (one definition everywhere, like
 * retrieval's). invoke() is called directly, NOT via host.callTool: the
 * loop's runTurn already dispatches module hooks.
 *
 * Wraps the module tool with the charter's run bookkeeping: binds the
 * active project, writes the run record before the first search and
 * updates it at EVERY stage event (E16 — the requestor can watch the
 * run, its counters, and its deliverable spec while it runs), and
 * finalizes it at the end, success or failure (E12: never silent).
 * Paper mode: the assembled paper is written into the run directory and
 * registered as the project's deliverable asset; the tool result hands
 * AImy the paper text plus the drawer delivery instruction (E8).
 */
export const makeResearchAgentTool = (
  makeTool: ResearchToolFactory
): AgentToolDef => ({
  name: RESEARCH_QUERY_TOOL,
  tier: RESEARCH_TOOL_TIER,
  description:
    "Investigate a question properly: plan it into sub-questions (background, evidence, counterpoint, primary-source), search each politely, read the sources, judge and corroborate their claims, chase gaps in further rounds, and return claims that carry verification badges from the honesty ledger. Use this when a question deserves real investigation — comparisons, contested topics, 'research X' — rather than a quick lookup (retrieval.query is the quick path). depth: quick | standard | deep. output: \"paper\" when he asks for a document, brief, report, or paper (it forces deep); otherwise \"answer\". For a paper, the result includes the assembled document — present it with drawer.preview bound to the path named in the result. Every run is recorded in the active project. The query must be the requester's question about an EXTERNAL subject, passed as asked — if he names a project, the research is FOR that project (industry practices, references, evidence), never ABOUT the project's own local state, which lives in local files (doc.read) and will be refused.",
  argsHint: '{ "query": "<question>", "depth": "standard", "output": "answer", "startAt": "<optional ISO time; only via job.spawn>" }',
  run: (args, ctx) => {
    const query = typeof args["query"] === "string" ? args["query"] : ""
    const depthArg = typeof args["depth"] === "string" ? (args["depth"] as ResearchDepth) : undefined
    const outputArg = typeof args["output"] === "string" ? (args["output"] as ResearchOutput) : undefined
    const maxSources = typeof args["maxSources"] === "number" ? args["maxSources"] : undefined
    const output: ResearchOutput = outputArg ?? "answer"
    const depth: ResearchDepth = output === "paper" ? "deep" : (depthArg ?? "standard")
    const startAtRaw = typeof args["startAt"] === "string" ? args["startAt"] : undefined
    const startAtMs = startAtRaw !== undefined ? Date.parse(startAtRaw) : NaN
    const scheduled = Number.isFinite(startAtMs) && startAtMs > Date.now()
    // Subject-locality guard: refuse a local-subject question before a
    // run record, a search, or a cent of budget exists.
    const refusal = localSubjectRefusal(query, listProjects().map((p) => p.name))
    if (refusal !== null) {
      console.warn(`[research] stage=refused-local-subject query="${query.slice(0, 80)}"`)
      return Effect.succeed(refusal)
    }
    return Effect.gen(function* () {
      const project = getActiveProject()
      const runId = `run-${Date.now()}`
      const startedAt = new Date().toISOString()
      const startedAtMs = Date.now()
      const budget = DEPTH_BUDGETS[depth]
      let record: ResearchRunRecord = {
        runId,
        projectId: project.id,
        query,
        mode: output,
        depth,
        status: scheduled ? "scheduled" : "running",
        ...(scheduled ? { schedule: { startAt: new Date(startAtMs).toISOString() } } : {}),
        startedAt,
        updatedAt: startedAt,
        stage: "plan",
        counters: { searches: 0, fetches: 0, claims: 0, clusters: 0, rounds: 0 },
        budget: { rounds: budget.rounds, queries: budget.queries, fetches: budget.fetches },
        deliverable: deliverableFor(query, output),
        etaMs: null
      }
      writeRunRecord(record)
      console.warn(`[research] stage=start round=0 run=${runId} project=${project.id} depth=${depth} output=${output} query="${query.slice(0, 80)}"`)
      const onStage = (event: ResearchStageEvent): void => {
        // ETA (E16): only once a full round has completed — before that
        // any number would be fabricated. Estimate from budget consumed
        // (rounds and fetches weighted equally) vs elapsed wall time.
        let etaMs: number | null = record.etaMs
        if (event.rounds >= 1 && event.stage !== "synthesis") {
          const elapsed = Date.now() - startedAtMs
          const progress = Math.min(
            0.9,
            0.5 * (event.rounds / Math.max(1, budget.rounds)) +
              0.5 * (event.fetches / Math.max(1, budget.fetches))
          )
          if (progress > 0.05) etaMs = Math.round((elapsed * (1 - progress)) / progress)
        }
        record = {
          ...record,
          status: "running",
          updatedAt: new Date().toISOString(),
          stage: event.stage,
          etaMs,
          counters: {
            searches: event.searches,
            fetches: event.fetches,
            claims: event.claims,
            clusters: event.clusters,
            rounds: event.rounds
          }
        }
        writeRunRecord(record)
        console.warn(
          `[research] stage=${event.stage} round=${event.rounds} run=${runId} searches=${event.searches} fetches=${event.fetches} claims=${event.claims} clusters=${event.clusters}`
        )
      }
      if (scheduled) {
        // startAt (E15): the wait lives here, so it only makes sense via
        // job.spawn — an inline call would block the reply for the delay.
        const waitMs = startAtMs - Date.now()
        console.warn(`[research] stage=scheduled round=0 run=${runId} startAt=${new Date(startAtMs).toISOString()} waitMs=${waitMs}`)
        yield* Effect.sleep(waitMs)
        record = { ...record, status: "running", updatedAt: new Date().toISOString() }
        writeRunRecord(record)
      }
      const tool = makeTool(onStage)
      if (tool === undefined) return yield* Effect.fail(new Error("research module is not booted"))
      const report = yield* tool.invoke({
        query,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        depth: depthArg,
        output: outputArg,
        maxSources
      }).pipe(
        Effect.tapError((e) =>
          Effect.sync(() => {
            writeRunRecord({
              ...record,
              status: "failed",
              updatedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              failureReason: e instanceof Error ? e.message : String(e)
            })
            console.warn(`[research] stage=failed round=${record.counters.rounds} run=${runId} reason=${e instanceof Error ? e.message : String(e)}`)
          })
        )
      )
      const done: ResearchRunRecord = {
        ...record,
        status: "done",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        stage: "complete",
        counters: {
          searches: report.sourcesSearched,
          fetches: report.sourcesRead,
          claims: report.claims.length,
          clusters: report.clusters.length,
          rounds: report.roundsUsed
        },
        termination: report.termination
      }
      writeRunRecord(done)
      registerAsset(project.id, {
        kind: "research-run",
        title: query,
        role: "reference",
        runId,
        originSessionId: ctx.sessionId
      })
      console.warn(
        `[research] stage=complete round=${report.roundsUsed} run=${runId} searches=${report.sourcesSearched} read=${report.sourcesRead} claims=${report.claims.length} clusters=${report.clusters.length} termination=${report.termination}`
      )
      const footer =
        `[research run ${runId} · project "${project.name}" · depth ${report.depth} · ` +
        `${report.sourcesRead} source(s) read · ${report.claims.length} claim(s) · ${report.clusters.length} cluster(s) · ${report.termination}]`
      if (output === "paper" && report.paper !== undefined) {
        try {
          const dir = researchRunDir(project.id, runId)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, "paper.md"), report.paper, "utf8")
        } catch (e) {
          console.error(`[research] paper write failed (${e instanceof Error ? e.message : e})`)
        }
        registerAsset(project.id, {
          kind: "paper",
          title: done.deliverable.title,
          role: "deliverable",
          ...(done.deliverable.path !== null ? { path: done.deliverable.path } : {}),
          runId,
          originSessionId: ctx.sessionId
        })
        return (
          `${report.answer}\n\n${footer}\n\n` +
          `--- PAPER DELIVERY ---\nPresent this paper now with drawer.preview: id "research-${projectSlug(query).slice(0, 40)}", ` +
          `title "${done.deliverable.title}", path "${done.deliverable.path}" (binding it lets him save it to that file). ` +
          `Content:\n\n${report.paper}`
        )
      }
      return `${report.answer}\n\n${footer}`
    })
  }
})

/** Render a report for the CLI `research <query>` prefix. */
export const renderResearchReport = (report: DeepResearchReport): string =>
  `${report.answer}\n[research] depth=${report.depth} sources searched=${report.sourcesSearched} read=${report.sourcesRead} claims=${report.claims.length} termination=${report.termination}`
