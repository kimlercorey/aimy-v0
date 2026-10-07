/**
 * identity/identity.ts — install identity: UUID, versioned identity document,
 * Ed25519 instance keypair, signing operations.
 *
 * Architecture §1.1 (MUST #4):
 * - Install UUID (v4, `crypto.randomUUID()`, offline) generated ONCE at first
 *   install, stored in the XDG config dir. It namespaces ALL per-instance
 *   state (memory, locker, skills, jobs).
 * - Versioned identity document `{ version, instanceId, createdAt, publicKey,
 *   displayName? }` — portable, Schema-validated, contains NO secrets.
 *   Structurally incapable of holding secrets: the type has no secret-typed
 *   fields (there is a structural test for this).
 * - Ed25519 keypair (node:crypto webcrypto) generated at install. The private
 *   half goes ONLY to the SecretLocker; the public half is published in the
 *   identity document (and only during LAN pairing handshakes, §1.3).
 *
 * Fail-closed: on a repeat launch the stored private key is re-imported from
 * the locker and the pair is self-checked (sign probe + verify against the
 * document's public key). A broken seal, a missing key, or an
 * instance-id/document mismatch is a typed `IdentityError` — never silent.
 */

import { webcrypto } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"

import { IdentityError } from "../substrate/errors.js"
import { resolvePaths, type AimyPaths } from "../substrate/config.js"
import { InstanceId, Redacted } from "../substrate/types.js"
import { FileLockerLive, InstanceSecretScope, SecretLocker, type LockerOptions } from "./locker.js"
import { decodeBase64Url, encodeBase64Url, strictBytes } from "./bytes.js"

/** File names inside the XDG config dir. */
export const INSTANCE_ID_FILE_NAME = "instance-id"
export const IDENTITY_FILE_NAME = "identity.json"
/** Locker entry holding the instance signing private key (JWK, Redacted). */
export const INSTANCE_KEY_NAME = "identity/instance-signing-key"

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** UUIDv4-validated string, enforced inside the identity document Schema. */
export const UuidV4Schema = Schema.String.pipe(
  Schema.refine((s): s is `${string}-${string}-${string}-${string}-${string}` => UUID_V4_RE.test(s))
)

/**
 * Versioned identity document. Portable (one-click export, pairing).
 * NEVER contains secrets — the type has no secret-typed fields, by
 * construction. `version` selects the migration path in
 * {@link migrateIdentityDocument}.
 */
export const IdentityDocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  instanceId: UuidV4Schema,
  createdAt: Schema.String, // ISO-8601 UTC, validated at construction
  publicKey: Schema.String, // base64url-encoded 32-byte Ed25519 public key
  displayName: Schema.optional(Schema.String)
})

export interface IdentityDocument extends Schema.Schema.Type<typeof IdentityDocumentSchema> {}

/**
 * Migration stub for future document versions. v1 decodes directly;
 * unknown versions fail typed (fail closed — never guess at the format).
 */
export const migrateIdentityDocument = (raw: unknown): Effect.Effect<IdentityDocument, IdentityError> => {
  const version =
    typeof raw === "object" && raw !== null && "version" in raw
      ? (raw as { readonly version?: unknown }).version
      : undefined
  switch (version) {
    case 1:
      return Schema.decodeUnknownEffect(IdentityDocumentSchema)(raw).pipe(
        Effect.mapError(() => new IdentityError({ reason: "identity-document-invalid" }))
      )
    case undefined:
      return Effect.fail(new IdentityError({ reason: "identity-document-missing-version" }))
    default:
      return Effect.fail(new IdentityError({ reason: "identity-document-unsupported-version" }))
  }
}

/** Encode/decode base64url — re-exported from ./bytes.js for convenience. */
export { decodeBase64Url, encodeBase64Url, strictBytes } from "./bytes.js"

const readIfExists = (file: string): Effect.Effect<string | null, IdentityError> =>
  Effect.tryPromise({
    try: () =>
      fs.readFile(file, "utf-8").catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null
        throw cause
      }),
    catch: () => new IdentityError({ reason: "identity-store-unreadable" })
  })

const writeFilePrivate = (file: string, data: string): Effect.Effect<void, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.writeFile(file, data, { mode: 0o600 })
      await fs.chmod(file, 0o600) // belt-and-braces: umask must not widen this
    },
    catch: () => new IdentityError({ reason: "identity-store-unwritable" })
  })

/**
 * Resolve the install UUID: read it from the XDG config dir, or generate it
 * ONCE with `crypto.randomUUID()` and persist it (0600). Offline-safe.
 * A corrupt id file fails typed rather than being silently replaced.
 */
export const ensureInstanceId = (paths: AimyPaths): Effect.Effect<InstanceId, IdentityError> =>
  Effect.gen(function* () {
    const file = path.join(paths.config, INSTANCE_ID_FILE_NAME)
    const existing = yield* readIfExists(file)
    if (existing !== null) {
      const id = existing.trim()
      if (!UUID_V4_RE.test(id)) {
        return yield* Effect.fail(new IdentityError({ reason: "instance-id-corrupt" }))
      }
      return InstanceId(id)
    }
    const id = webcrypto.randomUUID()
    yield* writeFilePrivate(file, id + "\n")
    return InstanceId(id)
  })

type GeneratedKeypair = {
  readonly privateKey: webcrypto.CryptoKey
  readonly privateJwk: webcrypto.JsonWebKey
  readonly publicKeyB64u: string
}

const asKeyPair = (key: webcrypto.CryptoKey | webcrypto.CryptoKeyPair): webcrypto.CryptoKeyPair => {
  const candidate = key as webcrypto.CryptoKeyPair
  if (candidate.privateKey === undefined || candidate.publicKey === undefined) {
    throw new Error("expected asymmetric keypair")
  }
  return candidate
}

const generateSigningKeypair = (): Effect.Effect<GeneratedKeypair, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      const keypair = asKeyPair(await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))
      const privateJwk: webcrypto.JsonWebKey = await webcrypto.subtle.exportKey("jwk", keypair.privateKey)
      const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", keypair.publicKey))
      return { privateKey: keypair.privateKey, privateJwk, publicKeyB64u: encodeBase64Url(publicRaw) }
    },
    catch: () => new IdentityError({ reason: "keypair-generation-failed" })
  })

const importPrivateKey = (jwk: webcrypto.JsonWebKey): Effect.Effect<webcrypto.CryptoKey, IdentityError> =>
  Effect.tryPromise({
    try: () => webcrypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]),
    catch: () => new IdentityError({ reason: "keypair-unseal-failed" })
  })

/**
 * Fail-closed self-check: the private key re-imported from the locker must
 * verify against the public key in the identity document. Proves the stored
 * pair matches without ever serializing key material.
 */
const keypairMatchesDocument = (
  privateKey: webcrypto.CryptoKey,
  publicKeyB64u: string
): Effect.Effect<boolean, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      const publicKey = await webcrypto.subtle.importKey(
        "raw",
        strictBytes(decodeBase64Url(publicKeyB64u)),
        { name: "Ed25519" },
        false,
        ["verify"]
      )
      const probe = webcrypto.getRandomValues(new Uint8Array(32))
      const signature = await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, strictBytes(probe))
      return webcrypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, strictBytes(probe))
    },
    catch: () => new IdentityError({ reason: "keypair-verification-failed" })
  })

const makeSign =
  (privateKey: webcrypto.CryptoKey) =>
  (message: Uint8Array): Effect.Effect<Uint8Array, IdentityError> =>
    Effect.tryPromise({
      try: async () =>
        new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, strictBytes(message))),
      catch: () => new IdentityError({ reason: "sign-failed" })
    })

/**
 * The ambient-identity service (architecture §1.1): identity lives in the
 * dependency graph, never in process-global state (cf. Hermes #93522).
 * Downstream services (memory, locker, sync) take this as a dependency.
 */
export interface IdentityServiceShape {
  /** The install UUID — namespace key for all per-instance state. */
  readonly instanceId: InstanceId
  /** The versioned, portable, secret-free identity document. */
  readonly document: IdentityDocument
  /** Sign bytes with the instance private key (pairing handshakes, §1.3). */
  readonly sign: (message: Uint8Array) => Effect.Effect<Uint8Array, IdentityError>
}

export class IdentityService extends Context.Service<IdentityService, IdentityServiceShape>()(
  "aimy/IdentityService"
) {}

export interface IdentityBuildOptions {
  readonly instanceId: InstanceId
  readonly paths: AimyPaths
  readonly displayName?: string
}

const buildIdentity = (
  options: IdentityBuildOptions
): Effect.Effect<IdentityServiceShape, IdentityError, SecretLocker> =>
  Effect.gen(function* () {
    const locker = yield* SecretLocker
    const docFile = path.join(options.paths.config, IDENTITY_FILE_NAME)
    const existing = yield* readIfExists(docFile)

    if (existing === null) {
      // First install: generate keypair + document, seal the private key.
      const { privateKey, privateJwk, publicKeyB64u } = yield* generateSigningKeypair()
      const candidate = {
        version: 1 as const,
        instanceId: options.instanceId,
        createdAt: new Date().toISOString(),
        publicKey: publicKeyB64u,
        ...(options.displayName !== undefined ? { displayName: options.displayName } : {})
      }
      const document = yield* migrateIdentityDocument(candidate)
      if (Number.isNaN(Date.parse(document.createdAt))) {
        return yield* Effect.fail(new IdentityError({ reason: "identity-document-invalid" }))
      }
      // Private key goes ONLY to the locker — never the identity document.
      yield* locker.store(INSTANCE_KEY_NAME, Redacted.make(JSON.stringify(privateJwk)), InstanceSecretScope)
      yield* writeFilePrivate(docFile, JSON.stringify(document, null, 2) + "\n")
      return { instanceId: options.instanceId, document, sign: makeSign(privateKey) }
    }

    // Repeat launch: validate, re-import the sealed key, self-check the pair.
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(existing) as unknown,
      catch: () => new IdentityError({ reason: "identity-document-unreadable" })
    })
    const document = yield* migrateIdentityDocument(parsed)
    if (document.instanceId !== options.instanceId) {
      return yield* Effect.fail(new IdentityError({ reason: "identity-id-mismatch" }))
    }
    const sealed = yield* locker.retrieve(INSTANCE_KEY_NAME, InstanceSecretScope)
    const privateJwk = (yield* Effect.try({
      try: () => JSON.parse(sealed.reveal()) as webcrypto.JsonWebKey,
      catch: () => new IdentityError({ reason: "keypair-unseal-failed" })
    }))
    const privateKey = yield* importPrivateKey(privateJwk)
    const matches = yield* keypairMatchesDocument(privateKey, document.publicKey)
    if (!matches) {
      return yield* Effect.fail(new IdentityError({ reason: "identity-seal-broken" }))
    }
    return { instanceId: options.instanceId, document, sign: makeSign(privateKey) }
  })

/**
 * Layer providing `IdentityService`. Requires `SecretLocker` (the only
 * component that may hold the sealed private key).
 */
export const IdentityServiceLive = (
  options: IdentityBuildOptions
): Layer.Layer<IdentityService, IdentityError, SecretLocker> =>
  Layer.effect(IdentityService)(buildIdentity(options))

export interface IdentityStackOptions {
  /** Passphrase sealing the file-vault fallback (Redacted end-to-end). */
  readonly passphrase: Redacted<string>
  readonly paths?: AimyPaths
  readonly instanceId?: InstanceId
  readonly displayName?: string
}

/**
 * Convenience layer: file-backed `SecretLocker` + `IdentityService`,
 * composed with a single `ensureInstanceId` resolution. The identity stack
 * for a process — build once, provide everywhere.
 */
export const IdentityStackLive = (options: IdentityStackOptions): Layer.Layer<IdentityService, IdentityError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const paths = options.paths ?? resolvePaths()
      const instanceId = options.instanceId ?? (yield* ensureInstanceId(paths))
      const lockerOptions: LockerOptions = { passphrase: options.passphrase, instanceId, paths }
      return Layer.provide(
        IdentityServiceLive({
          instanceId,
          paths,
          ...(options.displayName !== undefined ? { displayName: options.displayName } : {})
        }),
        FileLockerLive(lockerOptions)
      )
    })
  )
