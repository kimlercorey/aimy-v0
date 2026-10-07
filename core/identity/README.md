# Identity library

Install identity + secret locker for Project AImy (architecture Part 02 §1; MUST #4 install UUID, MUST #6 secret locker).

## Public interface

### `IdentityService` (`identity.ts`)

Effect service in the class style (`class IdentityService extends Context.Service<IdentityService, IdentityServiceShape>()("aimy/IdentityService")`), exposing:

- `instanceId: InstanceId` — install UUID v4, generated **once** at first install via `crypto.randomUUID()`, stored in the XDG config dir (`<config>/instance-id`, 0600). Offline-safe. Namespaces all per-instance state.
- `document: IdentityDocument` — versioned identity document `{ version: 1, instanceId, createdAt, publicKey, displayName? }`, Schema-validated, stored as `<config>/identity.json` (0600). **Contains no secrets by construction** — the type has no secret-typed fields (structural test in `identity.test.ts`).
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

## Decision record: headless-Linux keychain fallback (open risk OR-1)

**Decision:** implement the **passphrase-sealed file vault** as this phase's working backend, and document it as the chosen headless-Linux fallback.

- Envelope: PBKDF2-SHA256 (600k iterations, random 16-byte salt) derives a KEK from a user-supplied passphrase; the vault payload (JSON entries) is sealed with AES-256-GCM (fresh 12-byte IV per write). File: `<data>/<instanceId>/locker/vault.json`, mode 0600, parent dirs 0700.
- Wrong passphrase → GCM auth failure → typed `IdentityError("vault-unseal-failed")` at layer build. Never silent, never partial state.
- This satisfies the architecture's constraint — *"fail-closed or explicitly user-chosen, never silent plaintext"* — while real OS-keychain bindings land in a later milestone, at which point the file vault becomes the explicit opt-in fallback rather than the default.

## Files

- `identity.ts` — `IdentityService`, identity document, keypair lifecycle, layers.
- `locker.ts` — `SecretLocker`, `KeychainBackend` + stub, file-vault backend.
- `bytes.ts` — shared byte helpers.
- `index.ts` — re-exports.
- `identity.test.ts`, `locker.test.ts` — vitest + `@effect/vitest` suites (19 tests).

## Deviations & integration notes

- **No substrate shims needed.** The substrate track landed (`errors.ts`, `types.ts`, `config.ts`) before this build; the identity library builds directly on the real contracts: `IdentityError` as `Data.TaggedError("IdentityError")<{ reason: string }>` (constructed `new IdentityError({ reason })`), `Redacted` with `Redacted.make` / `.reveal()`, `resolvePaths()` returning `{ data, config, state }`, and the branded `InstanceId` type.
- **Effect 4.0.1 API corrections applied** (per the inference-pool build): services use the class style `class X extends Context.Service<X, XShape>()("aimy/X")` (`Context.Tag` does not exist in v4); `Layer.effect(tag)(effect)` is curried; `Schema.decodeUnknownEffect` (no `decodeUnknown`); `Effect.flip` for failure assertions (no `Effect.either`); namespaced `Effect.Effect<A, E, R>` types throughout.
- `resolvePaths()` has no cache dir in this substrate version; identity only needs config + data.
- The passphrase currently arrives as a `Redacted<string>` layer option (test/CLI-supplied). The onboarding flow that *collects* it from the user (and the OS-keychain-first backend selection) belongs to a later milestone; the vault backend is ready to sit behind either.
- PBKDF2 iteration count (600k) is a constant; a future security-review pass may retune it (see architecture open risk #3 owner: security review, pre-MVP).
- Toolchain note: `@types/node` 26 types WebCrypto `BufferSource` strictly, so all byte views crossing the subtle boundary go through `strictBytes` (copies into an `ArrayBuffer`-backed `Uint8Array`); crypto globals are referenced via the `webcrypto` namespace (`webcrypto.CryptoKey`, `webcrypto.JsonWebKey`) since the DOM lib is not in scope.
- Pre-existing repo issue (not mine): `module-seam/src/sandbox.ts` line 51 has a syntax error (extra `)`) that breaks the shared `tsc --noEmit`; identity itself typechecks clean.
