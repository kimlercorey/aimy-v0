/**
 * locker.ts — SecretLocker: the trust anchor for API credentials, OAuth
 * tokens, and per-instance secrets (architecture §1.5, MUST #6).
 *
 * Design:
 * - `KeychainBackend` is the root-of-trust interface. The OS keychain
 *   backend exists as an interface + an unavailable stub in this phase;
 *   real platform bindings (macOS Keychain, Windows Credential Manager,
 *   Linux Secret Service) are a later milestone.
 * - **File-backed fallback (this phase's working backend):** a
 *   passphrase-sealed vault. A KEK is derived from the user's passphrase
 *   (PBKDF2-SHA256, 600k iterations, random 16-byte salt) and seals the
 *   whole vault with AES-256-GCM (fresh 12-byte IV per write). Vault file
 *   lives in the XDG data dir under the install UUID
 *   (`<data>/<instanceId>/locker/vault.json`) with 0600 permissions. This is
 *   the recorded decision for headless-Linux keychain fallback (open risk
 *   OR-1): fail-closed + explicitly user-chosen, never silent plaintext
 *   (Pi #10291).
 * - Secrets are `Redacted` end-to-end: never in logs, traces, error
 *   reasons, or JSON output. The only `reveal()` call sites are inside the
 *   AES-GCM seal/open operations.
 * - Profile-scoped, fail-closed reads (Hermes #93522): every secret is
 *   keyed by `(profile, name)`. A read under the wrong profile is
 *   indistinguishable from "not found" — no oracle, no inheritance.
 * - `manifest()` returns names + scopes + created-at ONLY, never values (one-click
 *   export, MUST #16, needs exactly this).
 */

import { webcrypto } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Effect, Layer } from "effect"

import { IdentityError } from "../substrate/errors.js"
import { resolvePaths, type AimyPaths } from "../substrate/config.js"
import { InstanceId, Redacted } from "../substrate/types.js"
import { decodeBase64, encodeBase64, strictBytes } from "./bytes.js"

/** Requesting profile/instance context for a secret (Hermes #93522). */
export interface SecretScope {
  readonly profile: string
}

/** Scope under which AImy's own instance secrets (signing key, …) live. */
export const InstanceSecretScope: SecretScope = { profile: "instance" }

/**
 * OS keychain backend: the root of trust where available. Real platform
 * bindings are a later milestone; `KeychainUnavailable` below is the stub.
 */
export interface KeychainBackend {
  readonly available: () => Effect.Effect<boolean, IdentityError>
  readonly getServiceSecret: (key: string) => Effect.Effect<Redacted<string> | undefined, IdentityError>
  readonly setServiceSecret: (key: string, secret: Redacted<string>) => Effect.Effect<void, IdentityError>
  readonly deleteServiceSecret: (key: string) => Effect.Effect<void, IdentityError>
}

/** Stub: reports the OS keychain unavailable; every op fails typed. */
export const KeychainUnavailable: KeychainBackend = {
  available: () => Effect.succeed(false),
  getServiceSecret: () => Effect.fail(new IdentityError({ reason: "keychain-unavailable" })),
  setServiceSecret: () => Effect.fail(new IdentityError({ reason: "keychain-unavailable" })),
  deleteServiceSecret: () => Effect.fail(new IdentityError({ reason: "keychain-unavailable" }))
}

/** Manifest entry: name + scope + created-at ONLY. Values never leave the vault. */
export interface SecretManifestEntry {
  readonly name: string
  readonly scope: SecretScope
  /** Unix-ms when the entry was first stored (preserved across re-stores). */
  readonly createdAt: number
}

export interface SecretLockerShape {
  readonly store: (
    name: string,
    secret: Redacted<string>,
    scope: SecretScope
  ) => Effect.Effect<void, IdentityError>
  readonly retrieve: (name: string, scope: SecretScope) => Effect.Effect<Redacted<string>, IdentityError>
  readonly remove: (name: string, scope: SecretScope) => Effect.Effect<void, IdentityError>
  /** Names + scopes only — the shape one-click export consumes. */
  readonly manifest: () => Effect.Effect<ReadonlyArray<SecretManifestEntry>, IdentityError>
}

export class SecretLocker extends Context.Service<SecretLocker, SecretLockerShape>()("aimy/SecretLocker") {}

// ---------------------------------------------------------------------------
// Passphrase-sealed file vault
// ---------------------------------------------------------------------------

const VAULT_FILE_NAME = "vault.json"
const VAULT_VERSION = 1 as const
const PBKDF2_ITERATIONS = 600_000
const SALT_BYTES = 16
const IV_BYTES = 12

interface VaultEnvelope {
  readonly version: 1
  readonly kdf: "pbkdf2-sha256"
  readonly iterations: number
  readonly salt: string // base64
  readonly iv: string // base64
  readonly ciphertext: string // base64: AES-256-GCM of {"entries":[...]}
}

interface VaultEntry {
  readonly name: string
  readonly profile: string
  readonly secret: string // plaintext only inside the sealed envelope
  readonly createdAt: number // unix-ms of first store; preserved across re-stores
}

const scopeKey = (name: string, scope: SecretScope): string => `${scope.profile}\u0000${name}`

const checkName = (name: string): Effect.Effect<void, IdentityError> =>
  name.length > 0 && name.length <= 256 && !name.includes("\u0000")
    ? Effect.void
    : Effect.fail(new IdentityError({ reason: "invalid-secret-name" }))

const checkScope = (scope: SecretScope): Effect.Effect<void, IdentityError> =>
  typeof scope.profile === "string" && scope.profile.length > 0 && scope.profile.length <= 128
    ? Effect.void
    : Effect.fail(new IdentityError({ reason: "invalid-secret-scope" }))

/** Single auditable `reveal()` site for key derivation. */
const deriveKek = (passphrase: Redacted<string>, salt: Uint8Array, iterations: number) =>
  Effect.tryPromise({
    try: async () => {
      const base = await webcrypto.subtle.importKey(
        "raw",
        strictBytes(new TextEncoder().encode(passphrase.reveal())),
        "PBKDF2",
        false,
        ["deriveKey"]
      )
      return webcrypto.subtle.deriveKey(
        { name: "PBKDF2", salt: strictBytes(salt), iterations, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      )
    },
    catch: () => new IdentityError({ reason: "vault-key-derivation-failed" })
  })

const sealEntries = (kek: webcrypto.CryptoKey, salt: Uint8Array, entries: ReadonlyArray<VaultEntry>) =>
  Effect.tryPromise({
    try: async () => {
      const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES))
      const plaintext = strictBytes(new TextEncoder().encode(JSON.stringify({ entries })))
      const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, plaintext))
      const envelope: VaultEnvelope = {
        version: VAULT_VERSION,
        kdf: "pbkdf2-sha256",
        iterations: PBKDF2_ITERATIONS,
        salt: encodeBase64(salt),
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(ciphertext)
      }
      return envelope
    },
    catch: () => new IdentityError({ reason: "vault-seal-failed" })
  })

const openEnvelope = (
  kek: webcrypto.CryptoKey,
  envelope: VaultEnvelope
): Effect.Effect<ReadonlyArray<VaultEntry>, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      if (envelope.version !== VAULT_VERSION || envelope.kdf !== "pbkdf2-sha256") {
        throw new Error("envelope")
      }
      const plaintext = await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: decodeBase64(envelope.iv) },
        kek,
        decodeBase64(envelope.ciphertext)
      )
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { entries?: unknown }
      if (!Array.isArray(parsed.entries)) throw new Error("entries")
      return parsed.entries as ReadonlyArray<VaultEntry>
    },
    // Wrong passphrase fails GCM auth here; corrupt envelopes fail here too.
    // Both are the same typed error: fail closed, no oracle.
    catch: () => new IdentityError({ reason: "vault-unseal-failed" })
  })

const writeFilePrivate = (file: string, data: string): Effect.Effect<void, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.writeFile(file, data, { mode: 0o600 })
      await fs.chmod(file, 0o600)
    },
    catch: () => new IdentityError({ reason: "vault-unwritable" })
  })

const readFileIfExists = (file: string): Effect.Effect<string | null, IdentityError> =>
  Effect.tryPromise({
    try: () =>
      fs.readFile(file, "utf-8").catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null
        throw cause
      }),
    catch: () => new IdentityError({ reason: "vault-unreadable" })
  })

export interface LockerOptions {
  /** Passphrase sealing the vault (Redacted end-to-end). */
  readonly passphrase: Redacted<string>
  /** Vault file is namespaced under the install UUID: `<data>/<instanceId>/locker/`. */
  readonly instanceId: InstanceId
  readonly paths?: AimyPaths
}

/**
 * File-backed `SecretLocker` layer. Unlocks (or creates) the vault at build:
 * a wrong passphrase fails the layer with a typed `IdentityError`
 * (`vault-unseal-failed`) — never silently, never with a partial state.
 */
export const FileLockerLive = (options: LockerOptions): Layer.Layer<SecretLocker, IdentityError> =>
  Layer.effect(SecretLocker)(
    Effect.gen(function* () {
      const paths = options.paths ?? resolvePaths()
      const file = path.join(paths.data, options.instanceId, "locker", VAULT_FILE_NAME)

      const raw = yield* readFileIfExists(file)
      let salt: Uint8Array
      const entries = new Map<string, VaultEntry>()
      if (raw !== null) {
        const envelope = yield* Effect.try({
          try: () => JSON.parse(raw) as VaultEnvelope,
          catch: () => new IdentityError({ reason: "vault-envelope-invalid" })
        })
        salt = decodeBase64(envelope.salt)
        const kek = yield* deriveKek(options.passphrase, salt, envelope.iterations)
        const stored = yield* openEnvelope(kek, envelope)
        for (const entry of stored) entries.set(scopeKey(entry.name, { profile: entry.profile }), entry)
      } else {
        salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES))
      }

      const persist: Effect.Effect<void, IdentityError> = Effect.gen(function* () {
        const kek = yield* deriveKek(options.passphrase, salt, PBKDF2_ITERATIONS)
        const envelope = yield* sealEntries(kek, salt, [...entries.values()])
        yield* writeFilePrivate(file, JSON.stringify(envelope))
      })

      const locker: SecretLockerShape = {
        store: (name, secret, scope) =>
          Effect.gen(function* () {
            yield* checkName(name)
            yield* checkScope(scope)
            const key = scopeKey(name, scope)
            const prior = entries.get(key)
            // createdAt is set once: a re-store (rotation) keeps the original
            // timestamp. Entries sealed before this field existed default to 0.
            const createdAt = prior?.createdAt ?? Date.now()
            // Single auditable reveal: plaintext exists only inside the sealed envelope.
            entries.set(key, { name, profile: scope.profile, secret: secret.reveal(), createdAt })
            yield* persist
          }),
        retrieve: (name, scope) =>
          Effect.gen(function* () {
            yield* checkName(name)
            yield* checkScope(scope)
            const entry = entries.get(scopeKey(name, scope))
            if (entry === undefined) {
              // Wrong profile and missing name are indistinguishable: fail closed, no oracle.
              return yield* Effect.fail(new IdentityError({ reason: "secret-not-found" }))
            }
            return Redacted.make(entry.secret)
          }),
        remove: (name, scope) =>
          Effect.gen(function* () {
            yield* checkName(name)
            yield* checkScope(scope)
            entries.delete(scopeKey(name, scope))
            yield* persist
          }),
        manifest: () =>
          Effect.succeed(
            [...entries.values()].map((entry): SecretManifestEntry => ({
              name: entry.name,
              scope: { profile: entry.profile },
              // `?? 0`: entries sealed by older builds carry no timestamp.
              createdAt: entry.createdAt ?? 0
            }))
          )
      }
      return locker
    })
  )
