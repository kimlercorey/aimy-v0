/** Skill index: budget-capped, one-line entries; skill_view hook-visible + permission-checked. */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import {
  type SkillSummary,
  ModuleError,
  PermissionDenied,
  buildSkillIndex,
  makeMapSkillStore,
  makeModuleHooks,
  makeSkillView,
  allowAllKernel,
  makeDenyAllKernel,
  DEFAULT_BUDGET
} from "../src/index.js"
import { testManifest } from "./fixtures.js"

const summaries = (n: number): Array<SkillSummary> =>
  Array.from({ length: n }, (_, i) => ({
    name: `skill-${String(i).padStart(2, "0")}`,
    description: `Does thing ${i}.\nSecond line that must not appear in the index.`
  }))

describe("buildSkillIndex", () => {
  it("caps entries and chars, counts omitted, one-lines descriptions", () => {
    const index = buildSkillIndex(summaries(100))
    expect(index.entries.length).toBeLessThanOrEqual(DEFAULT_BUDGET.maxEntries)
    expect(index.total).toBe(100)
    expect(index.omitted).toBe(100 - index.entries.length)
    expect(index.omitted).toBeGreaterThan(0)
    const chars = index.entries.reduce((n, e) => n + e.name.length + e.description.length + 2, 0)
    expect(chars).toBeLessThanOrEqual(DEFAULT_BUDGET.maxChars)
    for (const e of index.entries) {
      expect(e.description).not.toContain("\n")
    }
    // Deterministic: sorted by name.
    const names = index.entries.map((e) => e.name)
    expect([...names].sort()).toEqual(names)
  })

  it("respects a custom budget", () => {
    const index = buildSkillIndex(summaries(10), { maxEntries: 3, maxChars: 100000 })
    expect(index.entries.length).toBe(3)
    expect(index.omitted).toBe(7)
  })

  it("small skill sets are fully indexed", () => {
    const index = buildSkillIndex(summaries(2))
    expect(index.entries.length).toBe(2)
    expect(index.omitted).toBe(0)
  })
})

describe("skill_view", () => {
  const bodies = new Map([
    ["web-search", "# Web Search\nFull skill body."],
    ["notes", "# Notes\nAnother body."]
  ])

  const viewWith = (manifestTools: Array<string>, kernel = allowAllKernel) => {
    const hooks = makeModuleHooks({ impls: [], kernel })
    return makeSkillView({
      store: makeMapSkillStore(bodies),
      hooks,
      kernel,
      manifestOf: () => Effect.succeed(testManifest({ tools: manifestTools }))
    })
  }

  it.effect("loads bodies on demand when declared", () =>
    Effect.gen(function* () {
      const view = viewWith(["skill_view"])
      expect(yield* view("m1", "web-search")).toBe("# Web Search\nFull skill body.")
    })
  )

  it.effect("undeclared skill_view is denied fail-closed", () =>
    Effect.gen(function* () {
      const view = viewWith(["web_fetch"])
      const err = yield* Effect.flip(view("m1", "web-search"))
      expect(err).toBeInstanceOf(PermissionDenied)
      expect((err as PermissionDenied).reason).toContain("undeclared")
    })
  )

  it.effect("unknown skill is a typed ModuleError", () =>
    Effect.gen(function* () {
      const view = viewWith(["skill_view"])
      const err = yield* Effect.flip(view("m1", "nope"))
      expect(err).toBeInstanceOf(ModuleError)
    })
  )

  it.effect("skill views are hook-visible", () =>
    Effect.gen(function* () {
      const seenRef = yield* Ref.make<Array<string>>([])
      const hooks = makeModuleHooks({
        impls: [
          {
            module: "m1",
            beforeToolCall: (call) =>
              call.tool === "skill_view"
                ? Ref.update(seenRef, (xs) => [...xs, String(call.args["name"])]).pipe(
                    Effect.as({ _tag: "Allow" } as const)
                  )
                : Effect.succeed({ _tag: "Allow" } as const)
          }
        ],
        kernel: allowAllKernel
      })
      const view = makeSkillView({
        store: makeMapSkillStore(bodies),
        hooks,
        kernel: allowAllKernel,
        manifestOf: () => Effect.succeed(testManifest({ tools: ["skill_view"] }))
      })
      yield* view("m1", "notes")
      expect(yield* Ref.get(seenRef)).toEqual(["notes"])
    })
  )

  it.effect("denied skill view never loads the body", () =>
    Effect.gen(function* () {
      const kernel = makeDenyAllKernel(false, "no views")
      const hooks = makeModuleHooks({ impls: [], kernel })
      const view = makeSkillView({
        store: makeMapSkillStore(bodies),
        hooks,
        kernel,
        manifestOf: () => Effect.succeed(testManifest({ tools: ["skill_view"] }))
      })
      const err = yield* Effect.flip(view("m1", "web-search"))
      expect(err).toBeInstanceOf(PermissionDenied)
    })
  )
})
