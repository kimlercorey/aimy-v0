/** ModuleHost integration: lifecycle + manifest enforcement + sandbox selection + skills. */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import {
  type ModuleHookImpls,
  type ModuleHostApi,
  ModuleError,
  PermissionDenied,
  SandboxViolation,
  TrustDecisionRequired,
  TurnTerminated,
  makeDenyAllKernel,
  makeMapSkillStore
} from "../src/index.js"
import {
  SKILL_MD_V1,
  SKILL_MD_V2_NARROW,
  SKILL_MD_V2_WIDE,
  testCall,
  withTestHost
} from "./fixtures.js"

const installAndEnable = (host: ModuleHostApi) =>
  Effect.gen(function* () {
    yield* host.install({ moduleId: "web-retrieval", skillMd: SKILL_MD_V1, tier: "T0" })
    yield* host.enable("web-retrieval")
  })

describe("ModuleHost", () => {
  it.effect("install parses the manifest; start hands the module its instance context", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        const record = yield* host.install({
          moduleId: "web-retrieval",
          skillMd: SKILL_MD_V1,
          tier: "T0",
          config: { intimateMode: false }
        })
        expect(record.name).toBe("web-retrieval")
        expect(record.version).toBe("1.0.0")
        expect(record.manifest.tools).toContain("web_fetch")
        yield* host.enable("web-retrieval")
        const ctx = yield* host.start("web-retrieval")
        expect(ctx.instanceId).toBe("test-instance-uuid-0001")
        expect(ctx.moduleId).toBe("web-retrieval")
        expect(ctx.config["intimateMode"]).toBe(false)
      })
    )
  )

  it.effect("install rejects an invalid manifest with typed ModuleError", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        const err = yield* Effect.flip(
          host.install({ moduleId: "bad", skillMd: "no frontmatter", tier: "T0" })
        )
        expect(err).toBeInstanceOf(ModuleError)
      })
    )
  )

  it.effect("callTool: undeclared tool is denied fail-closed, never runs", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        yield* installAndEnable(host)
        const ran = yield* Ref.make(false)
        const err = yield* Effect.flip(
          host.callTool("web-retrieval", testCall({ tool: "code_exec" }), Ref.set(ran, true))
        )
        expect(err).toBeInstanceOf(PermissionDenied)
        expect((err as PermissionDenied).reason).toContain("undeclared")
        expect(yield* Ref.get(ran)).toBe(false)
      })
    )
  )

  it.effect("callTool: declared tool runs through hooks and returns the value", () =>
    withTestHost(
      (host) =>
        Effect.gen(function* () {
          yield* installAndEnable(host)
          const seen = yield* Ref.make<Array<string>>([])
          const result = yield* host.callTool(
            "web-retrieval",
            testCall(),
            Ref.update(seen, (xs) => [...xs, "ran"]).pipe(Effect.as("fetched"))
          )
          expect(result).toBe("fetched")
          expect(yield* Ref.get(seen)).toEqual(["ran"])
        }),
      {
        impls: [
          {
            module: "web-retrieval",
            afterToolCall: (_call, outcome) => Effect.succeed(outcome)
          } satisfies ModuleHookImpls
        ]
      }
    )
  )

  it.effect("callTool: kernel deny blocks; deny+terminate terminates", () =>
    withTestHost(
      (host) =>
        Effect.gen(function* () {
          yield* installAndEnable(host)
          const err = yield* Effect.flip(
            host.callTool("web-retrieval", testCall(), Effect.succeed("ran"))
          )
          expect(err).toBeInstanceOf(TurnTerminated)
        }),
      { kernel: makeDenyAllKernel(true, "halt") }
    )
  )

  it.effect("start: T2 module with stub backend refuses fail-closed, state unchanged", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        yield* host.install({ moduleId: "heavy", skillMd: SKILL_MD_V1, tier: "T2" })
        yield* host.enable("heavy")
        const err = yield* Effect.flip(host.start("heavy"))
        expect(err).toBeInstanceOf(SandboxViolation)
        expect((err as SandboxViolation).reason).toContain("fail-closed")
      })
    )
  )

  it.effect("runTurn: order, counts, and truncation through the host", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        yield* installAndEnable(host)
        const report = yield* host.runTurn({
          turn: { turnId: "t1", module: "web-retrieval" },
          contextMessages: [],
          toolCalls: [testCall({ id: "c1" }), testCall({ id: "c2", truncated: true })],
          executeTool: () => Effect.succeed("ok")
        })
        expect(report.executed).toBe(1)
        expect(report.blocked).toBe(1) // truncated call failed closed
        expect(report.terminated).toBe(false)
      })
    )
  )

  it.effect("update: widening re-prompts via host; diffUpdate shows the widened set", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        yield* installAndEnable(host)
        yield* host.stageUpdate("web-retrieval", SKILL_MD_V2_WIDE, "2.0.0")
        const diff = yield* host.diffUpdate("web-retrieval")
        expect(diff.widened).toContain("tool:+code_exec")
        expect(diff.widened).toContain("subprocess:off->on")
        const err = yield* Effect.flip(host.activateUpdate("web-retrieval"))
        expect(err).toBeInstanceOf(TrustDecisionRequired)
        yield* host.activateUpdate("web-retrieval", {
          decidedAt: Date.now(),
          widened: diff.widened,
          approved: true
        })
        // Narrowing is free.
        yield* host.stageUpdate("web-retrieval", SKILL_MD_V2_NARROW, "3.0.0")
        yield* host.activateUpdate("web-retrieval")
        // Rollback restores the widened v2.
        yield* host.rollback("web-retrieval")
      })
    )
  )

  it.effect("remove archives module-created entries", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        yield* host.install({
          moduleId: "web-retrieval",
          skillMd: SKILL_MD_V1,
          tier: "T0",
          artifacts: { memoryEntries: ["mem-9"], skillEntries: [] }
        })
        yield* host.enable("web-retrieval")
        const archive = yield* host.remove("web-retrieval")
        expect(archive.archivedMemoryEntries).toEqual(["mem-9"])
      })
    )
  )

  it.effect("viewSkill + skillIndex through the host", () =>
    withTestHost(
      (host) =>
        Effect.gen(function* () {
          yield* installAndEnable(host)
          expect(yield* host.viewSkill("web-retrieval", "web-search")).toBe("# Web Search\nbody")
          const index = yield* host.skillIndex()
          expect(index.total).toBe(2)
          expect(index.entries.map((e) => e.name)).toEqual(["notes", "web-search"])
          const denied = yield* Effect.flip(host.viewSkill("web-retrieval", "missing"))
          expect(denied).toBeInstanceOf(ModuleError)
        }),
      {
        skills: [
          { name: "web-search", description: "Search the web." },
          { name: "notes", description: "Read notes." }
        ],
        skillStore: makeMapSkillStore(new Map([["web-search", "# Web Search\nbody"]]))
      }
    )
  )
})
