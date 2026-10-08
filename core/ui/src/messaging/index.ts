/**
 * ui/src/messaging/index.ts — the messaging slice's public surface.
 */
export { Message } from "./messages.js"
export type { Message as MessagingMessage } from "./messages.js"
export { initialModel, SEVERITY_KINDS, Model as MessagingModelSchema } from "./model.js"
export type { Model as MessagingModel, WizardStep } from "./model.js"
export { update } from "./update.js"
export type { MessagingResources, MessagingUpdateReturn } from "./update.js"
export { view } from "./view.js"
export { MessagingIpc } from "./seam.js"
export type { MessagingIpcShape, MessagingStatus } from "./seam.js"
