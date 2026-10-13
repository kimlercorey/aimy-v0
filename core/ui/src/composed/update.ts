/**
 * ui/src/composed/update.ts — the composed application's update function.
 *
 * Pure `(AppMessage, AppModel) -> (AppModel, Command[])`. Each `Got*` envelope
 * routes through foldkit's `Update.foldChild` to the owning slice's update;
 * the slice reads and writes only its own submodel. The shell keeps its
 * rejection gate (unknown tags, dial-mutation attempts) because its update
 * still validates every message it receives.
 *
 * Service requirements are the union of every slice's requirements; the
 * shell boundary provides them all.
 */
import { Option, Schema } from "effect"
import { Update } from "foldkit"

import type { ASCEngine } from "../../../asc-engine/engine.js"
import type { CommsBanner } from "../../../comms/service.js"
import type { JobRunner } from "../../../jobs/src/runner.js"
import type { RunHistory } from "../../../jobs/src/history.js"
import type { LearningTimeline } from "../../../learning/src/timeline.js"
import { ascUpdate } from "../asc/index.js"
import type { AscMessage, AscSlice } from "../asc/index.js"
import { update as devtoolsUpdate } from "../devtools/index.js"
import type { DevtoolsMessage, DevtoolsModel } from "../devtools/index.js"
import type { ExportInterpreter } from "../export/seam.js"
import { update as exportUpdate } from "../export/index.js"
import type { ExportMessage, ExportModel } from "../export/index.js"
import { update as shellUpdate, type ShellServices } from "../update.js"
import { type Model as ShellModel } from "../model.js"
import { Message as ShellMessage } from "../messages.js"
import { update as onboardingUpdate } from "../onboarding/index.js"
import type { OnboardingMessage, OnboardingModel } from "../onboarding/index.js"
import type { OnboardingPersistence } from "../onboarding/seam.js"
import {
  bannersUpdate,
  jobsUpdate,
  type BannersMessageType,
  type BannersModelType,
  type JobsMessageType,
  type JobsModelType,
} from "../ops/index.js"
import { update as sovereigntyUpdate } from "../sovereignty/index.js"
import type { SovereigntyMessage, SovereigntyModel } from "../sovereignty/index.js"
import { update as timelineUpdate, Message as TimelineMsg } from "../timeline/index.js"
import type { Message as TimelineMessage, Model as TimelineModel } from "../timeline/index.js"
import { update as messagingUpdate, Message as MessagingMsg } from "../messaging/index.js"
import type { MessagingMessage, MessagingModel } from "../messaging/index.js"
import type { MessagingIpc } from "../messaging/seam.js"
import type { TtsIpc } from "../voice/seam.js"
import type { DevtoolsRelay } from "../devtools/seam.js"
import { AppMessage } from "./messages.js"
import type { AppModel } from "./model.js"

/** Every service any slice's commands can require. Provided at the boundary. */
export type AppServices =
  | ShellServices
  | ASCEngine
  | CommsBanner
  | JobRunner
  | RunHistory
  | LearningTimeline
  | ExportInterpreter
  | OnboardingPersistence
  | DevtoolsRelay
  | MessagingIpc
  | TtsIpc

// The shell's update validates `unknown`; the typed envelope is a no-op pass.
// The shell's update validates `unknown` itself (rejection gate), so the fold
// accepts unknown too: malformed top-level messages land in the shell's audit
// trail via the same path as its own DevTools/MCP dispatch.
const foldShell = Update.foldChild({
  update: (childModel: ShellModel, input: unknown) => shellUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.shell),
  write: (model, shell) => ({ ...model, shell }),
  toParentMessage: (message) => AppMessage.GotShell({ message }),
})

const foldAsc = Update.foldChild({
  update: (childModel: AscSlice, input: AscMessage) => ascUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.asc),
  write: (model, asc) => ({ ...model, asc }),
  toParentMessage: (message) => AppMessage.GotAsc({ message }),
})

const foldSovereignty = Update.foldChild({
  update: (childModel: SovereigntyModel, input: SovereigntyMessage) =>
    sovereigntyUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.sovereignty),
  write: (model, sovereignty) => ({ ...model, sovereignty }),
  toParentMessage: (message) => AppMessage.GotSovereignty({ message }),
})

const foldExport = Update.foldChild({
  update: (childModel: ExportModel, input: ExportMessage) => exportUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.exportState),
  write: (model, exportState) => ({ ...model, exportState }),
  toParentMessage: (message) => AppMessage.GotExport({ message }),
})

const foldOnboarding = Update.foldChild({
  update: (childModel: OnboardingModel, input: OnboardingMessage) =>
    onboardingUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.onboarding),
  write: (model, onboarding) => ({ ...model, onboarding }),
  toParentMessage: (message) => AppMessage.GotOnboarding({ message }),
})

const foldDevtools = Update.foldChild({
  update: (childModel: DevtoolsModel, input: DevtoolsMessage) =>
    devtoolsUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.devtools),
  write: (model, devtools) => ({ ...model, devtools }),
  toParentMessage: (message) => AppMessage.GotDevtools({ message }),
})

const foldTimeline = Update.foldChild({
  update: (childModel: TimelineModel, input: TimelineMessage) =>
    timelineUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.timeline),
  write: (model, timeline) => ({ ...model, timeline }),
  toParentMessage: (message) => AppMessage.GotTimeline({ message }),
})

const foldJobs = Update.foldChild({
  update: (childModel: JobsModelType, input: JobsMessageType) =>
    jobsUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.jobs),
  write: (model, jobs) => ({ ...model, jobs }),
  toParentMessage: (message) => AppMessage.GotJobs({ message }),
})

const foldBanners = Update.foldChild({
  update: (childModel: BannersModelType, input: BannersMessageType) =>
    bannersUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.banners),
  write: (model, banners) => ({ ...model, banners }),
  toParentMessage: (message) => AppMessage.GotBanners({ message }),
})

const foldMessaging = Update.foldChild({
  update: (childModel: MessagingModel, input: MessagingMessage) =>
    messagingUpdate(childModel, input),
  read: (model: AppModel) => Option.some(model.messaging),
  write: (model, messaging) => ({ ...model, messaging }),
  toParentMessage: (message) => AppMessage.GotMessaging({ message }),
})

export const update = (
  model: AppModel,
  rawMessage: unknown,
): Update.Return<AppModel, AppMessage, AppServices> => {
  // The DevTools/MCP dispatch path hands unvalidated JSON to the update.
  // Anything that is not a valid AppMessage goes to the shell's rejection
  // gate: it classifies (dial-mutation-rejected / unknown-tag / decode-failed)
  // and logs to the bounded audit trail, changing nothing else. The shell's
  // update accepts unknown, so the envelope validation here is a no-op for it.
  if (!Schema.is(AppMessage)(rawMessage)) {
    return foldShell(model, rawMessage)
  }
  const message: AppMessage = rawMessage
  return AppMessage.match(message, {
    GotShell: ({ message }) => {
      const result = foldShell(model, message)
      // Opening a document (Continue row, project asset) loads it into
      // the drawer — which lives in the Chat panel. From any other
      // panel (e.g. Projects) the click would otherwise land invisibly;
      // bring the user to where the document opened (2026-10-12).
      if (message._tag === "HomeRecentClicked" && model.activePanel !== "chat") {
        return { ...result, model: { ...result.model, activePanel: "chat" as const } }
      }
      return result
    },
    GotAsc: ({ message }) => foldAsc(model, message),
    GotSovereignty: ({ message }) => foldSovereignty(model, message),
    GotExport: ({ message }) => foldExport(model, message),
    GotOnboarding: ({ message }) => foldOnboarding(model, message),
    GotDevtools: ({ message }) => foldDevtools(model, message),
    GotTimeline: ({ message }) => foldTimeline(model, message),
    GotJobs: ({ message }) => foldJobs(model, message),
    GotBanners: ({ message }) => foldBanners(model, message),
    GotMessaging: ({ message }) => foldMessaging(model, message),
    SelectPanel: ({ panel }) => {
      const withPanel = { ...model, activePanel: panel }
      if (panel === "messaging") {
        // Opening the messaging panel refreshes its status from main.
        return foldMessaging(
          withPanel,
          MessagingMsg.StatusRequested({})
        )
      }
      if (panel === "home") {
        // The Home destination IS the dash — refresh both its data
        // feeds on entry (home data + dash state).
        const step1 = foldShell(withPanel, ShellMessage.HomeDataRefreshRequested({}))
        const step2 = foldShell(step1.model, ShellMessage.HomedashRefreshRequested({}))
        return {
          model: step2.model,
          commands: [...(step1.commands ?? []), ...(step2.commands ?? [])],
        }
      }
      if (panel === "projects") {
        // The Projects destination renders the shell's home data —
        // refresh it on entry; it otherwise loads only on drawer open
        // and after home actions (2026-10-12).
        return foldShell(
          withPanel,
          ShellMessage.HomeDataRefreshRequested({})
        )
      }
      if (panel === "memory" || panel === "timeline") {
        // The Memory destination IS the learning timeline — refresh
        // it on entry, like Home and Projects refresh theirs
        // (2026-10-13). Without this the panel opened on its initial
        // empty snapshot until its own refresh button was pressed.
        return foldTimeline(
          withPanel,
          TimelineMsg.TimelineRefreshRequested({})
        )
      }
      return { model: withPanel }
    },

    NavToggled: ({ open }) => {
      try {
        localStorage.setItem("aimy.navOpen", open ? "1" : "0")
      } catch { /* private mode */ }
      return {
        model: { ...model, navOpen: open },
      }
    },
  })
}
