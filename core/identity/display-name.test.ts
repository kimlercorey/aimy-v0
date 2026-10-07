/**
 * display-name.test.ts — display-name rename behavior.
 *
 * - Rename persists the new name, preserving version/history (createdAt,
 *   publicKey, pairingProtocolVersion, instanceId untouched).
 * - Every rename returns an audit event AND appends it to the state audit
 *   trail — renames are never silent.
 * - Refusals are typed: empty/overlong names, renaming to the current name.
 */
import * as os from "node:os"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { IdentityError } from "../substrate/errors.js"
import { Redacted } from "../substrate/types.js"
import type { AimyPaths } from "../substrate/config.js"
import {
  DISPLAY_NAME_MAX_LENGTH,
  IDENTITY_AUDIT_FILE_NAME,
  renameDisplayName,
  type DisplayNameRenameEvent
} from "./display-name.js"
import { IdentityService, IdentityStackLive, type IdentityServiceShape } from "./identity.js"

const makePaths = async (): Promise<{ root: string; paths: AimyPaths }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimy-displayname-test-"))
  return {
    root,
    paths: {
      data: path.join(root, "data"),
      config: path.join(root, "config"),
      state: path.join(root, "state")
    }
  }
}

const stackFor = (paths: AimyPaths, passphrase = "test-passphrase-displayname") =>
  IdentityStackLive({ passphrase: Redacted.make(passphrase), paths })

const withService = <A, E>(
  paths: AimyPaths,
  use: (svc: IdentityServiceShape) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const svc = yield* IdentityService
    return yield* use(svc)
  }).pipe(Effect.provide(stackFor(paths)))

const readAuditEvents = (paths: AimyPaths): Effect.Effect<Array<DisplayNameRenameEvent>, IdentityError> =>
  Effect.promise(() =>
    fs
      .readFile(path.join(paths.state, IDENTITY_AUDIT_FILE_NAME), "utf-8")
      .then((raw) =>
        raw
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as DisplayNameRenameEvent)
      )
  ).pipe(
    Effect.mapError(() => new IdentityError({ reason: "identity-audit-unwritable" }))
  )

describe("display-name rename", () => {
  it.effect("persists the new name and preserves version/history", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const before = yield* withService(paths, (svc) => Effect.succeed(svc.document))
      const { document, event } = yield* withService(paths, (svc) => renameDisplayName(svc, paths, "office"))

      expect(document.displayName).toBe("office")
      // Everything else preserved by construction
      expect(document.version).toBe(before.version)
      expect(document.instanceId).toBe(before.instanceId)
      expect(document.createdAt).toBe(before.createdAt)
      expect(document.publicKey).toBe(before.publicKey)
      expect(document.pairingProtocolVersion).toBe(1)

      // The returned event names the previous value (null when none was set)
      expect(event.kind).toBe("display-name-renamed")
      expect(event.previousDisplayName).toBe(before.displayName ?? null)
      expect(event.displayName).toBe("office")
      expect(event.instanceId).toBe(before.instanceId)
      expect(Number.isNaN(Date.parse(event.at))).toBe(false)

      // A rebuilt service sees the renamed document (round-trip through the layer)
      const reloaded = yield* withService(paths, (svc) => Effect.succeed(svc.document))
      expect(reloaded).toEqual(document)

      // identity.json stays private
      const stat = yield* Effect.promise(() => fs.stat(path.join(paths.config, "identity.json")))
      expect(stat.mode & 0o777).toBe(0o600)
    })
  )

  it.effect("audit-logs every rename to the state audit trail (never silent)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* withService(paths, (svc) => renameDisplayName(svc, paths, "office"))
      yield* withService(paths, (svc) => renameDisplayName(svc, paths, "home-server"))

      const events = yield* readAuditEvents(paths)
      expect(events).toHaveLength(2)
      expect(events[0]?.displayName).toBe("office")
      expect(events[0]?.previousDisplayName).toBe(null)
      expect(events[1]?.displayName).toBe("home-server")
      expect(events[1]?.previousDisplayName).toBe("office")

      // Audit trail stays private
      const stat = yield* Effect.promise(() =>
        fs.stat(path.join(paths.state, IDENTITY_AUDIT_FILE_NAME))
      )
      expect(stat.mode & 0o777).toBe(0o600)
    })
  )

  it.effect("trims the new name", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const { document, event } = yield* withService(paths, (svc) =>
        renameDisplayName(svc, paths, "  laptop  ")
      )
      expect(document.displayName).toBe("laptop")
      expect(event.displayName).toBe("laptop")
    })
  )

  it.effect("refuses an empty or whitespace-only name (typed)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      for (const bad of ["", "   "]) {
        const failure = yield* Effect.flip(
          withService(paths, (svc) => renameDisplayName(svc, paths, bad))
        )
        expect(failure).toBeInstanceOf(IdentityError)
        expect(failure.reason).toBe("display-name-invalid")
      }
      // The document is untouched by refused renames
      const doc = yield* withService(paths, (svc) => Effect.succeed(svc.document))
      expect(doc.displayName).toBeUndefined()
    })
  )

  it.effect("refuses an overlong name (typed)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const tooLong = "x".repeat(DISPLAY_NAME_MAX_LENGTH + 1)
      const failure = yield* Effect.flip(withService(paths, (svc) => renameDisplayName(svc, paths, tooLong)))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("display-name-invalid")
    })
  )

  it.effect("refuses renaming to the current name (typed, never a silent no-op)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* withService(paths, (svc) => renameDisplayName(svc, paths, "office"))
      const failure = yield* Effect.flip(withService(paths, (svc) => renameDisplayName(svc, paths, "office")))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("display-name-unchanged")
      // No audit event for the refused no-op
      const events = yield* readAuditEvents(paths)
      expect(events).toHaveLength(1)
    })
  )
})
