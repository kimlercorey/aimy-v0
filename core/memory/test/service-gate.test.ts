/**
 * service-gate.test.ts — the PermissionGate is consulted on EVERY operation.
 *
 * DenyAllGate must make append/read/branch/fork/get/set all fail with
 * PermissionDenied. AllowAllGate must let a full session + kv round-trip work.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PermissionDenied } from "../errors-shim.js"
import {
  AllowAllGate,
  DenyAllGate,
  KvNamespace,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
} from "../service.js"
import { resolvePaths } from "../paths-shim.js"

const tmpRoots: string[] = []
const testPathsLayer = (): Layer.Layer<MemoryPaths> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-svc-test-"))
  tmpRoots.push(dir)
  const base = resolvePaths()
  return Layer.succeed(MemoryPaths, {
    ...base,
    sessionsDir: path.join(dir, "sessions"),
    storesDir: path.join(dir, "stores"),
  })
}
afterEach(() => {
  for (const d of tmpRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const withGate = (gate: Layer.Layer<import("../service.js").PermissionGate>) =>
  Layer.provide(MemoryServiceLive, Layer.mergeAll(gate, testPathsLayer()))

const runP = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff)

describe("DenyAllGate: every op fails with PermissionDenied", () => {
  const layer = withGate(DenyAllGate)
  const expectDenied = async (eff: Effect.Effect<unknown, unknown>, op: string) => {
    const err = await runP(Effect.flip(Effect.provide(eff, layer)))
    expect(err, op).toBeInstanceOf(PermissionDenied)
    expect((err as PermissionDenied)._tag).toBe("PermissionDenied")
  }

  it("append is denied", async () => {
    await expectDenied(
      Effect.flatMap(MemoryService, (m) => m.append("s1", { parentId: null, kind: "message", payload: {} })),
      "append",
    )
  })
  it("read is denied", async () => {
    await expectDenied(Effect.flatMap(MemoryService, (m) => m.read("s1")), "read")
  })
  it("branch is denied", async () => {
    await expectDenied(Effect.flatMap(MemoryService, (m) => m.branch("s1", "x")), "branch")
  })
  it("fork is denied", async () => {
    await expectDenied(Effect.flatMap(MemoryService, (m) => m.fork("s1", "s2")), "fork")
  })
  it("kv get is denied", async () => {
    const ns: KvNamespace = "profile"
    await expectDenied(Effect.flatMap(MemoryService, (m) => m.get(ns, "k")), "get")
  })
  it("kv set is denied", async () => {
    const ns: KvNamespace = "profile"
    await expectDenied(Effect.flatMap(MemoryService, (m) => m.set(ns, "k", 1)), "set")
  })
})

describe("AllowAllGate: full session + kv round-trip", () => {
  const layer = withGate(AllowAllGate)
  const svc = Effect.provide(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)), layer)

  it("append -> read -> branch -> fork", async () => {
    const mem = await runP(svc)
    const provide = <A, E>(eff: Effect.Effect<A, E>) => runP(Effect.provide(eff, layer))

    const root = await provide(mem.append("s1", { parentId: null, kind: "message", payload: { role: "user" } }))
    const child = await provide(
      mem.append("s1", { parentId: root.id, kind: "message", payload: { role: "assistant" } }),
    )
    expect(child.parentId).toBe(root.id)

    const tree = await provide(mem.read("s1"))
    expect(tree.entries).toHaveLength(2)

    const path = await provide(mem.branch("s1", child.id))
    expect(path.map((e) => e.id)).toEqual([root.id, child.id])

    await provide(mem.fork("s1", "s2"))
    const clone = await provide(mem.read("s2"))
    expect(clone.entries.map((e) => e.id)).toEqual([root.id, child.id])
  })

  it("kv set/get is namespaced, versioned, last-write-wins", async () => {
    const mem = await runP(svc)
    const provide = <A, E>(eff: Effect.Effect<A, E>) => runP(Effect.provide(eff, layer))

    expect(await provide(mem.get("profile", "missing"))).toBeUndefined()
    await provide(mem.set("profile", "name", "Kimler"))
    await provide(mem.set("profile", "name", "Kimler C."))
    await provide(mem.set("environment", "name", "should-not-leak"))
    expect(await provide(mem.get("profile", "name"))).toBe("Kimler C.")
    expect(await provide(mem.get("environment", "name"))).toBe("should-not-leak")
  })

  it("invalid session id is rejected", async () => {
    const mem = await runP(svc)
    const err = await runP(Effect.flip(Effect.provide(mem.read("../../etc"), layer)))
    expect(err._tag).toBe("MemoryStoreError")
  })
})
