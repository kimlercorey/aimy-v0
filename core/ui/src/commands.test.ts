/**
 * commands.test.ts — Commands as data: construction, correlation ids, and the
 * failure-message contract (failed commands produce Messages, never silent
 * drops). Service effects run against stub layers; nothing here touches the
 * real kernel, pool, or filesystem.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { MemoryService, type MemoryServiceShape } from "../../memory/service.js"
import { PermissionDenied } from "../../substrate/errors.js"
import { SafetyKernel, type SafetyKernelService } from "../../permission-kernel/index.js"
import { Message } from "./messages.js"
import { PersistMemory, RequestPermission, SendToInference } from "./commands.js"

const run = <A, E>(effect: Effect.Effect<A, E, SafetyKernel | MemoryService>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const kernelLayer = (decision: "allow" | "ask" | "deny"): Layer.Layer<SafetyKernel> =>
  Layer.succeed(
    SafetyKernel,
    {
      check: () =>
        decision === "deny"
          ? Effect.fail(new PermissionDenied({ tool: "exec", tier: "T3", reason: "policy says no" }))
          : Effect.succeed(decision),
      execute: () => Effect.die("not under test"),
      approve: () => Effect.void,
    } satisfies SafetyKernelService,
  )

const memoryShape = (append: MemoryServiceShape["append"]): MemoryServiceShape => ({
  append,
  read: () => Effect.die("not under test"),
  branch: () => Effect.die("not under test"),
  fork: () => Effect.die("not under test"),
  get: () => Effect.die("not under test"),
  set: () => Effect.die("not under test"),
  listSessions: () => Effect.die("not under test"),
  listKeys: () => Effect.die("not under test"),
})

describe("SendToInference", () => {
  it("builds a named command carrying the correlation id", () => {
    const cmd = SendToInference({ correlationId: "m1", sessionId: "s1", input: "hi" })
    expect(cmd.name).toBe("SendToInference")
    expect(cmd.args).toMatchObject({ correlationId: "m1", sessionId: "s1" })
  })

  it("dispatches StreamStarted with the correlation id as streamId", async () => {
    const cmd = SendToInference({ correlationId: "m1", sessionId: "s1", input: "hi" })
    const msg = await run(cmd.effect)
    expect(msg._tag).toBe("StreamStarted")
    expect(msg).toMatchObject({ streamId: "m1", sessionId: "s1", input: "hi" })
  })
})

describe("RequestPermission", () => {
  const args = {
    requestId: "r1",
    tool: "exec",
    tier: "T3" as const,
    argsSummary: JSON.stringify({ cmd: "ls" }),
    provenance: "agent-loop:turn-3",
  }

  it("kernel 'allow' -> PermissionAutoAllowed (no prompt)", async () => {
    const msg = await Effect.runPromise(
      RequestPermission(args).effect.pipe(Effect.provide(kernelLayer("allow"))),
    )
    expect(msg).toMatchObject({ _tag: "PermissionAutoAllowed", requestId: "r1" })
  })

  it("kernel 'ask' -> PermissionRequested (the prompt is UI, the gate is the kernel)", async () => {
    const msg = await Effect.runPromise(
      RequestPermission(args).effect.pipe(Effect.provide(kernelLayer("ask"))),
    )
    expect(msg).toMatchObject({
      _tag: "PermissionRequested",
      requestId: "r1",
      tool: "exec",
      riskTier: "T3",
      context: "agent-loop:turn-3",
    })
  })

  it("kernel deny -> PermissionCheckFailed, never a silent drop", async () => {
    const msg = await Effect.runPromise(
      RequestPermission(args).effect.pipe(Effect.provide(kernelLayer("deny"))),
    )
    expect(msg).toMatchObject({ _tag: "PermissionCheckFailed", requestId: "r1", denied: true })
    expect((msg as { reason: string }).reason).toContain("policy says no")
  })

  it("unparseable args fail closed to a check, not a crash", async () => {
    const msg = await Effect.runPromise(
      RequestPermission({ ...args, argsSummary: "{not json" }).effect.pipe(
        Effect.provide(kernelLayer("ask")),
      ),
    )
    expect(msg._tag).toBe("PermissionRequested")
  })

  it("is interruptible, keyed by requestId", () => {
    expect(typeof (RequestPermission as unknown as { Interrupt: unknown }).Interrupt).toBe(
      "function",
    )
  })
})

describe("PersistMemory", () => {
  const args = { correlationId: "m1:assistant", sessionId: "s1", role: "assistant" as const, text: "hi" }

  it("append success -> MemoryPersisted with the correlation id", async () => {
    const layer = Layer.succeed(
      MemoryService,
      memoryShape(() =>
        Effect.succeed({ id: "e1", parentId: null, kind: "message", payload: {}, ts: 1 }),
      ),
    )
    const msg = await Effect.runPromise(PersistMemory(args).effect.pipe(Effect.provide(layer)))
    expect(msg).toEqual(Message.MemoryPersisted({ correlationId: "m1:assistant" }))
  })

  it("append failure -> MemoryPersistFailed, never a silent drop", async () => {
    const layer = Layer.succeed(
      MemoryService,
      memoryShape(() => Effect.die("disk gone")),
    )
    const msg = await Effect.runPromise(PersistMemory(args).effect.pipe(Effect.provide(layer)))
    expect(msg).toMatchObject({ _tag: "MemoryPersistFailed", correlationId: "m1:assistant" })
  })
})
