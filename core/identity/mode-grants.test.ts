/**
 * mode-grants.test.ts — per-instance mode grant behavior.
 *
 * - Grants are user-set on THIS instance and stamped with this instance's
 *   id; revoke of an unknown mode fails typed.
 * - STRUCTURAL non-transferability: a grant carrying another instance's id
 *   is rejected typed — whether presented in memory or found on disk. There
 *   is no operation that applies a foreign grant locally.
 */
import * as os from "node:os"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { IdentityError } from "../substrate/errors.js"
import { Redacted, InstanceId } from "../substrate/types.js"
import type { AimyPaths } from "../substrate/config.js"
import { IdentityService, IdentityStackLive } from "./identity.js"
import {
  MODE_GRANTS_FILE_NAME,
  ModeGrantSchema,
  hasModeGrant,
  listModeGrants,
  revokeModeGrant,
  setModeGrant,
  validateModeGrantForInstance,
  type ModeGrant
} from "./mode-grants.js"

const makePaths = async (): Promise<{ root: string; paths: AimyPaths }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimy-modegrants-test-"))
  return {
    root,
    paths: {
      data: path.join(root, "data"),
      config: path.join(root, "config"),
      state: path.join(root, "state")
    }
  }
}

const stackFor = (paths: AimyPaths, passphrase = "test-passphrase-modegrants") =>
  IdentityStackLive({ passphrase: Redacted.make(passphrase), paths })

/** Resolve paths + this install's instanceId via the real identity stack. */
const withInstance = <A, E>(
  paths: AimyPaths,
  use: (instanceId: InstanceId) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const svc = yield* IdentityService
    return yield* use(svc.instanceId)
  }).pipe(Effect.provide(stackFor(paths)))

describe("mode grants", () => {
  it.effect("sets a grant stamped with this instance's id (user-set, local only)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const grant = yield* withInstance(paths, (id) => setModeGrant(paths, id, "intimate-mode"))

      expect(grant.mode).toBe("intimate-mode")
      expect(grant.grantedBy).toBe("user")
      expect(Number.isNaN(Date.parse(grant.grantedAt))).toBe(false)

      const instanceId = yield* withInstance(paths, (id) => Effect.succeed(id))
      expect(grant.instanceId).toBe(instanceId)

      const grants = yield* withInstance(paths, (id) => listModeGrants(paths, id))
      expect(grants).toHaveLength(1)
      expect(grants[0]).toEqual(grant)
      expect(yield* withInstance(paths, (id) => hasModeGrant(paths, id, "intimate-mode"))).toBe(true)
      expect(yield* withInstance(paths, (id) => hasModeGrant(paths, id, "ambient-listening"))).toBe(false)

      // Store file stays private
      const stat = yield* Effect.promise(() => fs.stat(path.join(paths.config, MODE_GRANTS_FILE_NAME)))
      expect(stat.mode & 0o777).toBe(0o600)
    })
  )

  it.effect("set is idempotent (no duplicate entries)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* withInstance(paths, (id) => setModeGrant(paths, id, "intimate-mode"))
      yield* withInstance(paths, (id) => setModeGrant(paths, id, "intimate-mode"))
      const grants = yield* withInstance(paths, (id) => listModeGrants(paths, id))
      expect(grants).toHaveLength(1)
    })
  )

  it.effect("revokes a granted mode; revoking an unknown mode fails typed", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const granted = yield* withInstance(paths, (id) => setModeGrant(paths, id, "intimate-mode"))
      const revoked = yield* withInstance(paths, (id) => revokeModeGrant(paths, id, "intimate-mode"))
      expect(revoked).toEqual(granted)
      expect(yield* withInstance(paths, (id) => hasModeGrant(paths, id, "intimate-mode"))).toBe(false)

      const failure = yield* Effect.flip(
        withInstance(paths, (id) => revokeModeGrant(paths, id, "intimate-mode"))
      )
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("mode-grant-unknown")
    })
  )

  it.effect("refuses an empty mode name (typed)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const failure = yield* Effect.flip(withInstance(paths, (id) => setModeGrant(paths, id, "   ")))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("mode-grant-invalid")
    })
  )

  it.effect("structural: a grant for another instance is rejected in memory", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const ownId = yield* withInstance(paths, (id) => Effect.succeed(id))
      // A grant owned by a DIFFERENT instance (e.g. one carried over a pairing sync payload)
      const foreign: ModeGrant = yield* Schema.decodeUnknownEffect(ModeGrantSchema)({
        mode: "intimate-mode",
        instanceId: "123e4567-e89b-42d3-a456-426614174000",
        grantedAt: new Date().toISOString(),
        grantedBy: "user"
      })
      const failure = yield* Effect.flip(validateModeGrantForInstance(foreign, ownId))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("mode-grant-wrong-instance")
      // And a grant for the owning instance validates clean
      const own: ModeGrant = { ...foreign, instanceId: ownId as ModeGrant["instanceId"] }
      yield* validateModeGrantForInstance(own, ownId)
    })
  )

  it.effect("structural: a foreign grant smuggled into the store is rejected at read", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const ownId = yield* withInstance(paths, (id) => Effect.succeed(id))
      // Simulate a store file containing a grant owned by another instance
      yield* Effect.promise(() => fs.mkdir(paths.config, { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(paths.config, MODE_GRANTS_FILE_NAME),
          JSON.stringify({
            "intimate-mode": {
              mode: "intimate-mode",
              instanceId: "123e4567-e89b-42d3-a456-426614174000",
              grantedAt: new Date().toISOString(),
              grantedBy: "user"
            }
          })
        )
      )
      const failure = yield* Effect.flip(withInstance(paths, (id) => listModeGrants(paths, id)))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("mode-grant-wrong-instance")
      expect(ownId).not.toBe("123e4567-e89b-42d3-a456-426614174000")
    })
  )
})
