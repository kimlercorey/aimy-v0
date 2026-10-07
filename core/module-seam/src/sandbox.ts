/**
 * Sandbox backends — the outer membrane around module execution.
 *
 * LOCKED DECISION (hybrid sandbox):
 * - OS-native per platform (Seatbelt on macOS, namespaces+seccomp on Linux)
 * - WASM for skill scripts
 * - In-process permission gate for T0/T1
 * - NO container dependency
 *
 * THIS PHASE: the `SandboxBackend` interface is the deliverable. OS-native
 * backends ship as documented STUBS that report unhealthy-by-default, so
 * module execution refuses to run fail-closed (Hermes #61882: "config not
 * loaded / stale environment" never means "run on host"). The working
 * execution path for T0/T1 is `DirectGate`: in-process execution through the
 * SafetyKernel seam. Real OS backends are a later milestone.
 *
 * Pi #9824: TypeScript types are not a security boundary. Enforcement lives
 * in the host process (kernel seam) and the OS backend — never in types alone.
 */
import { Effect } from "effect"
import { PermissionDenied, SandboxViolation, TurnTerminated } from "./errors.js"
import { HookError } from "./errors.js"
import { type CapabilityTier, type SafetyKernelSeam, type ToolIntent } from "./kernel-seam.js"

export type Platform = "darwin" | "linux"

export interface SpawnSpec {
  readonly moduleId: string
  readonly entrypoint: string
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly tier: CapabilityTier
}

export interface SpawnHandle {
  readonly kill: () => Effect.Effect<void, SandboxViolation>
}

export type BackendHealth =
  | { readonly healthy: true; readonly detail: string }
  | { readonly healthy: false; readonly reason: string }

export interface SandboxBackend {
  readonly name: string
  readonly platform: Platform
  readonly healthCheck: () => Effect.Effect<BackendHealth, SandboxViolation>
  readonly spawn: (spec: SpawnSpec) => Effect.Effect<SpawnHandle, SandboxViolation | PermissionDenied>
}

const unhealthySpawn = (name: string, reason: string) => (_spec: SpawnSpec) =>
  Effect.fail(new SandboxViolation({ reason: `spawn refused: ${reason}`, backend: name }))

/**
 * macOS Seatbelt backend — STUB. Reports unhealthy-by-default with an honest
 * status; any spawn attempt fails closed. Real implementation is a later
 * milestone (sandbox-exec / Seatbelt profile application).
 */
export const SeatbeltBackendStub: SandboxBackend = {
  name: "seatbelt-darwin",
  platform: "darwin",
  healthCheck: () =>
    Effect.succeed({
      healthy: false,
      reason: "Seatbelt backend not yet implemented (later milestone); refusing to run modules outside the in-process gate."
    } satisfies BackendHealth),
  spawn: unhealthySpawn("seatbelt-darwin", "backend unhealthy: Seatbelt backend not yet implemented")
}

/**
 * Linux namespaces+seccomp backend — STUB. Reports unhealthy-by-default with
 * an honest status; any spawn attempt fails closed. Real implementation is a
 * later milestone (unshare + seccomp-bpf profile).
 */
export const LinuxNamespacesBackendStub: SandboxBackend = {
  name: "linux-namespaces-seccomp",
  platform: "linux",
  healthCheck: () =>
    Effect.succeed({
      healthy: false,
      reason: "Linux namespaces/seccomp backend not yet implemented (later milestone); refusing to run modules outside the in-process gate."
    } satisfies BackendHealth),
  spawn: unhealthySpawn("linux-namespaces-seccomp", "backend unhealthy: namespaces/seccomp backend not yet implemented")
}

/**
 * DirectGate — the working in-process execution path for T0/T1.
 * Every execution goes through the SafetyKernel seam; tiers above T1 are
 * rejected (they require a real OS backend, fail-closed).
 */
export interface DirectGate {
  readonly name: "direct-gate"
  readonly healthCheck: () => Effect.Effect<BackendHealth, SandboxViolation>
  readonly run: <A, E>(
    intent: ToolIntent,
    effect: Effect.Effect<A, E>
  ) => Effect.Effect<A, E | PermissionDenied | TurnTerminated | HookError | SandboxViolation>
}

export const makeDirectGate = (kernel: SafetyKernelSeam): DirectGate => ({
  name: "direct-gate",
  healthCheck: () =>
    Effect.succeed({ healthy: true, detail: "in-process permission gate via SafetyKernel seam (T0/T1 only)" } satisfies BackendHealth),
  run: (intent, effect) => {
    if (intent.tier !== "T0" && intent.tier !== "T1") {
      return Effect.fail(
        new SandboxViolation({
          reason: `DirectGate serves T0/T1 only; tier ${intent.tier} requires a healthy OS sandbox backend`,
          backend: "direct-gate"
        })
      )
    }
    return kernel.execute(intent, effect)
  }
})

/** Type guard: DirectGate is the in-process T0/T1 path; anything else spawns out-of-process. */
export const isDirectGate = (backend: DirectGate | SandboxBackend): backend is DirectGate =>
  backend.name === "direct-gate"

/**
 * WasmRunner — runs skill scripts (the `scripts/` dir of a module package)
 * inside a WASM sandbox. Interface + stub only; the real WASM runtime
 * (WASI capability wiring) is a later milestone.
 */
export interface WasmRunner {
  readonly name: string
  readonly runScript: (
    script: Uint8Array,
    input: unknown
  ) => Effect.Effect<unknown, SandboxViolation | PermissionDenied>
}

export const WasmRunnerStub: WasmRunner = {
  name: "wasm-stub",
  runScript: (_script, _input) =>
    Effect.fail(
      new SandboxViolation({
        reason: "WASM runtime not yet implemented (later milestone); skill scripts cannot run yet",
        backend: "wasm-stub"
      })
    )
}

export interface BackendSet {
  readonly directGate: DirectGate
  readonly osBackends: ReadonlyArray<SandboxBackend>
  readonly wasm: WasmRunner
}

export const makeBackendSet = (
  directGate: DirectGate,
  osBackends: ReadonlyArray<SandboxBackend> = [SeatbeltBackendStub, LinuxNamespacesBackendStub],
  wasm: WasmRunner = WasmRunnerStub
): BackendSet => ({ directGate, osBackends, wasm })

/**
 * Resolve the execution backend for a tier, fail-closed (Hermes #61882):
 * - T0/T1 -> DirectGate (in-process, kernel-gated).
 * - T2/T3 -> a healthy OS backend for this platform; unhealthy or absent
 *   means the module does NOT run (typed SandboxViolation, never host fallback).
 */
export const resolveBackend = (
  set: BackendSet,
  tier: CapabilityTier,
  platform: Platform
): Effect.Effect<DirectGate | SandboxBackend, SandboxViolation> => {
  if (tier === "T0" || tier === "T1") {
    return Effect.succeed(set.directGate)
  }
  const backend = set.osBackends.find((b) => b.platform === platform)
  if (backend === undefined) {
    return Effect.fail(
      new SandboxViolation({ reason: `no OS sandbox backend for platform '${platform}'; refusing to run tier ${tier} on host` })
    )
  }
  return Effect.flatMap(backend.healthCheck(), (health) =>
    health.healthy
      ? Effect.succeed(backend)
      : Effect.fail(
          new SandboxViolation({
            reason: `sandbox backend '${backend.name}' unhealthy: ${health.reason}; refusing to run (fail-closed)`,
            backend: backend.name
          })
        )
  )
}
