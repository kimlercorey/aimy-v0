/** Capability enforcement helpers: filesystem / memory / subprocess / tool allowlist. */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  CapabilityDenied,
  enforceEgress,
  enforceFsRead,
  enforceFsWrite,
  enforceMemoryStore,
  enforceMemoryWrite,
  enforceSubprocess,
  enforceToolContribution
} from "../src/index.js"
import { testManifest } from "./fixtures.js"

const expectDenied = (eff: Effect.Effect<void, CapabilityDenied>, capability: string) =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(eff)
    expect(err).toBeInstanceOf(CapabilityDenied)
    expect(err.capability).toBe(capability)
    return err
  })

describe("capability enforcement", () => {
  it.effect("tool-contribution allowlist: declared ok, undeclared denied", () =>
    Effect.gen(function* () {
      const m = testManifest({ tools: ["web_fetch"] })
      yield* enforceToolContribution(m, "mod", "web_fetch")
      const err = yield* expectDenied(enforceToolContribution(m, "mod", "code_exec"), "tool.contribution")
      expect(err.reason).toContain("undeclared = denied")
    })
  )

  it.effect("filesystem scopes: within scope ok, outside denied (no prefix-sibling leak)", () =>
    Effect.gen(function* () {
      const m = testManifest({ filesystem: { read: ["/data/retrieval"], write: ["/data/retrieval/out"] } })
      yield* enforceFsRead(m, "mod", "/data/retrieval")
      yield* enforceFsRead(m, "mod", "/data/retrieval/papers/a.pdf")
      yield* enforceFsWrite(m, "mod", "/data/retrieval/out/report.md")
      // Prefix sibling is NOT within scope.
      yield* expectDenied(enforceFsRead(m, "mod", "/data/retrieval-private"), "fs.read")
      // Write scope does not grant read elsewhere; read scope does not grant write.
      yield* expectDenied(enforceFsWrite(m, "mod", "/data/retrieval/papers/a.pdf"), "fs.write")
      yield* expectDenied(enforceFsRead(m, "mod", "/etc/passwd"), "fs.read")
    })
  )

  it.effect("memory scopes: declared stores ok, undeclared store and write denied", () =>
    Effect.gen(function* () {
      const m = testManifest({ memory: { stores: ["retrieval"], write: false } })
      yield* enforceMemoryStore(m, "mod", "retrieval")
      yield* expectDenied(enforceMemoryStore(m, "mod", "identity"), "memory.store")
      yield* expectDenied(enforceMemoryWrite(m, "mod"), "memory.write")
      const w = testManifest({ memory: { stores: ["retrieval"], write: true } })
      yield* enforceMemoryWrite(w, "mod")
    })
  )

  it.effect("subprocess rights default-deny", () =>
    Effect.gen(function* () {
      const m = testManifest({ subprocess: false })
      const err = yield* expectDenied(enforceSubprocess(m, "mod"), "subprocess")
      expect(err.reason).toContain("default-deny")
      yield* enforceSubprocess(testManifest({ subprocess: true }), "mod")
    })
  )

  it.effect("enforceEgress delegates to the EgressGate with typed denial", () =>
    Effect.gen(function* () {
      const m = testManifest({ network: "none" })
      yield* expectDenied(
        enforceEgress(m, { moduleId: "mod", host: "api.example" }, { firstPartyHosts: [] }),
        "network.egress"
      )
    })
  )
})
