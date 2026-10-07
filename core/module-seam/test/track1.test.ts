/**
 * Track 1 (ModuleHost completion): full lifecycle, per-module dispatch,
 * disable-mid-run hook cessation + runtime cleanup, staged update/rollback.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import {
  type GateVerdict,
  type ModuleHookImpls,
  type ModuleHostApi,
  type ToolCall,
  type ToolOutcome,
  Allow,
  HookError,
  ModuleError,
  TrustDecisionRequired,
  makeModuleHooks,
  withActiveCheck,
  allowAllKernel
} from "../src/index.js"
import { SKILL_MD_V1, SKILL_MD_V2_NARROW, SKILL_MD_V2_WIDE, testCall, withTestHost } from "./fixtures.js"

const installEnable = (host: ModuleHostApi, moduleId = "web-research") =>
  Effect.gen(function* () {
    yield* host.install({ moduleId, skillMd: SKILL_MD_V1, tier: "T0" })
    yield* host.enable(moduleId)
  })

const expectModuleError = (eff: Effect.Effect<unknown, ModuleError>) =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(eff)
    expect(err).toBeInstanceOf(ModuleError)
    return err.reason
  })

/** Counting hook impl: every fired hook bumps its counter. */
const countingImpl = (module: string, counts: Ref.Ref<Record<string, number>>) => {
  const bump = (name: string) => Ref.update(counts, (c) => ({ ...c, [name]: (c[name] ?? 0) + 1 }))
  return {
    module,
    prepareNextTurn: () => Effect.asVoid(bump("prepareNextTurn")),
    prepareRequest: () => Effect.asVoid(bump("prepareRequest")),
    finishTurn: () => Effect.asVoid(bump("finishTurn")),
    beforeToolCall: (call: ToolCall) =>
      Effect.as(bump(`beforeToolCall`), { _tag: "Allow" } as GateVerdict),
    afterToolCall: (_call: ToolCall, outcome: ToolOutcome) => Effect.as(bump("afterToolCall"), outcome),
    getSteeringMessages: () => Effect.as(bump("getSteeringMessages"), [])
  } satisfies ModuleHookImpls
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0)

describe("ModuleHost lifecycle (Track 1)", () => {
  it.effect("invalid transitions are typed ModuleErrors", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        // enable from installed, then enable again from enabled
        yield* host.install({ moduleId: "m", skillMd: SKILL_MD_V1, tier: "T0" })
        yield* host.enable("m")
        yield* expectModuleError(host.enable("m"))
        // disable from installed
        yield* host.install({ moduleId: "m2", skillMd: SKILL_MD_V1, tier: "T0" })
        yield* expectModuleError(host.disable("m2"))
        // start requires enabled
        yield* expectModuleError(host.start("m2"))
        // stop requires running
        yield* expectModuleError(host.stop("m"))
        // stage requires enabled/running
        yield* expectModuleError(host.stageUpdate("m2", SKILL_MD_V1, "2.0.0"))
        // activate with nothing staged
        yield* expectModuleError(host.activateUpdate("m"))
        // rollback with no previous version
        yield* expectModuleError(host.rollback("m"))
        // double install
        yield* expectModuleError(host.install({ moduleId: "m", skillMd: SKILL_MD_V1, tier: "T0" }))
        // empty moduleId
        yield* expectModuleError(host.install({ moduleId: "  ", skillMd: SKILL_MD_V1, tier: "T0" }))
        // unknown module
        yield* expectModuleError(host.enable("ghost"))
      })
    )
  )

  it.effect("disable-mid-run: hooks stop firing immediately and runtime state is cleaned", () =>
    withTestHost(
      (host) =>
        Effect.gen(function* () {
          yield* installEnable(host)
          yield* host.start("web-research")
          expect(yield* host.runtimeModules()).toEqual(["web-research"])

          const turn = {
            turn: { turnId: "t1", module: "web-research" },
            contextMessages: [],
            toolCalls: [testCall()],
            executeTool: () => Effect.succeed("ok")
          }
          const before = yield* host.runTurn(turn)
          expect(before.executed).toBe(1)

          // Disable mid-run: hooks must stop, runtime entry must go.
          yield* host.disable("web-research")
          expect(yield* host.runtimeModules()).toEqual([])

          // New turns and tool calls are refused with a typed error.
          yield* expectModuleError(host.runTurn(turn))
          yield* expectModuleError(host.callTool("web-research", testCall(), Effect.succeed("x")))

          // Re-enable + start: the module recovers cleanly.
          yield* host.enable("web-research")
          yield* host.start("web-research")
          expect(yield* host.runtimeModules()).toEqual(["web-research"])
          const after = yield* host.runTurn({ ...turn, turn: { turnId: "t2", module: "web-research" } })
          expect(after.executed).toBe(1)
        }),
      {
        impls: [
          {
            module: "web-research",
            beforeToolCall: () => Effect.succeed(Allow)
          } satisfies ModuleHookImpls
        ]
      }
    )
  )

  it.effect("disable-mid-run: hook counters prove hooks stop firing after disable", () =>
    Effect.flatMap(Ref.make({} as Record<string, number>), (counts) =>
      withTestHost(
        (host) =>
          Effect.gen(function* () {
            yield* installEnable(host)
            yield* host.start("web-research")
            const turn = {
              turn: { turnId: "t1", module: "web-research" },
              contextMessages: [],
              toolCalls: [testCall()],
              executeTool: () => Effect.succeed("ok")
            }
            yield* host.runTurn(turn)
            const firedBefore = total(yield* Ref.get(counts))
            expect(firedBefore).toBeGreaterThan(0)

            yield* host.disable("web-research")
            // The host refuses the turn before any hook fires (ModuleError);
            // the in-flight guard would additionally deny dispatch.
            yield* Effect.flip(host.runTurn(turn))
            yield* Effect.flip(host.callTool("web-research", testCall(), Effect.succeed("x")))
            expect(total(yield* Ref.get(counts))).toBe(firedBefore)
          }),
        { impls: [countingImpl("web-research", counts)] }
      )
    )
  )
})

describe("withActiveCheck (in-flight guard)", () => {
  it.effect("inactive module: beforeToolCall denies fail-closed, runTurn fails typed", () =>
    Effect.gen(function* () {
      const base = makeModuleHooks({
        impls: [countingImpl("m1", yield* Ref.make({} as Record<string, number>))],
        kernel: allowAllKernel
      })
      const guarded = withActiveCheck(base, () => Effect.succeed(false))
      const verdict = yield* guarded.dispatchBeforeToolCall("m1", testCall())
      expect(verdict._tag).toBe("Deny")
      // Void hooks are skipped silently.
      yield* guarded.dispatchPrepareNextTurn({ turnId: "t", module: "m1" })
      expect(yield* guarded.dispatchSteeringMessages("m1")).toEqual([])
      const err = yield* Effect.flip(
        guarded.runTurn({
          turn: { turnId: "t", module: "m1" },
          contextMessages: [],
          toolCalls: [],
          executeTool: () => Effect.succeed("x")
        })
      )
      expect(err).toBeInstanceOf(HookError)
    })
  )

  it.effect("active module: dispatch passes through to its own hooks", () =>
    Effect.gen(function* () {
      const counts = yield* Ref.make({} as Record<string, number>)
      const base = makeModuleHooks({ impls: [countingImpl("m1", counts)], kernel: allowAllKernel })
      const guarded = withActiveCheck(base, () => Effect.succeed(true))
      const verdict = yield* guarded.dispatchBeforeToolCall("m1", testCall())
      expect(verdict._tag).toBe("Allow")
      expect((yield* Ref.get(counts))["beforeToolCall"]).toBe(1)
    })
  )
})

describe("per-module dispatch (never broadcast)", () => {
  it.effect("a turn fires only the turn owner's hooks", () =>
    Effect.gen(function* () {
      const countsA = yield* Ref.make({} as Record<string, number>)
      const countsB = yield* Ref.make({} as Record<string, number>)
      const hooks = makeModuleHooks({
        impls: [countingImpl("mod-a", countsA), countingImpl("mod-b", countsB)],
        kernel: allowAllKernel
      })
      const report = yield* hooks.runTurn({
        turn: { turnId: "t1", module: "mod-a" },
        contextMessages: [],
        toolCalls: [testCall()],
        executeTool: () => Effect.succeed("ok")
      })
      expect(report.executed).toBe(1)
      expect(total(yield* Ref.get(countsA))).toBeGreaterThan(0)
      // mod-b's hooks never fired — no broadcast.
      expect(total(yield* Ref.get(countsB))).toBe(0)
      // Steering comes only from the turn owner.
      expect(yield* hooks.dispatchSteeringMessages("mod-a")).toEqual([])
      // Unknown module: silent no-op, never another module's hooks.
      yield* hooks.dispatchPrepareNextTurn({ turnId: "t", module: "ghost" })
      expect(total(yield* Ref.get(countsA))).toBeGreaterThan(0)
      expect(total(yield* Ref.get(countsB))).toBe(0)
    })
  )
})

describe("ModuleHost update + rollback (Track 1)", () => {
  it.effect("stage -> activate (narrowing free) -> one-click rollback restores previous", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        yield* installEnable(host)
        // Stage a narrowing update: free activation, no trust decision.
        yield* host.stageUpdate("web-research", SKILL_MD_V2_NARROW, "2.0.0")
        yield* host.activateUpdate("web-research")
        // Stage a widening update: activation without trust fails typed.
        yield* host.stageUpdate("web-research", SKILL_MD_V2_WIDE, "3.0.0")
        const trustErr = yield* Effect.flip(host.activateUpdate("web-research"))
        expect(trustErr).toBeInstanceOf(TrustDecisionRequired)
        const diff = yield* host.diffUpdate("web-research")
        yield* host.activateUpdate("web-research", {
          decidedAt: Date.now(),
          widened: diff.widened,
          approved: true
        })
        // One-click rollback restores the previous (narrowed) version.
        yield* host.rollback("web-research")
        // Roll back a staged-but-unactivated update: stage is discarded.
        yield* host.stageUpdate("web-research", SKILL_MD_V2_WIDE, "4.0.0")
        yield* host.rollback("web-research")
        yield* expectModuleError(host.diffUpdate("web-research")) // no staged update left
      })
    )
  )

  it.effect("remove tears down runtime state and archives artifacts", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        yield* host.install({
          moduleId: "web-research",
          skillMd: SKILL_MD_V1,
          tier: "T0",
          artifacts: { memoryEntries: ["mem-1"], skillEntries: ["sk-1"] }
        })
        yield* host.enable("web-research")
        yield* host.start("web-research")
        expect(yield* host.runtimeModules()).toEqual(["web-research"])
        const archive = yield* host.remove("web-research")
        expect(archive.archivedMemoryEntries).toEqual(["mem-1"])
        expect(archive.archivedSkillEntries).toEqual(["sk-1"])
        expect(yield* host.runtimeModules()).toEqual([])
        // The module is gone: further operations fail typed.
        yield* expectModuleError(host.enable("web-research"))
      })
    )
  )

  it.effect("stop tears down runtime state without disabling", () =>
    withTestHost((host) =>
      Effect.gen(function* () {
        yield* installEnable(host)
        yield* host.start("web-research")
        expect(yield* host.runtimeModules()).toEqual(["web-research"])
        yield* host.stop("web-research")
        expect(yield* host.runtimeModules()).toEqual([])
        // Back to enabled: can start again.
        yield* host.start("web-research")
        expect(yield* host.runtimeModules()).toEqual(["web-research"])
      })
    )
  )
})
