/**
 * ui/src/composed/index.ts — the composed AImy application: clean exports.
 *
 * The full app: one Model, one Message union, one update, one view —
 * every M8 panel composed via foldkit's foldChild/submodel pattern.
 */
export { AppModel, initialAppModel } from "./model.js"
export type { AppModel as AppModelType } from "./model.js"
export { AppMessage } from "./messages.js"
export type { AppMessage as AppMessageType } from "./messages.js"
export { update as appUpdate, type AppServices } from "./update.js"
export { view as appView } from "./view.js"
