/**
 * locker.test.ts — SecretLocker behavior.
 *
 * - store → retrieve round-trip returns the equal secret.
 * - Wrong passphrase fails typed (vault-unseal-failed), never silently.
 * - Manifest lists names/scopes only — stringify it and the plaintext is absent.
 * - Redacted values never leak via console/error/JSON paths on failure.
 * - Profile-scoped reads fail closed on scope mismatch (Hermes #93522).
 * - Vault file permissions are 0600.
 * - Keychain stub reports unavailable; ops fail typed.
 */
import * as os from "node:os"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { IdentityError } from "../substrate/errors.js"
import { InstanceId, Redacted } from "../substrate/types.js"
import type { AimyPaths } from "../substrate/config.js"
import {
  FileLockerLive,
  KeychainUnavailable,
  SecretLocker,
  type SecretLockerShape,
  type SecretScope
} from "./locker.js"

const makePaths = async (): Promise<{ root: string; paths: AimyPaths }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimy-locker-test-"))
  return {
    root,
    paths: {
      data: path.join(root, "data"),
      config: path.join(root, "config"),
      state: path.join(root, "state")
    }
  }
}

const INSTANCE_ID = InstanceId("123e4567-e89b-42d3-a456-426614174000")
const lockerFor = (paths: AimyPaths, passphrase: string) =>
  FileLockerLive({ passphrase: Redacted.make(passphrase), instanceId: INSTANCE_ID, paths })

const vaultFile = (paths: AimyPaths) =>
  path.join(paths.data, "123e4567-e89b-42d3-a456-426614174000", "locker", "vault.json")

const withLocker = <A, E>(
  paths: AimyPaths,
  use: (locker: SecretLockerShape) => Effect.Effect<A, E>,
  passphrase = "correct-horse-battery"
) =>
  Effect.gen(function* () {
    const locker = yield* SecretLocker
    return yield* use(locker)
  }).pipe(Effect.provide(lockerFor(paths, passphrase)))

const WORK: SecretScope = { profile: "work" }
const PERSONAL: SecretScope = { profile: "personal" }

describe("file-vault backend", () => {
  it.effect("store → retrieve round-trips the equal secret", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const secret = "ghp_supersecret_token_abc123"
      const retrieved = yield* withLocker(paths, (locker) =>
        Effect.gen(function* () {
          yield* locker.store("api/github-token", Redacted.make(secret), WORK)
          return yield* locker.retrieve("api/github-token", WORK)
        })
      )
      expect(retrieved.reveal()).toBe(secret)
    })
  )

  it.effect("persists across rebuilds (same passphrase re-opens the vault)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* withLocker(paths, (locker) =>
        locker.store("api/github-token", Redacted.make("persisted-value"), WORK)
      )
      const retrieved = yield* withLocker(paths, (locker) =>
        locker.retrieve("api/github-token", WORK)
      )
      expect(retrieved.reveal()).toBe("persisted-value")
    })
  )

  it.effect("wrong passphrase fails typed — never silently", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* withLocker(paths, (locker) =>
        locker.store("api/github-token", Redacted.make("real-secret"), WORK)
      )
      const failure = yield* Effect.flip(
        Effect.provide(Effect.void, lockerFor(paths, "wrong-passphrase"))
      )
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("vault-unseal-failed")
    })
  )

  it.effect("remove deletes the secret", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const afterRemove = yield* withLocker(paths, (locker) =>
        Effect.gen(function* () {
          yield* locker.store("temp/key", Redacted.make("x"), WORK)
          yield* locker.remove("temp/key", WORK)
          return yield* Effect.flip(locker.retrieve("temp/key", WORK))
        })
      )
      expect(afterRemove).toBeInstanceOf(IdentityError)
      expect(afterRemove.reason).toBe("secret-not-found")
    })
  )

  it.effect("vault file has 0600 permissions", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* withLocker(paths, (locker) =>
        locker.store("api/github-token", Redacted.make("s"), WORK)
      )
      const stat = yield* Effect.promise(() => fs.stat(vaultFile(paths)))
      expect(stat.mode & 0o777).toBe(0o600)
    })
  )

  it.effect("vault ciphertext does not contain the plaintext", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const secret = "ultrasecret-plaintext-marker-987"
      yield* withLocker(paths, (locker) =>
        locker.store("api/token", Redacted.make(secret), WORK)
      )
      const raw = yield* Effect.promise(() => fs.readFile(vaultFile(paths), "utf-8"))
      expect(raw).not.toContain(secret)
    })
  )
})

describe("manifest", () => {
  it.effect("lists names and scopes only — never values", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const secretA = "manifest-secret-alpha-111"
      const secretB = "manifest-secret-beta-222"
      const manifest = yield* withLocker(paths, (locker) =>
        Effect.gen(function* () {
          yield* locker.store("api/github-token", Redacted.make(secretA), WORK)
          yield* locker.store("oauth/google", Redacted.make(secretB), PERSONAL)
          return yield* locker.manifest()
        })
      )
      expect(manifest).toHaveLength(2)
      expect(manifest).toContainEqual({ name: "api/github-token", scope: WORK })
      expect(manifest).toContainEqual({ name: "oauth/google", scope: PERSONAL })
      // entry shape is exactly { name, scope }
      for (const entry of manifest) {
        expect(Object.keys(entry).sort()).toEqual(["name", "scope"])
        expect(Object.keys(entry.scope)).toEqual(["profile"])
      }
      // stringify the whole manifest: no plaintext anywhere
      const blob = JSON.stringify(manifest)
      expect(blob).not.toContain(secretA)
      expect(blob).not.toContain(secretB)
    })
  )
})

describe("profile-scoped, fail-closed reads (Hermes #93522)", () => {
  it.effect("a secret stored under one profile is invisible to another", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const failure = yield* withLocker(paths, (locker) =>
        Effect.gen(function* () {
          yield* locker.store("api/token", Redacted.make("work-only"), WORK)
          return yield* Effect.flip(locker.retrieve("api/token", PERSONAL))
        })
      )
      expect(failure).toBeInstanceOf(IdentityError)
      // indistinguishable from "not found": no oracle about the other profile
      expect(failure.reason).toBe("secret-not-found")
    })
  )

  it.effect("missing secret fails typed", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const failure = yield* withLocker(paths, (locker) =>
        Effect.flip(locker.retrieve("no/such-secret", WORK))
      )
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("secret-not-found")
    })
  )
})

describe("Redacted end-to-end (Pi #10291)", () => {
  it.effect("Redacted never serializes its value", () =>
    Effect.gen(function* () {
      const secret = "leak-test-plaintext-456"
      expect(JSON.stringify(Redacted.make(secret))).toBe('"Redacted"')
      expect(String(Redacted.make(secret))).toBe("Redacted")
    })
  )

  it.effect("failure paths carry no secret material", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const secret = "failure-path-plaintext-789"
      const failure = yield* withLocker(paths, (locker) =>
        Effect.gen(function* () {
          yield* locker.store("api/token", Redacted.make(secret), WORK)
          // simulated failure: retrieve under the wrong scope
          return yield* Effect.flip(locker.retrieve("api/token", PERSONAL))
        })
      )
      expect(failure).toBeInstanceOf(IdentityError)
      const blob = JSON.stringify(failure) + String(failure)
      expect(blob).not.toContain(secret)
      // the reason is a machine-readable constant, not an echo of inputs
      expect(failure.reason).toBe("secret-not-found")
    })
  )
})

describe("keychain backend stub", () => {
  it.effect("reports unavailable; every op fails typed", () =>
    Effect.gen(function* () {
      expect(yield* KeychainUnavailable.available()).toBe(false)
      const get = yield* Effect.flip(KeychainUnavailable.getServiceSecret("k"))
      expect(get).toBeInstanceOf(IdentityError)
      expect(get.reason).toBe("keychain-unavailable")
      const set = yield* Effect.flip(KeychainUnavailable.setServiceSecret("k", Redacted.make("v")))
      expect(set.reason).toBe("keychain-unavailable")
      const del = yield* Effect.flip(KeychainUnavailable.deleteServiceSecret("k"))
      expect(del.reason).toBe("keychain-unavailable")
    })
  )
})
