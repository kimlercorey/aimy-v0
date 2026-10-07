/**
 * identity/index.ts — public surface of the identity library.
 *
 * - `identity.ts`: install UUID, versioned identity document, Ed25519
 *   instance keypair, `IdentityService` (+ layers).
 * - `locker.ts`: `SecretLocker`, OS-keychain backend interface + stub,
 *   passphrase-sealed file-vault backend.
 * - `mode-grants.ts`: per-instance mode grants (user-set, non-transferable).
 * - `pairing.ts`: pairing grant types + grants store (pairing-ready design;
 *   no pairing implementation).
 * - `display-name.ts`: display-name rename operation (audit-logged).
 * - `bytes.ts`: shared byte-encoding helpers.
 */
export * from "./bytes.js"
export * from "./identity.js"
export * from "./locker.js"
export * from "./mode-grants.js"
export * from "./pairing.js"
export * from "./display-name.js"
