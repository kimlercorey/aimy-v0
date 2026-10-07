/**
 * substrate/index.ts — the public surface of the substrate library.
 *
 * Every core library depends on this module; it depends on nothing but
 * `effect` (plus node builtins for filesystem access in `config`).
 */
export * from "./errors.js"
export * from "./types.js"
export * from "./config.js"
