/** Hook dispatch: order, truncation invariant, boundaries, I/O errors, deny/terminate. */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import {
  type ChatMessage,
  type GateVerdict,
  type ModuleHookImpls,
  type ToolCall,
  type ToolOutcome,
  Deny,
  HookError,
  PermissionDenied,
  TurnTerminated,
  allowAllKernel,
  makeDenyAllKernel,
  makeModuleHooks,
  toolIntent
} from "../src/index.js"
import { testCall } from "./fixtures.js"

const orderRecorder = (module: string, log: Ref.Ref<Array<string>>): ModuleHookImpls => {
  const rec = (name: string) => Ref.update(log, (xs) => [...xs, name])
  return {
    module,
    prepareNextTurn: () => Effect.asVoid(rec("prepareNextTurn")),
    prepareRequest: () => Effect.asVoid(rec("prepareRequest")),
    finishTurn: () => Effect.asVoid(rec("finishTurn")),
    transformContext: (messages: ReadonlyArray<ChatMessage>) =>
      Effect.as(rec("transformContext"), messages),
    beforeToolCall: (call: ToolCall) =>
      Effect.as(rec(`beforeToolCall:${call.tool}`), { _tag: "Allow" } as GateVerdict),
    afterToolCall: (call: ToolCall, outcome: ToolOutcome) =>
      Effect.as(rec(`afterToolCall:${call.tool}:${outcome._tag}`), outcome),
    getSteeringMessages: () => Effect.as(rec("getSteeringMessages"), []),
    getFollowUpMessages: () => Effect.as(rec("getFollowUpMessages"), [])
  }
}

describe("ModuleHooks dispatch", () => {
  it.effect("dispatches hooks in canonical turn order", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<Array<string>>([])
      const hooks = makeModuleHooks({ impls: [orderRecorder("m1", log)], kernel: allowAllKernel })
      const report = yield* hooks.runTurn({
        turn: { turnId: "t1", module: "m1" },
        contextMessages: [],
        toolCalls: [testCall()],
        executeTool: () => Effect.succeed("ok")
      })
      expect(report.executed).toBe(1)
      expect(report.blocked).toBe(0)
      expect(report.terminated).toBe(false)
      expect(yield* Ref.get(log)).toEqual([
        "prepareNextTurn",
        "prepareRequest",
        "transformContext",
        "beforeToolCall:web_fetch",
        "afterToolCall:web_fetch:Ok",
        "getSteeringMessages",
        "finishTurn",
        "getFollowUpMessages"
      ])
    })
  )

  it.effect("a message truncated on length fails ALL its tool calls", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const hooks = makeModuleHooks({ impls: [], kernel: allowAllKernel })
      const report = yield* hooks.runTurn({
        turn: { turnId: "t2", module: "m1" },
        contextMessages: [],
        toolCalls: [testCall({ id: "c1", truncated: true }), testCall({ id: "c2", truncated: true })],
        executeTool: () => Ref.update(ran, (n) => n + 1).pipe(Effect.as("ran"))
      })
      // Nothing executed, nothing terminated — every truncated call fails closed.
      expect(report.executed).toBe(0)
      expect(report.blocked).toBe(2)
      expect(report.terminated).toBe(false)
      expect(yield* Ref.get(ran)).toBe(0)
    })
  )

  it.effect("hook boundaries never throw: defects become typed HookError", () =>
    Effect.gen(function* () {
      const bad: ModuleHookImpls = {
        module: "bad",
        beforeToolCall: () => Effect.die(new Error("boom in module code"))
      }
      const hooks = makeModuleHooks({ impls: [bad], kernel: allowAllKernel })
      const err = yield* Effect.flip(hooks.dispatchBeforeToolCall("bad", testCall()))
      expect(err).toBeInstanceOf(HookError)
      expect((err as HookError).hook).toBe("beforeToolCall")
      expect((err as HookError).module).toBe("bad")
    })
  )

  it.effect("tool I/O errors are caught at the boundary, not thrown through hooks", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Array<string>>([])
      const impl: ModuleHookImpls = {
        module: "m1",
        afterToolCall: (_call, outcome) =>
          Ref.update(seen, (xs) => [...xs, outcome._tag]).pipe(Effect.as(outcome))
      }
      const hooks = makeModuleHooks({ impls: [impl], kernel: allowAllKernel })
      const report = yield* hooks.runTurn({
        turn: { turnId: "t3", module: "m1" },
        contextMessages: [],
        toolCalls: [testCall()],
        executeTool: () => Effect.fail(new Error("network down"))
      })
      expect(report.executed).toBe(1)
      expect(yield* Ref.get(seen)).toEqual(["IoError"])
    })
  )

  it.effect("deny with terminate blocks the call AND terminates the turn (kernel seam)", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const hooks = makeModuleHooks({ impls: [], kernel: makeDenyAllKernel(true, "nope") })
      const report = yield* hooks.runTurn({
        turn: { turnId: "t4", module: "m1" },
        contextMessages: [],
        toolCalls: [testCall({ id: "c1" }), testCall({ id: "c2" })],
        executeTool: () => Ref.update(ran, (n) => n + 1).pipe(Effect.as("ran"))
      })
      expect(report.executed).toBe(0)
      expect(report.terminated).toBe(true)
      // Second call never attempted: the turn ended at the first denial.
      expect(report.blocked).toBe(1)
      expect(yield* Ref.get(ran)).toBe(0)
    })
  )

  it.effect("module-level deny merges fail-closed even when the kernel allows", () =>
    Effect.gen(function* () {
      const impl: ModuleHookImpls = {
        module: "m1",
        beforeToolCall: () => Effect.succeed(Deny("module says no", false))
      }
      const hooks = makeModuleHooks({ impls: [impl], kernel: allowAllKernel })
      const verdict = yield* hooks.dispatchBeforeToolCall("m1", testCall())
      expect(verdict._tag).toBe("Deny")
      const report = yield* hooks.runTurn({
        turn: { turnId: "t5", module: "m1" },
        contextMessages: [],
        toolCalls: [testCall()],
        executeTool: () => Effect.succeed("ran")
      })
      expect(report.executed).toBe(0)
      expect(report.blocked).toBe(1)
      expect(report.terminated).toBe(false)
    })
  )

  it.effect("kernel seam enforcement: deny blocks, deny+terminate terminates", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(false)
      const run = Ref.set(ran, true).pipe(Effect.as("ran"))

      const halting = makeDenyAllKernel(true, "halt")
      const err1 = yield* Effect.flip(
        halting.execute(toolIntent("m1", "web_fetch", "T0", "call"), run)
      )
      expect(err1).toBeInstanceOf(TurnTerminated)
      expect(yield* Ref.get(ran)).toBe(false)

      const blocking = makeDenyAllKernel(false, "no")
      const err2 = yield* Effect.flip(
        blocking.execute(toolIntent("m1", "web_fetch", "T0", "call"), run)
      )
      expect(err2).toBeInstanceOf(PermissionDenied)
      expect(yield* Ref.get(ran)).toBe(false)
    })
  )
})
