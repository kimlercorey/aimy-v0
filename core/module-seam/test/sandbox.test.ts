/** Sandbox posture: stubs fail closed, DirectGate serves T0/T1 through the kernel seam. */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  LinuxNamespacesBackendStub,
  PermissionDenied,
  SandboxViolation,
  SeatbeltBackendStub,
  WasmRunnerStub,
  allowAllKernel,
  isDirectGate,
  makeBackendSet,
  makeDenyAllKernel,
  makeDirectGate,
  resolveBackend,
  toolIntent
} from "../src/index.js"

describe("sandbox backends", () => {
  it.effect("OS-native stubs report unhealthy-by-default (honest status)", () =>
    Effect.gen(function* () {
      for (const backend of [SeatbeltBackendStub, LinuxNamespacesBackendStub]) {
        const health = yield* backend.healthCheck()
        expect(health.healthy).toBe(false)
        if (!health.healthy) {
          expect(health.reason).toContain("not yet implemented")
        }
      }
    })
  )

  it.effect("stub spawn refuses fail-closed with typed SandboxViolation", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        SeatbeltBackendStub.spawn({
          moduleId: "m",
          entrypoint: "hooks.js",
          argv: [],
          env: {},
          tier: "T2"
        })
      )
      expect(err).toBeInstanceOf(SandboxViolation)
      expect((err as SandboxViolation).backend).toBe("seatbelt-darwin")
    })
  )

  it.effect("resolveBackend: T2+ with unhealthy stub refuses to run (fail-closed)", () =>
    Effect.gen(function* () {
      const set = makeBackendSet(makeDirectGate(allowAllKernel))
      const err = yield* Effect.flip(resolveBackend(set, "T2", "linux"))
      expect(err).toBeInstanceOf(SandboxViolation)
      expect((err as SandboxViolation).reason).toContain("fail-closed")
      expect((err as SandboxViolation).backend).toBe("linux-namespaces-seccomp")
    })
  )

  it.effect("resolveBackend: unknown platform refuses to run", () =>
    Effect.gen(function* () {
      const set = { ...makeBackendSet(makeDirectGate(allowAllKernel)), osBackends: [] }
      const err = yield* Effect.flip(resolveBackend(set, "T3", "linux"))
      expect(err).toBeInstanceOf(SandboxViolation)
      expect((err as SandboxViolation).reason).toContain("refusing to run tier T3 on host")
    })
  )

  it.effect("resolveBackend: T0/T1 resolve to the DirectGate", () =>
    Effect.gen(function* () {
      const set = makeBackendSet(makeDirectGate(allowAllKernel))
      for (const tier of ["T0", "T1"] as const) {
        const backend = yield* resolveBackend(set, tier, "linux")
        expect(isDirectGate(backend)).toBe(true)
        const health = yield* backend.healthCheck()
        expect(health.healthy).toBe(true)
      }
    })
  )

  it.effect("DirectGate runs T0/T1 through the kernel seam", () =>
    Effect.gen(function* () {
      const gate = makeDirectGate(allowAllKernel)
      const result = yield* gate.run(toolIntent("m", "web_fetch", "T1", "fetch"), Effect.succeed(42))
      expect(result).toBe(42)
    })
  )

  it.effect("DirectGate rejects tiers above T1 fail-closed", () =>
    Effect.gen(function* () {
      const gate = makeDirectGate(allowAllKernel)
      const err = yield* Effect.flip(
        gate.run(toolIntent("m", "code_exec", "T2", "exec"), Effect.succeed(1))
      )
      expect(err).toBeInstanceOf(SandboxViolation)
      expect((err as SandboxViolation).backend).toBe("direct-gate")
    })
  )

  it.effect("DirectGate routes kernel denials without running the effect", () =>
    Effect.gen(function* () {
      const gate = makeDirectGate(makeDenyAllKernel(false, "denied"))
      let ran = false
      const err = yield* Effect.flip(
        gate.run(toolIntent("m", "web_fetch", "T0", "fetch"), Effect.sync(() => { ran = true }))
      )
      expect(err).toBeInstanceOf(PermissionDenied)
      expect(ran).toBe(false)
    })
  )

  it.effect("WasmRunner stub refuses with typed SandboxViolation", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(WasmRunnerStub.runScript(new Uint8Array([0, 1, 2]), {}))
      expect(err).toBeInstanceOf(SandboxViolation)
      expect((err as SandboxViolation).backend).toBe("wasm-stub")
    })
  )
})
