/**
 * ui/src/ops/index.ts — the ops slices contract (jobs + banners).
 *
 * What the shell (Track 1) composes via foldChild, one fold per slice:
 * - jobs: `JobsModel` / `JobsMessage` / `jobsUpdate` / `jobsView` /
 *   `jobsSubmodelView` — `JobsResources = JobRunner | RunHistory`
 * - banners: `BannersModel` / `BannersMessage` / `bannersUpdate` / `bannersView`
 *   / `bannersSubmodelView` — `BannersResources = CommsBanner`
 */
export {
  Model as JobsModel,
  initialModel as initialJobsModel,
  Message as JobsMessage,
  update as jobsUpdate,
  RefreshJobs,
  PauseJob,
  ResumeJob,
  CancelJob,
  RunJobNow,
  scheduledJobs,
  runningRuns,
  completedRuns,
  failedRuns,
  inactiveJobs,
  describeRestart,
  JobDescriptorSchema,
  RunRecordSchema,
  TierSchema,
} from "./jobs-slice.js"
export type {
  Model as JobsModelType,
  Message as JobsMessageType,
  UiJobDescriptor,
  UiRunRecord,
  JobsResources,
  JobsUpdateReturn,
} from "./jobs-slice.js"
export { view as jobsView, jobsSubmodelView } from "./jobs-view.js"

export {
  Model as BannersModel,
  initialModel as initialBannersModel,
  Message as BannersMessage,
  update as bannersUpdate,
  RefreshBanners,
  DismissBanner,
  priorityOrdered,
  visibleBanners,
  inQuietHours,
  BannerSchema,
  BannerSeveritySchema,
  QuietHoursSchema,
} from "./banners-slice.js"
export type {
  Model as BannersModelType,
  Message as BannersMessageType,
  UiBanner,
  UiBannerSeverity,
  QuietHours,
  BannersResources,
  BannersUpdateReturn,
} from "./banners-slice.js"
export { view as bannersView, bannersSubmodelView } from "./banners-view.js"
