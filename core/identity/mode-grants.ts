/**
 * identity/mode-grants.ts — per-instance mode grants (architecture Part 02 §1.4, §1.6).
 *
 * Mode grants (e.g. `intimate-mode`, `ambient-listening`) are per-instance
 * capability flags the user sets explicitly ON THIS INSTANCE. They live in
 * this instance's XDG config dir (`mode-grants.json`, 0600) and are NEVER
 * transferable by pairing sync (§1.4: three systems may share memories and
 * locker secrets, but only the office instance enters intimate mode — because
 * the grant lives on the office instance's config, set by the user there).
 *
 * Structural non-transferability: a `ModeGrant` carries the owning instance's
 * UUID. Any grant presented for a different instanceId is rejected typed
 * (`mode-grant-wrong-instance`). There is no code path that applies a foreign
 * grant locally, and the sync transport must never carry mode grants — see
 * the structural test in `mode-grants.test.ts`.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Schema } from "effect"

import { IdentityError } from "../substrate/errors.js"
import type { AimyPaths } from "../substrate/config.js"
import type { InstanceId } from "../substrate/types.js"
import { UuidV4Schema } from "./identity.js"

/** File name inside the XDG config dir. Per-instance state — never synced. */
export const MODE_GRANTS_FILE_NAME = "mode-grants.json"

/** User-defined mode name: non-empty, trimmed, bounded length. */
export const ModeNameSchema = Schema.String.pipe(
  Schema.refine((s): s is string => s.trim().length > 0 && s.length <= 64, {
    message: "mode name must be a non-empty string of at most 64 characters"
  })
)

/**
 * A user-set mode grant on ONE instance. The embedded `instanceId` is the
 * structural seal: this grant is meaningful only on that instance, and
 * presenting it elsewhere is a typed refusal. `grantedBy` is `"user"` —
 * mode grants are never set by sync, modules, or background forks.
 */
export const ModeGrantSchema = Schema.Struct({
  mode: ModeNameSchema,
  instanceId: UuidV4Schema,
  grantedAt: Schema.String, // ISO-8601 UTC
  grantedBy: Schema.Literal("user")
})

export interface ModeGrant extends Schema.Schema.Type<typeof ModeGrantSchema> {}

/** The on-disk store: a map of mode name → grant. */
const ModeGrantStoreSchema = Schema.Record(Schema.String, ModeGrantSchema)

const storeFile = (paths: AimyPaths): string => path.join(paths.config, MODE_GRANTS_FILE_NAME)

const readIfExists = (file: string): Effect.Effect<string | null, IdentityError> =>
  Effect.tryPromise({
    try: () =>
      fs.readFile(file, "utf-8").catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null
        throw cause
      }),
    catch: () => new IdentityError({ reason: "mode-grants-store-unreadable" })
  })

const writeFilePrivate = (file: string, data: string): Effect.Effect<void, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.writeFile(file, data, { mode: 0o600 })
      await fs.chmod(file, 0o600) // belt-and-braces: umask must not widen this
    },
    catch: () => new IdentityError({ reason: "mode-grants-store-unwritable" })
  })

const readStore = (
  paths: AimyPaths
): Effect.Effect<{ readonly [mode: string]: ModeGrant }, IdentityError> =>
  Effect.gen(function* () {
    const existing = yield* readIfExists(storeFile(paths))
    if (existing === null) return {}
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(existing) as unknown,
      catch: () => new IdentityError({ reason: "mode-grants-store-corrupt" })
    })
    return yield* Schema.decodeUnknownEffect(ModeGrantStoreSchema)(parsed).pipe(
      Effect.mapError(() => new IdentityError({ reason: "mode-grants-store-corrupt" }))
    )
  })

/**
 * Structural guard: a grant is valid only on its owning instance. A grant
 * presented for another instanceId is rejected typed — this is what makes
 * mode grants non-transferable by construction.
 */
export const validateModeGrantForInstance = (
  grant: ModeGrant,
  instanceId: InstanceId
): Effect.Effect<void, IdentityError> =>
  grant.instanceId === instanceId
    ? Effect.void
    : Effect.fail(new IdentityError({ reason: "mode-grant-wrong-instance" }))

/** All mode grants set on this instance (empty when none have been set). */
export const listModeGrants = (
  paths: AimyPaths,
  instanceId: InstanceId
): Effect.Effect<ReadonlyArray<ModeGrant>, IdentityError> =>
  Effect.gen(function* () {
    const store = yield* readStore(paths)
    const grants = Object.values(store)
    for (const grant of grants) {
      yield* validateModeGrantForInstance(grant, instanceId)
    }
    return grants
  })

/** Whether the user has set `mode` on this instance. */
export const hasModeGrant = (
  paths: AimyPaths,
  instanceId: InstanceId,
  mode: string
): Effect.Effect<boolean, IdentityError> =>
  Effect.map(listModeGrants(paths, instanceId), (grants) => grants.some((g) => g.mode === mode))

/**
 * Set a mode grant on THIS instance (user action). Idempotent: setting an
 * already-granted mode refreshes its timestamp. The grant is stamped with
 * this instance's id at write time — callers cannot forge another
 * instance's grant through this operation.
 */
export const setModeGrant = (
  paths: AimyPaths,
  instanceId: InstanceId,
  mode: string
): Effect.Effect<ModeGrant, IdentityError> =>
  Effect.gen(function* () {
    const name = yield* Schema.decodeUnknownEffect(ModeNameSchema)(mode).pipe(
      Effect.mapError(() => new IdentityError({ reason: "mode-grant-invalid" }))
    )
    // Fail-closed: the caller's instance id must itself be a valid UUIDv4
    // before it is stamped into the grant.
    const uuid = yield* Schema.decodeUnknownEffect(UuidV4Schema)(instanceId).pipe(
      Effect.mapError(() => new IdentityError({ reason: "mode-grant-invalid" }))
    )
    const grant: ModeGrant = {
      mode: name.trim(),
      instanceId: uuid,
      grantedAt: new Date().toISOString(),
      grantedBy: "user"
    }
    const store = yield* readStore(paths)
    const next = { ...store, [grant.mode]: grant }
    yield* writeFilePrivate(storeFile(paths), JSON.stringify(next, null, 2) + "\n")
    return grant
  })

/**
 * Revoke a mode grant on THIS instance. Revoking a mode that was never
 * granted fails typed (`mode-grant-unknown`) — never silently.
 */
export const revokeModeGrant = (
  paths: AimyPaths,
  instanceId: InstanceId,
  mode: string
): Effect.Effect<ModeGrant, IdentityError> =>
  Effect.gen(function* () {
    const store = yield* readStore(paths)
    const existing = store[mode.trim()]
    if (existing === undefined) {
      return yield* Effect.fail(new IdentityError({ reason: "mode-grant-unknown" }))
    }
    yield* validateModeGrantForInstance(existing, instanceId)
    const next = { ...store }
    delete next[mode.trim()]
    yield* writeFilePrivate(storeFile(paths), JSON.stringify(next, null, 2) + "\n")
    return existing
  })
