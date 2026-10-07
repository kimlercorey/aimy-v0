/**
 * identity/pairing.ts — first-party pairing grant types + grant store
 * (architecture Part 02 §1.3, §1.4).
 *
 * SCOPE (M7 Track 1): identity completion is pairing-READY, not pairing-
 * implemented. This file defines:
 *
 * - `PairingGrant` — the per-pair trust record: which peer, which sync
 *   scopes were granted, when. Pairwise, non-transitive, revocable (§1.3).
 * - The pairing grants store: persisted in the XDG config dir
 *   (`pairing-grants.json`, 0600), keyed by peer instanceId, with
 *   grant/revoke operations. Revoke is destructive-confirm typed: an
 *   unconfirmed revoke fails typed, and revoking an unknown peer fails
 *   typed — revocation never silently succeeds or silently no-ops.
 * - Design-only handshake message shapes (no implementation): identity
 *   document exchange → QR/numeric mutual-consent code → challenge signed
 *   by the instance private key → verified against the document's
 *   `publicKey`. See the README's "Future pairing handshake (design)"
 *   section for the full walkthrough. No mDNS, no QR generation, no sync.
 *
 * `publicKey` in the identity document is the pairing authentication
 * anchor: it is what makes pairing real rather than "we're on the same
 * Wi-Fi, trust me" (§1.1). `pairingProtocolVersion` gates compatibility —
 * two instances pair only when they agree on it.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Schema } from "effect"

import { IdentityError } from "../substrate/errors.js"
import type { AimyPaths } from "../substrate/config.js"
import { UuidV4Schema } from "./identity.js"
import { ModeGrantSchema, type ModeGrant } from "./mode-grants.js"

/** File name inside the XDG config dir. */
export const PAIRING_GRANTS_FILE_NAME = "pairing-grants.json"

/** Per-category sync policy (§1.4): which direction may items in a memory/locker category flow? */
export const SyncPolicySchema = Schema.Literals(["off", "push", "pull", "bidirectional"])
export type SyncPolicy = Schema.Schema.Type<typeof SyncPolicySchema>

/**
 * The per-pair trust record (§1.3): which peer, which sync scopes were
 * granted, when. Recorded in each instance's config at pairing time;
 * revokable at any time. Pairwise and non-transitive — pairing with A does
 * not grant A access to your other peers.
 *
 * `modeGrants` is a READ-ONLY snapshot of the modes the PEER declared at
 * pairing time (for display and for modules' `pairingPeers` context). It is
 * informational only and NEVER transferable:
 * - every entry's `instanceId` MUST equal `peerInstanceId` (enforced by
 *   `grantPairing`; anything else fails typed), and
 * - these entries are never written to the local mode-grant store and never
 *   carried by sync. Mode grants are set by the user on the owning instance
 *   only (`mode-grants.ts`).
 */
export const PairingGrantSchema = Schema.Struct({
  peerInstanceId: UuidV4Schema,
  peerPublicKey: Schema.String, // base64url-encoded 32-byte Ed25519 public key
  peerDisplayName: Schema.optionalKey(Schema.String),
  pairedAt: Schema.String, // ISO-8601 UTC
  pairingProtocolVersion: Schema.Literal(1),
  categories: Schema.Record(Schema.String, SyncPolicySchema), // per-category sync policies
  modeGrants: Schema.Array(ModeGrantSchema) // peer's declared modes — read-only snapshot, non-transferable
})

export interface PairingGrant extends Schema.Schema.Type<typeof PairingGrantSchema> {}

/** Input to `grantPairing` — `pairedAt` is stamped by the operation, not the caller. */
export interface PairingGrantInput {
  readonly peerInstanceId: string
  readonly peerPublicKey: string
  readonly peerDisplayName?: string
  readonly categories: Readonly<Record<string, SyncPolicy>>
  readonly modeGrants: ReadonlyArray<ModeGrant>
}

/**
 * DESIGN ONLY — no implementation in M7. Shape of the future pairing
 * handshake's challenge step: the initiator sends a fresh nonce; the
 * responder signs the canonical challenge bytes with its instance private
 * key (`IdentityService.sign`); the initiator verifies the signature against
 * the `publicKey` in the responder's exchanged identity document.
 */
export interface PairingHandshakeChallenge {
  readonly kind: "pairing-handshake-challenge"
  readonly peerInstanceId: string
  readonly nonce: string // base64url, 32 fresh random bytes
  readonly createdAt: string // ISO-8601 UTC
}

/**
 * DESIGN ONLY — no implementation in M7. The responder's answer to
 * {@link PairingHandshakeChallenge}: the challenge echoed back with a
 * base64url Ed25519 signature over the canonical challenge bytes.
 */
export interface PairingHandshakeResponse {
  readonly kind: "pairing-handshake-response"
  readonly challenge: PairingHandshakeChallenge
  readonly signature: string // base64url Ed25519 signature over the canonical challenge bytes
}

/**
 * DESIGN ONLY — no implementation in M7. The out-of-band mutual-consent
 * step: a short numeric code (or QR payload) displayed on the target
 * instance and confirmed on the initiator, defeating LAN spoofing (§1.3).
 */
export interface PairingConsentCode {
  readonly kind: "pairing-consent-code"
  readonly code: string // short numeric code, shown on target, confirmed on initiator
  readonly expiresAt: string // ISO-8601 UTC — codes are single-use and short-lived
}

/**
 * Destructive-confirm for pairing revocation: callers must pass an explicit
 * `{ confirmed: true }`. An unconfirmed revoke fails typed
 * (`pairing-revoke-unconfirmed`) — there is no silent or default-confirmed path.
 */
export interface RevokePairingConfirmation {
  readonly confirmed: true
}

const storeFile = (paths: AimyPaths): string => path.join(paths.config, PAIRING_GRANTS_FILE_NAME)

/** The on-disk store: a map of peer instanceId → grant. */
const PairingGrantStoreSchema = Schema.Record(Schema.String, PairingGrantSchema)

const readIfExists = (file: string): Effect.Effect<string | null, IdentityError> =>
  Effect.tryPromise({
    try: () =>
      fs.readFile(file, "utf-8").catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null
        throw cause
      }),
    catch: () => new IdentityError({ reason: "pairing-store-unreadable" })
  })

const writeFilePrivate = (file: string, data: string): Effect.Effect<void, IdentityError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.writeFile(file, data, { mode: 0o600 })
      await fs.chmod(file, 0o600) // belt-and-braces: umask must not widen this
    },
    catch: () => new IdentityError({ reason: "pairing-store-unwritable" })
  })

const readStore = (
  paths: AimyPaths
): Effect.Effect<{ readonly [peerId: string]: PairingGrant }, IdentityError> =>
  Effect.gen(function* () {
    const existing = yield* readIfExists(storeFile(paths))
    if (existing === null) return {}
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(existing) as unknown,
      catch: () => new IdentityError({ reason: "pairing-store-corrupt" })
    })
    return yield* Schema.decodeUnknownEffect(PairingGrantStoreSchema)(parsed).pipe(
      Effect.mapError(() => new IdentityError({ reason: "pairing-store-corrupt" }))
    )
  })

/** All pairing grants on this instance (empty when nothing is paired). */
export const listPairingGrants = (
  paths: AimyPaths
): Effect.Effect<ReadonlyArray<PairingGrant>, IdentityError> =>
  Effect.map(readStore(paths), (store) => Object.values(store))

/** The grant for one peer, or `null` when that peer is not paired. */
export const getPairingGrant = (
  paths: AimyPaths,
  peerInstanceId: string
): Effect.Effect<PairingGrant | null, IdentityError> =>
  Effect.map(readStore(paths), (store) => store[peerInstanceId] ?? null)

/**
 * Record a pairing grant for a peer (§1.3 step 3). Fails typed when:
 * - the peer is already paired (`pairing-peer-already-granted`) — re-pairing
 *   goes through revoke-then-grant, never silent overwrite;
 * - any `modeGrants` entry belongs to a different instance
 *   (`pairing-mode-grant-instance-mismatch`) — a peer cannot smuggle in
 *   mode grants owned by someone else;
 * - the grant does not Schema-validate (`pairing-grant-invalid`).
 */
export const grantPairing = (
  paths: AimyPaths,
  input: PairingGrantInput
): Effect.Effect<PairingGrant, IdentityError> =>
  Effect.gen(function* () {
    const store = yield* readStore(paths)
    if (store[input.peerInstanceId] !== undefined) {
      return yield* Effect.fail(new IdentityError({ reason: "pairing-peer-already-granted" }))
    }
    for (const modeGrant of input.modeGrants) {
      if (modeGrant.instanceId !== input.peerInstanceId) {
        return yield* Effect.fail(new IdentityError({ reason: "pairing-mode-grant-instance-mismatch" }))
      }
    }
    const grant = yield* Schema.decodeUnknownEffect(PairingGrantSchema)({
      peerInstanceId: input.peerInstanceId,
      peerPublicKey: input.peerPublicKey,
      ...(input.peerDisplayName !== undefined ? { peerDisplayName: input.peerDisplayName } : {}),
      pairedAt: new Date().toISOString(),
      pairingProtocolVersion: 1 as const,
      categories: { ...input.categories },
      modeGrants: [...input.modeGrants]
    }).pipe(Effect.mapError(() => new IdentityError({ reason: "pairing-grant-invalid" })))
    const next = { ...store, [grant.peerInstanceId]: grant }
    yield* writeFilePrivate(storeFile(paths), JSON.stringify(next, null, 2) + "\n")
    return grant
  })

/**
 * Revoke a pairing grant (§1.3 step 4). Destructive-confirm typed:
 * - without `{ confirmed: true }` → `pairing-revoke-unconfirmed`;
 * - for an unknown peer → `pairing-unknown-peer`.
 *
 * Revocation deletes the grant locally — that is what matters (fail closed:
 * a revoked peer gets nothing even if a remote notice never arrives).
 * Returns the revoked grant so the caller can notify or clean up.
 */
export const revokePairing = (
  paths: AimyPaths,
  peerInstanceId: string,
  confirmation: RevokePairingConfirmation
): Effect.Effect<PairingGrant, IdentityError> =>
  Effect.gen(function* () {
    if (confirmation.confirmed !== true) {
      return yield* Effect.fail(new IdentityError({ reason: "pairing-revoke-unconfirmed" }))
    }
    const store = yield* readStore(paths)
    const existing = store[peerInstanceId]
    if (existing === undefined) {
      return yield* Effect.fail(new IdentityError({ reason: "pairing-unknown-peer" }))
    }
    const next = { ...store }
    delete next[peerInstanceId]
    yield* writeFilePrivate(storeFile(paths), JSON.stringify(next, null, 2) + "\n")
    return existing
  })
