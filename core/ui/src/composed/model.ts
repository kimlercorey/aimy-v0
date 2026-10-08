/**
 * ui/src/composed/model.ts — the fully composed AImy application Model.
 *
 * One immutable, Schema-defined Model for the whole desktop shell: Track 1's
 * shell (session, permissions) nested as the `shell` submodel alongside every
 * other track's real slice. No placeholders — every slice is the owning
 * track's live Schema. The shell's own placeholder slices stay untouched
 * inside `shell` (they are inert); the live slices live here, at the top.
 *
 * Composition: `ui/src/composed/update.ts` routes each `Got*` message through
 * foldkit's `Update.foldChild`; `ui/src/composed/view.ts` renders every panel
 * via `h.submodel`.
 */
import { Schema } from "effect"

import { AscSlice, initialAscSlice } from "../asc/index.js"
import {
  initialModel as initialDevtoolsModel,
  Model as DevtoolsModel,
} from "../devtools/index.js"
import {
  initialModel as initialExportModel,
  Model as ExportModel,
} from "../export/index.js"
import { initialModel as initialShellModel, Model as ShellModel } from "../model.js"
import {
  initialModel as initialOnboardingModel,
  Model as OnboardingModel,
} from "../onboarding/index.js"
import {
  BannersModel,
  initialBannersModel,
  initialJobsModel,
  JobsModel,
} from "../ops/index.js"
import {
  initialModel as initialSovereigntyModel,
  Model as SovereigntyModel,
} from "../sovereignty/index.js"
import {
  initialModel as initialMessagingModel,
  MessagingModelSchema,
  type MessagingModel,
} from "../messaging/index.js"
import {
  initialModel as initialTimelineModel,
  Model as TimelineModel,
} from "../timeline/index.js"

/** The nav panel ids. Chat is the default — everything else is one click away. */
export const PanelId = Schema.Literals([
  "chat",
  "presence",
  "timeline",
  "jobs",
  "banners",
  "messaging",
  "sovereignty",
  "export",
])
export type PanelId = typeof PanelId.Type

export const AppModel = Schema.Struct({
  shell: ShellModel,
  asc: AscSlice,
  sovereignty: SovereigntyModel,
  exportState: ExportModel,
  onboarding: OnboardingModel,
  devtools: DevtoolsModel,
  timeline: TimelineModel,
  jobs: JobsModel,
  banners: BannersModel,
  messaging: MessagingModelSchema,
  activePanel: PanelId,
})
export type AppModel = typeof AppModel.Type

/** The initial app: every slice starts from its own initial state. */
export const initialAppModel = (): AppModel => ({
  shell: initialShellModel(),
  asc: structuredClone(initialAscSlice),
  sovereignty: initialSovereigntyModel(),
  exportState: initialExportModel(),
  onboarding: initialOnboardingModel(),
  devtools: initialDevtoolsModel(),
  timeline: structuredClone(initialTimelineModel),
  jobs: structuredClone(initialJobsModel),
  banners: structuredClone(initialBannersModel),
  messaging: initialMessagingModel(),
  activePanel: "chat",
})
