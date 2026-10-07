/**
 * Capability enforcement helpers — the ModuleHost broker's gates for
 * filesystem / memory / subprocess syscalls arriving from the sandbox
 * (architecture §2.5: "the ModuleHost broker for filesystem/network/
 * subprocess syscalls from the sandbox").
 *
 * Each helper is an Effect that succeeds (void) when the manifest declares
 * the capability and fails with a typed `CapabilityDenied` when it does not.
 * Anything undeclared is denied — fail-closed, never a silent no-op.
 *
 * These sit behind the same rule as the tool-contribution allowlist in
 * `ModuleHost.callTool`: the manifest is checked FIRST, before any hook,
 * kernel check, or execution.
 */
import { Effect } from "effect"
import { CapabilityDenied } from "./errors.js"
import {
  type CapabilityManifest,
  canReadPath,
  canSpawnSubprocess,
  canUseMemoryStore,
  canWriteMemory,
  canWritePath,
  declaresTool
} from "./manifest.js"
import { type EgressContext, type EgressRequest, checkEgress } from "./egress.js"

const deny = (
  moduleId: string,
  capability: string,
  requested: string,
  reason: string
): Effect.Effect<never, CapabilityDenied> =>
  Effect.fail(new CapabilityDenied({ module: moduleId, capability, requested, reason }))

/** Tool-contribution allowlist: the module may only contribute declared tools. */
export const enforceToolContribution = (
  manifest: CapabilityManifest,
  moduleId: string,
  tool: string
): Effect.Effect<void, CapabilityDenied> =>
  declaresTool(manifest, tool)
    ? Effect.void
    : deny(
        moduleId,
        "tool.contribution",
        tool,
        `tool '${tool}' is not in the module's declared tool-contribution allowlist ` +
          `[${manifest.tools.join(", ")}] (undeclared = denied)`
      )

/** Filesystem read scope: the path must sit under a declared read scope. */
export const enforceFsRead = (
  manifest: CapabilityManifest,
  moduleId: string,
  path: string
): Effect.Effect<void, CapabilityDenied> =>
  canReadPath(manifest, path)
    ? Effect.void
    : deny(
        moduleId,
        "fs.read",
        path,
        `path '${path}' is outside the declared read scopes [${manifest.filesystem.read.join(", ")}]`
      )

/** Filesystem write scope: the path must sit under a declared write scope. */
export const enforceFsWrite = (
  manifest: CapabilityManifest,
  moduleId: string,
  path: string
): Effect.Effect<void, CapabilityDenied> =>
  canWritePath(manifest, path)
    ? Effect.void
    : deny(
        moduleId,
        "fs.write",
        path,
        `path '${path}' is outside the declared write scopes [${manifest.filesystem.write.join(", ")}]`
      )

/** Memory scope: reads/writes only against declared stores. */
export const enforceMemoryStore = (
  manifest: CapabilityManifest,
  moduleId: string,
  store: string
): Effect.Effect<void, CapabilityDenied> =>
  canUseMemoryStore(manifest, store)
    ? Effect.void
    : deny(
        moduleId,
        "memory.store",
        store,
        `memory store '${store}' is not declared [${manifest.memory.stores.join(", ")}]`
      )

/** Memory write: the manifest must explicitly enable it. */
export const enforceMemoryWrite = (
  manifest: CapabilityManifest,
  moduleId: string
): Effect.Effect<void, CapabilityDenied> =>
  canWriteMemory(manifest)
    ? Effect.void
    : deny(moduleId, "memory.write", "write", "manifest does not declare memory write (default deny)")

/** Subprocess rights: default deny; the manifest must explicitly enable them. */
export const enforceSubprocess = (
  manifest: CapabilityManifest,
  moduleId: string
): Effect.Effect<void, CapabilityDenied> =>
  canSpawnSubprocess(manifest)
    ? Effect.void
    : deny(
        moduleId,
        "subprocess",
        "spawn",
        "subprocess rights default-deny; manifest does not declare them"
      )

/** Network egress: delegates to the EgressGate (see egress.ts). */
export const enforceEgress = (
  manifest: CapabilityManifest,
  request: EgressRequest,
  ctx: EgressContext
): Effect.Effect<void, CapabilityDenied> => checkEgress(manifest, request, ctx)
