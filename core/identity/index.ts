/**
 * identity/index.ts — public surface of the identity library.
 *
 * - `identity.ts`: install UUID, versioned identity document, Ed25519
 *   instance keypair, `IdentityService` (+ layers).
 * - `locker.ts`: `SecretLocker`, OS-keychain backend interface + stub,
 *   passphrase-sealed file-vault backend.
 * - `bytes.ts`: shared byte-encoding helpers.
 */
export * from "./bytes.js"
export * from "./identity.js"
export * from "./locker.js"
