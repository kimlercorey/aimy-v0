/**
 * Re-exports of the canonical memory-store errors from the substrate error
 * taxonomy. The parallel-build shim was deleted at integration (2026-10-07).
 *
 * NOTE: the shim's `PermissionDenied` had different fields
 * (`{ op, store, reason? }`). The canonical contract is
 * `PermissionDenied { tool: string; tier: Tier; reason: string }`.
 * `service.ts`'s DenyAllGate was reconciled to construct the canonical
 * shape (`tool: "memory:<store>:<op>"`, tier T0 for reads / T1 for writes).
 * No consumer reads the old fields.
 */
export { MemoryStoreError, PermissionDenied } from "../substrate/errors.js"
