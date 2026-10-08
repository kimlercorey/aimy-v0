/**
 * Re-export shim: the FACS engine's canonical home is now
 * `core/asc-channels/src/facs.ts` (channel-domain logic, not UI).
 * This module keeps existing `ui/src/asc/*` imports working.
 */
export * from "../../../asc-channels/src/facs.js"
