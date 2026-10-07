/**
 * ui/src/timeline/index.ts — the learning-timeline slice contract.
 *
 * What the shell (Track 1) composes via foldChild:
 * - `Model` / `initialModel` — the Schema Model slice
 * - `Message` — the Message union
 * - `update` — the pure update (`TimelineResources` = TimelineStore | LearningTimeline)
 * - `view` / `viewDocument` / `timelineSubmodelView` — the views
 * - `RefreshTimeline` — the initial-load Command (dispatch
 *   `Message.TimelineRefreshRequested()` instead; equivalent)
 */
export {
  Model,
  initialModel,
  TimelineNodeSchema,
  TimelineFiltersSchema,
  LearningEventTypeSchema,
  ProvenanceSchema,
  DEFAULT_STORE_BUDGETS,
  labelFor,
  shortNodeId,
  skillVerificationStatus,
  applyFilters,
  deriveEntriesUsed,
} from "./model.js"
export type { TimelineNode, TimelineFilters, TimelineProvenance, LearningEventType } from "./model.js"
export { Message } from "./messages.js"
export type { Message as TimelineMessage } from "./messages.js"
export { update, type TimelineResources, type TimelineUpdateReturn } from "./update.js"
export { RefreshTimeline, ArchiveTimelineNode, RestoreTimelineNode } from "./commands.js"
export { view, viewDocument, timelineSubmodelView } from "./view.js"
