# Identity library

Install identity + secret locker for Project AImy (architecture Part 02 §1; MUST #4 install UUID, MUST #6 secret locker).

## Public interface

### `IdentityService` (`identity.ts`)

Effect service in the class style (`class IdentityService extends Context.Service<IdentityService, IdentityServiceShape>()("aimy/IdentityService")`), exposing:

- `instanceId: InstanceId` — install UUID v4, generated **once** at first install via `crypto.randomUUID()`, stored in the XDG config dir (`<config>/instance-id`, 0600). Offline-safe. Namespaces all per-instance state.
- `document: IdentityDocument` — versioned identity document `{ version: 1, instanceId, createdAt, publicKey, pairingProtocolVersion: 1, displayName? }`, Schema-validated, stored as `<config>/identity.json` (0600). **Contains no secrets by construction** — the type has no secret-typed fields (structural test in `identity.test.ts`). `pairingProtocolVersion` is the pairing-handshake compatibility signal (M7 Track 1); `publicKey` is the pairing authentication anchor.
- `sign(message: Uint8Array): Effect<Uint8Array, IdentityError>` — Ed25519 signatures with the instance private key (LAN pairing handshakes, §1.3).

Key lifecycle: Ed25519 keypair is generated at install (node:crypto webcrypto). The private half (JWK) goes **only** to the `SecretLocker` under scope `{ profile: "instance" }`; the public half (base64url) goes in the document. On repeat launches the sealed key is re-imported and the pair is self-checked (sign probe + verify against the document's public key) — a broken seal, missing key, or id/document mismatch fails typed (`IdentityError`), never silently.

`migrateIdentityDocument(raw)` is the version-migration stub: v1 decodes, unknown versions fail typed.

Layers:

- `IdentityServiceLive(options)` — requires `SecretLocker` in the environment.
- `FileLockerLive(options)` — file-vault `SecretLocker` (see below).
- `IdentityStackLive({ passphrase, paths?, instanceId?, displayName? })` — the composed one-shot layer: resolves the instance id once, then provides the file locker into the identity service.

`bytes.ts` holds the shared byte helpers (`strictBytes`, base64/base64url encode/decode) so `identity.ts` and `locker.ts` don't import each other.

### `SecretLocker` (`locker.ts`)

Effect service (`class SecretLocker extends Context.Service<SecretLocker, SecretLockerShape>()("aimy/SecretLocker")`):

- `store(name, secret: Redacted<string>, scope)` / `retrieve(name, scope): Effect<Redacted<string>, IdentityError>` / `remove(name, scope)`
- `manifest(): Effect<Array<{ name, scope }>>` — names + scopes **only**, never values. This is exactly what one-click export (MUST #16) consumes.

Rules enforced in code:

- **Profile-scoped, fail-closed reads** (Hermes #93522): secrets are keyed by `(profile, name)`; a wrong-profile read is indistinguishable from "not found" (`secret-not-found`) — no oracle, no cross-profile inheritance.
- **Redacted end-to-end** (Pi #10291): secrets never appear in logs, traces, error reasons, or JSON. The only `reveal()` call sites are inside the AES-GCM seal/open operations. Error `reason`s are machine-readable constants.
- **Keychain discipline**: `KeychainBackend` (`getServiceSecret` / `setServiceSecret` / `deleteServiceSecret` / `available`) is the OS-keychain interface; `KeychainUnavailable` is the stub reporting unavailable (real platform bindings are a later milestone).

### Mode grants (`mode-grants.ts`) — M7 Track 1

Per-instance mode grants (architecture Part 02 §1.4, §1.6): capability flags like `intimate-mode` the user sets explicitly **on this instance**.

- `ModeGrantSchema` — `{ mode, instanceId, grantedAt, grantedBy: "user" }`. The embedded `instanceId` is the structural seal: the grant is meaningful only on its owning instance.
- `setModeGrant(paths, instanceId, mode)` — user-set, idempotent, stamps this instance's id at write time (callers cannot forge another instance's grant). `revokeModeGrant(paths, instanceId, mode)` — typed `mode-grant-unknown` when absent. `listModeGrants` / `hasModeGrant` readers.
- `validateModeGrantForInstance(grant, instanceId)` — a grant presented for a different instanceId is rejected typed (`mode-grant-wrong-instance`), in memory and at store read. **Mode grants are never transferable by pairing sync**: there is no operation that applies a foreign grant locally, and the sync transport must never carry mode grants (structural tests in `mode-grants.test.ts`).
- Persisted in `<config>/mode-grants.json` (0600) — per-instance config, never synced.

### Pairing grants (`pairing.ts`) — M7 Track 1 (pairing-ready, not pairing-implemented)

- `PAIRING_PROTOCOL_VERSION = 1` — stamped into every identity document at install; two instances pair only when they agree on it. Pre-M7 documents (without the field) normalize to 1 in `migrateIdentityDocument`; a document claiming any other value fails typed.
- `PairingGrantSchema` — the per-pair trust record (§1.3): `{ peerInstanceId, peerPublicKey, peerDisplayName?, pairedAt, pairingProtocolVersion, categories, modeGrants }`.
  - `categories`: per-category sync policies, `off | push | pull | bidirectional` (§1.4).
  - `modeGrants`: a **read-only snapshot** of the modes the peer declared at pairing time (for display / modules' `pairingPeers` context). Non-transferable by construction: every entry's `instanceId` must equal `peerInstanceId` (enforced in `grantPairing`, typed `pairing-mode-grant-instance-mismatch`), and these entries are never written to the local mode-grant store.
- Store: `<config>/pairing-grants.json` (0600), keyed by peer instanceId. `grantPairing` (typed `pairing-peer-already-granted` on duplicate — re-pairing goes through revoke-then-grant; typed `pairing-grant-invalid` on schema failure), `revokePairing` (destructive-confirm: requires `{ confirmed: true }`, typed `pairing-revoke-unconfirmed` without it, typed `pairing-unknown-peer` for an unknown peer — revocation never silently succeeds or no-ops), `getPairingGrant` / `listPairingGrants` readers.
- Design-only handshake shapes (no implementation): `PairingHandshakeChallenge` / `PairingHandshakeResponse` (nonce signed by the instance private key, verified against the document's `publicKey`) and `PairingConsentCode` (out-of-band mutual-consent code). See "Future pairing handshake (design)" below.

### Display-name rename (`display-name.ts`) — M7 Track 1

- `renameDisplayName(service, paths, displayName)` — rewrites `identity.json` preserving `version`, `instanceId`, `createdAt`, `publicKey`, and `pairingProtocolVersion` by round-tripping through `migrateIdentityDocument` (a rename can add nothing and corrupt nothing).
- Renames are audit-logged, never silent: the operation appends a `display-name-renamed` event to the XDG state audit trail (`<state>/identity-audit.jsonl`, 0600) **and** returns the event to the caller.
- Typed refusals: `display-name-invalid` (empty/whitespace or > 128 chars), `display-name-unchanged` (renaming to the current name is never a silent no-op).

## Future pairing handshake (design — no implementation)

When LAN pairing ships (a later milestone), the handshake this identity layer is designed to support runs:

1. **Identity document exchange.** Each side sends its versioned identity document — portable, secret-free. The receiver checks `pairingProtocolVersion` agreement (mismatch → abort, typed) and pins the peer's `publicKey`: the pairing authentication anchor.
2. **Out-of-band mutual consent.** A short numeric code (or QR payload) is displayed on the *target* instance and confirmed on the initiator. Both screens show the same code; this defeats LAN spoofing (§1.3). Codes are single-use and short-lived (`PairingConsentCode`).
3. **Challenge-response.** The initiator sends a fresh 32-byte nonce (`PairingHandshakeChallenge`); the responder signs the canonical challenge bytes with its instance private key (`IdentityService.sign`); the initiator verifies the signature against the `publicKey` from the exchanged document (`PairingHandshakeResponse`). Only the true holder of the peer's private key passes.
4. **Grant recording.** Both sides record a `PairingGrant` (peer id, public key, display name, `pairedAt`, per-category sync policies, read-only mode-grant snapshot) in `<config>/pairing-grants.json`. Pairwise, non-transitive, revocable at any time; revocation deletes the grant locally (fail closed — a revoked peer gets nothing even if a remote notice never arrives).

Explicitly out of scope here: mDNS discovery, QR generation, X25519/TLS 1.3 session establishment, and sync. Those are later milestones; this track only guarantees the identity side is ready for them.

## Decision record: headless-Linux keychain fallback (open risk OR-1)

**Decision:** implement the **passphrase-sealed file vault** as this phase's working backend, and document it as the chosen headless-Linux fallback.

- Envelope: PBKDF2-SHA256 (600k iterations, random 16-byte salt) derives a KEK from a user-supplied passphrase; the vault payload (JSON entries) is sealed with AES-256-GCM (fresh 12-byte IV per write). File: `<data>/<instanceId>/locker/vault.json`, mode 0600, parent dirs 0700.
- Wrong passphrase → GCM auth failure → typed `IdentityError("vault-unseal-failed")` at layer build. Never silent, never partial state.
- This satisfies the architecture's constraint — *"fail-closed or explicitly user-chosen, never silent plaintext"* — while real OS-keychain bindings land in a later milestone, at which point the file vault becomes the explicit opt-in fallback rather than the default.

## Files

- `identity.ts` — `IdentityService`, identity document (now with `pairingProtocolVersion`), keypair lifecycle, layers.
- `locker.ts` — `SecretLocker`, `KeychainBackend` + stub, file-vault backend.
- `mode-grants.ts` — per-instance mode grants: user-set, stamped with the owning instance id, structurally non-transferable.
- `pairing.ts` — `PairingGrant` types, pairing grants store (0600, keyed by peer), design-only handshake shapes.
- `display-name.ts` — audit-logged display-name rename operation.
- `bytes.ts` — shared byte helpers.
- `index.ts` — re-exports.
- `identity.test.ts`, `locker.test.ts`, `mode-grants.test.ts`, `pairing.test.ts`, `display-name.test.ts` — vitest + `@effect/vitest` suites (43 tests).

## Deviations & integration notes

- **No substrate shims needed.** The substrate track landed (`errors.ts`, `types.ts`, `config.ts`) before this build; the identity library builds directly on the real contracts: `IdentityError` as `Data.TaggedError("IdentityError")<{ reason: string }>` (constructed `new IdentityError({ reason })`), `Redacted` with `Redacted.make` / `.reveal()`, `resolvePaths()` returning `{ data, config, state }`, and the branded `InstanceId` type.
- **Effect 4.0.1 API corrections applied** (per the inference-pool build): services use the class style `class X extends Context.Service<X, XShape>()("aimy/X")` (`Context.Tag` does not exist in v4); `Layer.effect(tag)(effect)` is curried; `Schema.decodeUnknownEffect` (no `decodeUnknown`); `Effect.flip` for failure assertions (no `Effect.either`); namespaced `Effect.Effect<A, E, R>` types throughout.
- `resolvePaths()` has no cache dir in this substrate version; identity only needs config + data.
- The passphrase currently arrives as a `Redacted<string>` layer option (test/CLI-supplied). The onboarding flow that *collects* it from the user (and the OS-keychain-first backend selection) belongs to a later milestone; the vault backend is ready to sit behind either.
- PBKDF2 iteration count (600k) is a constant; a future security-review pass may retune it (see architecture open risk #3 owner: security review, pre-MVP).
- Toolchain note: `@types/node` 26 types WebCrypto `BufferSource` strictly, so all byte views crossing the subtle boundary go through `strictBytes` (copies into an `ArrayBuffer`-backed `Uint8Array`); crypto globals are referenced via the `webcrypto` namespace (`webcrypto.CryptoKey`, `webcrypto.JsonWebKey`) since the DOM lib is not in scope.
- Pre-existing repo issue (not mine): `module-seam/src/sandbox.ts` line 51 has a syntax error (extra `)`) that breaks the shared `tsc --noEmit`; identity itself typechecks clean.
