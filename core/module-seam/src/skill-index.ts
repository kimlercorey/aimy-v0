/**
 * Skill-index token tax (Hermes #2045, #49967).
 *
 * Full skill listing in the system prompt is a per-turn token tax. Decision,
 * locked at architecture level:
 * - The system prompt carries a SKILL INDEX ONLY: name + one-line description,
 *   budget-capped. Beyond the cap, skills are found via memory retrieval, not
 *   prompt stuffing.
 * - Skill bodies load on demand via `skill_view`, which is hook-visible
 *   (beforeToolCall/afterToolCall) and permission-checked against the calling
 *   module's capability manifest (must declare the `skill_view` tool).
 */
import { Effect } from "effect"
import { HookError, ModuleError, PermissionDenied, SandboxViolation, TurnTerminated } from "./errors.js"
import { type CapabilityTier, type SafetyKernelSeam, Allow, toolIntent } from "./kernel-seam.js"
import { type CapabilityManifest, declaresTool } from "./manifest.js"
import { type ModuleHookImpls, type ModuleHooksApi, type ToolCall } from "./hooks.js"

export interface SkillSummary {
  readonly name: string
  readonly description: string
}

export interface SkillIndexBudget {
  readonly maxEntries: number
  readonly maxChars: number
}

export const DEFAULT_BUDGET: SkillIndexBudget = { maxEntries: 40, maxChars: 4000 }

export interface SkillIndex {
  readonly entries: ReadonlyArray<SkillSummary>
  /** Total skills known, including omitted ones. */
  readonly total: number
  /** Skills left out of the index because the budget ran out. */
  readonly omitted: number
}

const oneLine = (description: string, maxLen = 140): string =>
  (description.split("\n").at(0) ?? "").trim().slice(0, maxLen)

/**
 * Build the budget-capped index. Deterministic: sorted by name, first-fit
 * within the char budget. Descriptions are collapsed to one line.
 */
export const buildSkillIndex = (
  skills: ReadonlyArray<SkillSummary>,
  budget: SkillIndexBudget = DEFAULT_BUDGET
): SkillIndex => {
  const sorted = [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const entries: Array<SkillSummary> = []
  let chars = 0
  for (const s of sorted) {
    const entry = { name: s.name, description: oneLine(s.description) }
    const cost = entry.name.length + entry.description.length + 2
    if (entries.length >= budget.maxEntries || chars + cost > budget.maxChars) break
    entries.push(entry)
    chars += cost
  }
  return { entries, total: sorted.length, omitted: sorted.length - entries.length }
}

/** Skill body storage. The host provides this (memory-backed at integration). */
export interface SkillStore {
  readonly getBody: (name: string) => Effect.Effect<string | undefined, ModuleError>
}

export const makeMapSkillStore = (bodies: ReadonlyMap<string, string>): SkillStore => ({
  getBody: (name) => Effect.succeed(bodies.get(name))
})

const SKILL_VIEW_TOOL = "skill_view"

const skillViewCall = (name: string): ToolCall => ({
  id: `skill-view:${name}`,
  tool: SKILL_VIEW_TOOL,
  args: { name },
  tier: "T0" as CapabilityTier,
  truncated: false
})

/**
 * `skill_view` implementation: hook-visible and permission-checked.
 * The calling module must declare the `skill_view` tool in its manifest
 * (undeclared = denied, fail-closed); the view passes beforeToolCall and
 * afterToolCall like any tool call.
 */
export const makeSkillView = (deps: {
  readonly store: SkillStore
  readonly hooks: ModuleHooksApi
  readonly kernel: SafetyKernelSeam
  readonly manifestOf: (moduleId: string) => Effect.Effect<CapabilityManifest, ModuleError>
}): ((moduleId: string, name: string) => Effect.Effect<string, ModuleError | PermissionDenied | HookError | TurnTerminated | SandboxViolation>) => {
  const view = (moduleId: string, name: string) =>
    Effect.gen(function* () {
      const manifest = yield* deps.manifestOf(moduleId)
      if (!declaresTool(manifest, SKILL_VIEW_TOOL)) {
        return yield* Effect.fail(
          new PermissionDenied({
            tool: SKILL_VIEW_TOOL,
            tier: "T0",
            reason: `module '${moduleId}' does not declare the '${SKILL_VIEW_TOOL}' tool (undeclared = denied)`,
          })
        )
      }
      const call = skillViewCall(name)
      const verdict = yield* deps.hooks.dispatchBeforeToolCall(moduleId, call)
      if (verdict._tag !== "Allow") {
        // Enforce through the kernel seam; the body never loads on non-Allow.
        const intent = toolIntent(moduleId, SKILL_VIEW_TOOL, "T0", `view skill '${name}'`)
        yield* deps.kernel.execute(intent, Effect.succeed(undefined))
        return yield* Effect.fail(
          new PermissionDenied({
            tool: intent.tool,
            tier: intent.tier,
            reason: "unreachable: kernel allowed a denied skill view",
          })
        )
      }
      const body = yield* deps.store.getBody(name)
      if (body === undefined) {
        return yield* Effect.fail(new ModuleError({ module: moduleId, reason: `unknown skill '${name}'` }))
      }
      yield* deps.hooks.dispatchAfterToolCall(moduleId, call, { _tag: "Ok", value: body })
      return body
    })
  return view
}

/** A hook impl that just observes skill views (visibility for tests / auditing). */
export const skillViewHookImpl = (module: string, onView: (name: string) => void): ModuleHookImpls => ({
  module,
  beforeToolCall: (call) =>
    Effect.suspend(() => {
      const name = call.args["name"]
      if (call.tool === SKILL_VIEW_TOOL && typeof name === "string") onView(name)
      return Effect.succeed(Allow)
    })
})
