/**
 * identity.test.ts — install identity behavior.
 *
 * - UUID generated once, stable across restarts (same config dir).
 * - Fresh dir → new UUID, valid v4.
 * - Identity document Schema-validates and is structurally secret-free.
 * - Ed25519 sign/verify round-trip against the document's public key.
 * - Keypair stable across rebuilds; seal verified on repeat launch.
 */
import * as os from "node:os"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { webcrypto } from "node:crypto"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { IdentityError } from "../substrate/errors.js"
import { Redacted } from "../substrate/types.js"
import type { AimyPaths } from "../substrate/config.js"
import {
  ensureInstanceId,
  IdentityDocumentSchema,
  IdentityService,
  IdentityStackLive,
  type IdentityServiceShape
} from "./identity.js"
import { decodeBase64Url } from "./bytes.js"

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const makePaths = async (): Promise<{ root: string; paths: AimyPaths }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimy-identity-test-"))
  return {
    root,
    paths: {
      data: path.join(root, "data"),
      config: path.join(root, "config"),
      state: path.join(root, "state")
    }
  }
}

const stackFor = (paths: AimyPaths, passphrase = "test-passphrase-identity") =>
  IdentityStackLive({ passphrase: Redacted.make(passphrase), paths })

const withService = <A, E>(
  paths: AimyPaths,
  use: (svc: IdentityServiceShape) => Effect.Effect<A, E>,
  passphrase?: string
) =>
  Effect.gen(function* () {
    const svc = yield* IdentityService
    return yield* use(svc)
  }).pipe(Effect.provide(stackFor(paths, passphrase)))

describe("install UUID", () => {
  it.effect("is generated once and stable across restarts", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const id1 = yield* withService(paths, (svc) => Effect.succeed(svc.instanceId))
      const id2 = yield* withService(paths, (svc) => Effect.succeed(svc.instanceId))
      expect(id1).toBe(id2)
      expect(UUID_V4_RE.test(id1)).toBe(true)
      // persisted on disk in the XDG config dir
      const stored = (yield* Effect.promise(() => fs.readFile(path.join(paths.config, "instance-id"), "utf-8"))).trim()
      expect(stored).toBe(id1)
    })
  )

  it.effect("is fresh and v4-formatted for a new config dir", () =>
    Effect.gen(function* () {
      const a = yield* Effect.promise(makePaths)
      const b = yield* Effect.promise(makePaths)
      const idA = yield* withService(a.paths, (svc) => Effect.succeed(svc.instanceId))
      const idB = yield* withService(b.paths, (svc) => Effect.succeed(svc.instanceId))
      expect(idA).not.toBe(idB)
      expect(UUID_V4_RE.test(idA)).toBe(true)
      expect(UUID_V4_RE.test(idB)).toBe(true)
    })
  )

  it.effect("fails typed on a corrupt instance-id file (never silently replaced)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* Effect.promise(() => fs.mkdir(paths.config, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(paths.config, "instance-id"), "not-a-uuid\n"))
      const failure = yield* Effect.flip(ensureInstanceId(paths))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("instance-id-corrupt")
    })
  )
})

describe("identity document", () => {
  it.effect("Schema-validates and contains zero secret-shaped fields", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const doc = yield* withService(paths, (svc) => Effect.succeed(svc.document))
      // JSON round-trip through the Schema: decodes clean
      const roundTripped = yield* Schema.decodeUnknownEffect(IdentityDocumentSchema)(
        JSON.parse(JSON.stringify(doc))
      )
      expect(roundTripped).toEqual(doc)
      // Structural: exactly the known, secret-free field set
      expect(Object.keys(doc).sort()).toEqual(["createdAt", "instanceId", "publicKey", "version"])
      // No secret-typed or private-key-shaped content anywhere in the doc
      const blob = JSON.stringify(doc).toLowerCase()
      for (const word of ["private", "secret", "passphrase", "seed", "mnemonic", "jwk", "redacted"]) {
        expect(blob).not.toContain(word)
      }
      for (const value of Object.values(doc)) {
        expect(value).not.toBeInstanceOf(Redacted)
      }
      // version + UUID shape enforced
      expect(doc.version).toBe(1)
      expect(UUID_V4_RE.test(doc.instanceId)).toBe(true)
      expect(Number.isNaN(Date.parse(doc.createdAt))).toBe(false)
      // 32-byte Ed25519 public key, base64url
      expect(decodeBase64Url(doc.publicKey)).toHaveLength(32)
    })
  )

  it.effect("persists the same document across restarts (keypair not regenerated)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const first = yield* withService(paths, (svc) => Effect.succeed(svc.document))
      const second = yield* withService(paths, (svc) => Effect.succeed(svc.document))
      expect(second.publicKey).toBe(first.publicKey)
      expect(second).toEqual(first)
    })
  )

  it.effect("rejects an unknown document version (migration stub fails closed)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* Effect.promise(() => fs.mkdir(paths.config, { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(paths.config, "instance-id"),
          "123e4567-e89b-42d3-a456-426614174000\n"
        )
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(paths.config, "identity.json"),
          JSON.stringify({ version: 99, instanceId: "123e4567-e89b-42d3-a456-426614174000" })
        )
      )
      const failure = yield* Effect.flip(Effect.provide(Effect.void, stackFor(paths)))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("identity-document-unsupported-version")
    })
  )
})

describe("Ed25519 signing", () => {
  it.effect("sign/verify round-trips against the document public key", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const result = yield* withService(paths, (svc) =>
        Effect.gen(function* () {
          const message = new TextEncoder().encode("pairing-handshake-probe")
          const signature = yield* svc.sign(message)
          const publicKey = yield* Effect.promise(() =>
            webcrypto.subtle.importKey(
              "raw",
              decodeBase64Url(svc.document.publicKey),
              { name: "Ed25519" },
              false,
              ["verify"]
            )
          )
          const valid = yield* Effect.promise(() =>
            webcrypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message)
          )
          const tampered = yield* Effect.promise(() =>
            webcrypto.subtle.verify(
              { name: "Ed25519" },
              publicKey,
              signature,
              new TextEncoder().encode("tampered")
            )
          )
          return { valid, tampered, signature }
        })
      )
      expect(result.valid).toBe(true)
      expect(result.tampered).toBe(false)
      expect(result.signature).toHaveLength(64)
    })
  )
})
