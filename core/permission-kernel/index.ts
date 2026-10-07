/**
 * permission-kernel/index.ts — the public surface of the permission-kernel library.
 *
 * Depends on `../substrate` (errors, branded types, XDG path resolution) and
 * on `effect`. Nothing else.
 */
export * from "./policy.js"
export * from "./kernel.js"
