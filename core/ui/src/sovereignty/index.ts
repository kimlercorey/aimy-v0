/**
 * sovereignty/index.ts — the sovereignty slice's public surface.
 *
 * A later integration pass composes this slice into the top-level Model via
 * foldkit's `foldChild`; everything the parent needs is exported here.
 */
export { initialModel, inventoryRowFor, INVENTORY, isVendorNetworkClass, Model, VENDOR_NETWORK_CLASSES } from "./model.js"
export type { CloudEndpointToggle, InventoryRow, Model as SovereigntyModel, OptInEntry, PairSyncScope, VendorNetworkClass, WebResearchToggle } from "./model.js"
export { interpretEgress, snapshotOf } from "./interpreter.js"
export type { EgressAttempt, EgressDecision, ToggleSnapshot } from "./interpreter.js"
export { interruptEgressFor, NetworkEgress, StampTime } from "./commands.js"
export { Message } from "./messages.js"
export type { Message as SovereigntyMessage } from "./messages.js"
export { update } from "./update.js"
export { view } from "./view.js"
