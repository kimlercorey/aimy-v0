/**
 * pairing.test.ts — pairing grant store behavior.
 *
 * - Grants persist per peer (keyed by peer instanceId), round-trip through
 *   the Schema, and carry the required type shape.
 * - Refusals are typed: duplicate grant, unconfirmed revoke, unknown-peer
 *   revoke, mode grants owned by a third instance, corrupt store.
 */
import * as os from "node:os"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { IdentityError } from "../substrate/errors.js"
import { Redacted } from "../substrate/types.js"
import type { AimyPaths } from "../substrate/config.js"
import { IdentityService, IdentityStackLive, migrateIdentityDocument } from "./identity.js"
import { PAIRING_GRANTS_FILE_NAME, getPairingGrant, grantPairing, listPairingGrants, revokePairing } from "./pairing.js"
import type { ModeGrant } from "./mode-grants.js"

const PEER_A = "123e4567-e89b-42d3-a456-426614174000"
const PEER_B = "223e4567-e89b-42d3-a456-426614174001"
const PEER_C = "323e4567-e89b-42d3-a456-426614174002"

const makePaths = async (): Promise<{ root: string; paths: AimyPaths }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimy-pairing-test-"))
  return {
    root,
    paths: {
      data: path.join(root, "data"),
      config: path.join(root, "config"),
      state: path.join(root, "state")
    }
  }
}

const peerModeGrant = (peerId: string): ModeGrant => ({
  mode: "intimate-mode",
  instanceId: peerId as ModeGrant["instanceId"],
  grantedAt: new Date().toISOString(),
  grantedBy: "user"
})

describe("pairing grants store", () => {
  it.effect("grants and retrieves a pairing grant (required type shape)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const grant = yield* grantPairing(paths, {
        peerInstanceId: PEER_A,
        peerPublicKey: "dGVzdC1wdWJsaWMta2V5",
        peerDisplayName: "office",
        categories: { "user-profile": "bidirectional", "project-facts": "pull", "learned-skills": "off" },
        modeGrants: [peerModeGrant(PEER_A)]
      })

      // Required type shape: peer identity + pairing metadata + sync policies + mode grants
      expect(Object.keys(grant).sort()).toEqual([
        "categories",
        "modeGrants",
        "pairedAt",
        "pairingProtocolVersion",
        "peerDisplayName",
        "peerInstanceId",
        "peerPublicKey"
      ])
      expect(grant.peerInstanceId).toBe(PEER_A)
      expect(grant.peerDisplayName).toBe("office")
      expect(grant.pairingProtocolVersion).toBe(1)
      expect(Number.isNaN(Date.parse(grant.pairedAt))).toBe(false)
      expect(grant.categories["user-profile"]).toBe("bidirectional")
      expect(grant.modeGrants).toHaveLength(1)
      expect(grant.modeGrants[0]?.instanceId).toBe(PEER_A)

      // pairedAt is stamped by the operation, not the caller
      expect(yield* getPairingGrant(paths, PEER_A)).toEqual(grant)
      expect(yield* getPairingGrant(paths, PEER_B)).toBeNull()
      const all = yield* listPairingGrants(paths)
      expect(all).toHaveLength(1)

      // Grants file stays private
      const stat = yield* Effect.promise(() => fs.stat(path.join(paths.config, PAIRING_GRANTS_FILE_NAME)))
      expect(stat.mode & 0o777).toBe(0o600)
    })
  )

  it.effect("grants are keyed per peer (pairwise, non-transitive)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      for (const peer of [PEER_A, PEER_B]) {
        yield* grantPairing(paths, {
          peerInstanceId: peer,
          peerPublicKey: "dGVzdC1wdWJsaWMta2V5",
          categories: {},
          modeGrants: []
        })
      }
      const all = yield* listPairingGrants(paths)
      expect(all.map((g) => g.peerInstanceId).sort()).toEqual([PEER_A, PEER_B])
    })
  )

  it.effect("refuses a duplicate grant (typed — never silent overwrite)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const input = {
        peerInstanceId: PEER_A,
        peerPublicKey: "dGVzdC1wdWJsaWMta2V5",
        categories: {},
        modeGrants: []
      }
      yield* grantPairing(paths, input)
      const failure = yield* Effect.flip(grantPairing(paths, input))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("pairing-peer-already-granted")
    })
  )

  it.effect("refuses an unconfirmed revoke (typed — destructive-confirm)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* grantPairing(paths, {
        peerInstanceId: PEER_A,
        peerPublicKey: "dGVzdC1wdWJsaWMta2V5",
        categories: {},
        modeGrants: []
      })
      // The type forces `confirmed: true`; a runtime-level bypass still fails typed.
      const failure = yield* Effect.flip(
        revokePairing(paths, PEER_A, { confirmed: false } as unknown as { confirmed: true })
      )
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("pairing-revoke-unconfirmed")
      // The grant survives the refused revoke
      expect(yield* getPairingGrant(paths, PEER_A)).not.toBeNull()
    })
  )

  it.effect("refuses to revoke an unknown peer (typed — never silent)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const failure = yield* Effect.flip(revokePairing(paths, PEER_A, { confirmed: true }))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("pairing-unknown-peer")
    })
  )

  it.effect("revokes a confirmed grant and returns it", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const granted = yield* grantPairing(paths, {
        peerInstanceId: PEER_A,
        peerPublicKey: "dGVzdC1wdWJsaWMta2V5",
        peerDisplayName: "office",
        categories: { "user-profile": "push" },
        modeGrants: []
      })
      const revoked = yield* revokePairing(paths, PEER_A, { confirmed: true })
      expect(revoked).toEqual(granted)
      expect(yield* getPairingGrant(paths, PEER_A)).toBeNull()
      expect(yield* listPairingGrants(paths)).toHaveLength(0)
    })
  )

  it.effect("refuses mode grants owned by a third instance (typed)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      // PEER_C's mode grant smuggled into a pairing grant for PEER_A
      const failure = yield* Effect.flip(
        grantPairing(paths, {
          peerInstanceId: PEER_A,
          peerPublicKey: "dGVzdC1wdWJsaWMta2V5",
          categories: {},
          modeGrants: [peerModeGrant(PEER_C)]
        })
      )
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("pairing-mode-grant-instance-mismatch")
      // Nothing was persisted by the refused grant
      expect(yield* listPairingGrants(paths)).toHaveLength(0)
    })
  )

  it.effect("rejects an invalid sync policy (typed)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const failure = yield* Effect.flip(
        grantPairing(paths, {
          peerInstanceId: PEER_A,
          peerPublicKey: "dGVzdC1wdWJsaWMta2V5",
          categories: { "user-profile": "sideways" as unknown as "push" },
          modeGrants: []
        })
      )
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("pairing-grant-invalid")
    })
  )

  it.effect("fails typed on a corrupt grants store (never silent)", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      yield* Effect.promise(() => fs.mkdir(paths.config, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(paths.config, PAIRING_GRANTS_FILE_NAME), "{oops"))
      const failure = yield* Effect.flip(listPairingGrants(paths))
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("pairing-store-corrupt")
    })
  )
})

describe("identity document pairing fields", () => {
  it.effect("stamps pairingProtocolVersion 1 on fresh installs", () =>
    Effect.gen(function* () {
      const { paths } = yield* Effect.promise(makePaths)
      const stack = IdentityStackLive({ passphrase: Redacted.make("test-passphrase-pairing-doc"), paths })
      const doc = yield* Effect.gen(function* () {
        const svc = yield* IdentityService
        return svc.document
      }).pipe(Effect.provide(stack))
      expect(doc.pairingProtocolVersion).toBe(1)
      // The public key is the pairing authentication anchor: 32-byte Ed25519 key
      expect(doc.publicKey.length).toBeGreaterThan(0)
    })
  )

  it.effect("migration normalizes pre-M7 documents (missing pairingProtocolVersion) to 1", () =>
    Effect.gen(function* () {
      const doc = yield* migrateIdentityDocument({
        version: 1,
        instanceId: PEER_A,
        createdAt: new Date().toISOString(),
        publicKey: "dGVzdC1wdWJsaWMta2V5"
      })
      expect(doc.pairingProtocolVersion).toBe(1)
    })
  )

  it.effect("rejects a document claiming a foreign pairing protocol version (typed)", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        migrateIdentityDocument({
          version: 1,
          instanceId: PEER_A,
          createdAt: new Date().toISOString(),
          publicKey: "dGVzdC1wdWJsaWMta2V5",
          pairingProtocolVersion: 2
        })
      )
      expect(failure).toBeInstanceOf(IdentityError)
      expect(failure.reason).toBe("identity-document-invalid")
    })
  )
})
