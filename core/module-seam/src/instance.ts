/**
 * Instance-awareness — modules know which AImy they run on.
 *
 * Every install generates a UUID at first run, offline (IdentityService).
 * All per-instance state (memories, skills, locker entries, module config) is
 * keyed under it. Modules receive their instance UUID plus instance-scoped
 * config in the sandboxed ModuleApi, so a module can behave per-instance
 * (e.g. only the office instance enters intimate mode; the dev instance gets
 * verbose tooling).
 *
 * The UUID itself is consumed via a structural seam (`IdentitySeam`); the
 * real IdentityService wires at integration. Any outward reporting of UUIDs
 * is strictly opt-in per the MoSCoW tension note — this seam never phones home.
 */
import { Context, Effect } from "effect"
import { ModuleError } from "./errors.js"

/** What a module receives about the instance it runs on. */
export interface InstanceContext {
  readonly instanceId: string
  readonly moduleId: string
  /** Instance-scoped config for this module (from install / per-instance config). */
  readonly config: Readonly<Record<string, unknown>>
}

/** Structural seam for the identity UUID. The real IdentityService wires at integration. */
export interface IdentitySeam {
  readonly getInstanceId: () => Effect.Effect<string, ModuleError>
}

export class IdentitySeamTag extends Context.Service<IdentitySeamTag, IdentitySeam>()(
  "aimy/module-seam/IdentitySeam"
) {}

/** Build the per-module instance context: identity UUID + instance-scoped config. */
export const makeInstanceContext = (
  identity: IdentitySeam,
  moduleId: string,
  config: Readonly<Record<string, unknown>> = {}
): Effect.Effect<InstanceContext, ModuleError> =>
  Effect.map(identity.getInstanceId(), (instanceId) => ({ instanceId, moduleId, config }))

/** Read one instance-scoped config value. Unknown keys are `undefined` (fail-closed at use). */
export const configValue = (ctx: InstanceContext, key: string): unknown => ctx.config[key]

/** Structural stub for tests: fixed instance UUID. */
export const stubIdentitySeam = (instanceId: string): IdentitySeam => ({
  getInstanceId: () =>
    instanceId.trim() === ""
      ? Effect.fail(new ModuleError({ module: "<identity>", reason: "instance UUID is empty" }))
      : Effect.succeed(instanceId)
})
