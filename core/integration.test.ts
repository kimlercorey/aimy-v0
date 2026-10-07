/**
 * integration.test.ts — trust-boundary composition check.
 *
 * Proves the libraries compose as Effect Layers per the architecture's trust
 * boundaries (architecture.md §11): MemoryService's PermissionGate is wired
 * to the REAL SafetyKernel, so every memory operation is decided by the real
 * policy engine — not a test double. This is the "memory behind the
 * permission system from day one" invariant (Hermes #34352).
 *
 * Also pins the substrate path derivation: memory directories resolve from
 * the canonical AImy path layout.
 */
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  MemoryDirs,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
  PermissionGate,
  resolveMemoryDirs,
} from "./memory/service.js"
import {
  PolicyDocument,
  SafetyKernel,
  defaultPolicy,
} from "./permission-kernel/index.js"
import { PermissionDenied } from "./substrate/errors.js"
import { resolvePaths } from "./substrate/config.js"
import { ToolName } from "./substrate/types.js"

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "aimy-int-test-"))

const pathsLayer = (dir: string): Layer.Layer<MemoryPaths> =>
  Layer.succeed(MemoryPaths, {
    sessionsDir: path.join(dir, "sessions"),
    storesDir: path.join(dir, "stores"),
  } satisfies MemoryDirs)

/**
 * Production-shape PermissionGate: delegates every memory op to the real
 * SafetyKernel. `check` decides allow/ask; a deny fails with the kernel's
 * own canonical PermissionDenied. `ask` fails closed (headless integration:
 * no interactive approver exists in this phase).
 */
const kernelBackedGate: Layer.Layer<PermissionGate, never, SafetyKernel> = Layer.effect(
  PermissionGate,
  Effect.gen(function* () {
    const kernel = yield* SafetyKernel
    return {
      checkMemory: (op: "read" | "write", store: string) =>
        Effect.gen(function* () {
          const tier = op === "read" ? ("T0" as const) : ("T1" as const)
          const tool = ToolName(`memory:${store}:${op}`)
          const decision = yield* kernel.check({
            tool,
            tier,
            args: {},
            provenance: "integration/memory-gate",
          })
          if (decision === "ask") {
            return yield* Effect.fail(
              new PermissionDenied({
                tool,
                tier,
                reason: "ask unresolved: no interactive approver in this phase",
              }),
            )
          }
        }),
    }
  }),
)

const stackWithPolicy = (policy: PolicyDocument, dir: string) =>
  Layer.provide(
    MemoryServiceLive,
    Layer.mergeAll(kernelBackedGate, pathsLayer(dir)),
  ).pipe(Layer.provide(SafetyKernel.layerFromPolicy(policy)))

const allowMemoryPolicy: PolicyDocument = {
  version: 1,
  rules: [
    { tool: "*", tier: "T0", decision: "allow", reason: "integration: memory reads allowed" },
    { tool: "*", tier: "T1", decision: "allow", reason: "integration: memory writes allowed" },
    { tool: "*", tier: "T2", decision: "ask", reason: "integration default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "integration default" },
  ],
}

const denyWritesPolicy: PolicyDocument = {
  version: 1,
  rules: [
    { tool: "*", tier: "T0", decision: "allow", reason: "integration: memory reads allowed" },
    { tool: "*", tier: "T1", decision: "deny", reason: "integration: memory writes denied" },
    { tool: "*", tier: "T2", decision: "ask", reason: "integration default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "integration default" },
  ],
}

describe("trust-boundary composition: MemoryService behind the real SafetyKernel", () => {
  it("allow policy: full session + kv round-trip passes through the kernel gate", async () => {
    const dir = tmpRoot()
    const program = Effect.gen(function* () {
      const mem = yield* MemoryService
      const entry = yield* mem.append("s1", {
        parentId: null,
        kind: "message",
        payload: { role: "user", text: "hello" },
      })
      const tree = yield* mem.read("s1")
      yield* mem.set("profile", "name", "Kimler")
      const name = yield* mem.get("profile", "name")
      return { entry, tree, name }
    })
    const result = await Effect.runPromise(
      Effect.provide(program, stackWithPolicy(allowMemoryPolicy, dir)),
    )
    expect(result.entry.payload).toEqual({ role: "user", text: "hello" })
    expect(result.tree.entries.length).toBe(1)
    expect(result.name).toBe("Kimler")
  })

  it("deny policy: a denied write fails with canonical PermissionDenied and nothing is written", async () => {
    const dir = tmpRoot()
    const program = Effect.gen(function* () {
      const mem = yield* MemoryService
      return yield* Effect.flip(
        mem.append("s1", { parentId: null, kind: "message", payload: { text: "x" } }),
      )
    })
    const err = await Effect.runPromise(
      Effect.provide(program, stackWithPolicy(denyWritesPolicy, dir)),
    )
    // The kernel's own denial, canonical shape — denial kills the intent.
    expect(err).toBeInstanceOf(PermissionDenied)
    expect(err._tag).toBe("PermissionDenied")
    const denied = err as PermissionDenied
    expect(denied.tool).toBe("memory:session:s1:write")
    expect(denied.tier).toBe("T1")
    // Nothing was written: the session file does not exist.
    expect(fs.existsSync(path.join(dir, "sessions", "s1.jsonl"))).toBe(false)
  })

  it("deny policy: reads still pass (tiered gates, never binary auth)", async () => {
    const dir = tmpRoot()
    // Seed a session under the allow policy, then read under the deny policy.
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const mem = yield* MemoryService
          yield* mem.append("s1", { parentId: null, kind: "message", payload: { text: "kept" } })
        }),
        stackWithPolicy(allowMemoryPolicy, dir),
      ),
    )
    const tree = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const mem = yield* MemoryService
          return yield* mem.read("s1")
        }),
        stackWithPolicy(denyWritesPolicy, dir),
      ),
    )
    expect(tree.entries.length).toBe(1)
  })

  it("defaultPolicy(): T1 memory writes fail closed (ask, no approver) — production default", async () => {
    const dir = tmpRoot()
    const err = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const mem = yield* MemoryService
          return yield* Effect.flip(
            mem.set("profile", "k", "v"),
          )
        }),
        stackWithPolicy(defaultPolicy(), dir),
      ),
    )
    expect(err).toBeInstanceOf(PermissionDenied)
    const denied = err as PermissionDenied
    expect(denied.tool).toBe("memory:kv:profile:write")
    expect(denied.tier).toBe("T1")
  })
})

describe("substrate path derivation", () => {
  it("memory dirs resolve under the canonical state home", () => {
    const base = resolvePaths()
    const dirs = resolveMemoryDirs()
    expect(dirs.sessionsDir).toBe(path.join(base.state, "memory", "sessions"))
    expect(dirs.storesDir).toBe(path.join(base.state, "memory", "stores"))
  })
})
