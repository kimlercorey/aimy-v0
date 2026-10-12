/**
 * ui/src/composed/view.ts — the fully composed application view.
 *
 * One Document: the shell (chat + permissions) followed by every panel
 * (ASC, sovereignty, export, onboarding, timeline, jobs, banners, devtools),
 * each rendered through `h.submodel` so messages route back through the
 * `Got*` envelopes. DevTools renders nothing when its flag is off (the slice
 * guarantees that). Pure function of the AppModel.
 */
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"

import { ascSection, type AscMessage, type AscSlice } from "../asc/index.js"
import { view as appShellView } from "../app.js"
import type { Message as ShellMessage } from "../messages.js"
import type { Model as ShellModel } from "../model.js"
import { view as devtoolsView } from "../devtools/view.js"
import type { DevtoolsMessage, DevtoolsModel } from "../devtools/index.js"
import { view as exportView } from "../export/view.js"
import type { ExportMessage, ExportModel } from "../export/index.js"
import { permissionsView } from "../permissions/view.js"
import { icon } from "../icons.js"
import { view as onboardingView } from "../onboarding/view.js"
import type { OnboardingMessage, OnboardingModel } from "../onboarding/index.js"
import {
  bannersSubmodelView,
  jobsSubmodelView,
  type BannersMessageType,
  type BannersModelType,
  type JobsMessageType,
  type JobsModelType,
} from "../ops/index.js"
import { view as sovereigntyView } from "../sovereignty/view.js"
import type { SovereigntyMessage, SovereigntyModel } from "../sovereignty/index.js"
import { view as messagingView } from "../messaging/view.js"
import { Message as MessagingSliceMsg } from "../messaging/index.js"
import type { MessagingModel } from "../messaging/index.js"
import { timelineSubmodelView } from "../timeline/index.js"
import type { Message as TimelineMessage, Model as TimelineModel } from "../timeline/index.js"
import { settingsView } from "../settings-view.js"
import { AppMessage } from "./messages.js"
import type { AppModel, PanelId } from "./model.js"

const shellSubmodelView = defineView<ShellModel, ShellMessage>((model, h) =>
  appShellView(model, h).body,
)
const ascSubmodelView = defineView<AscSlice, AscMessage>((model, h) => ascSection(model, h))
const sovereigntySubmodelView = defineView<SovereigntyModel, SovereigntyMessage>(
  (model, h) => sovereigntyView(model, h),
)
const messagingSubmodelView = defineView<MessagingModel, MessagingSliceMsg>(
  (model, h) => messagingView(model, h),
)
const exportSubmodelView = defineView<ExportModel, ExportMessage>((model, h) =>
  exportView(model, h),
)
const onboardingSubmodelView = defineView<OnboardingModel, OnboardingMessage>(
  (model, h) => onboardingView(model, h),
)
const settingsSubmodelView = defineView<ShellModel, ShellMessage>(
  (model, h) => settingsView(h as never, model.session),
)
const devtoolsSubmodelView = defineView<DevtoolsModel, DevtoolsMessage>((model, h) =>
  devtoolsView(model, h),
)

const panel = (
  h: HtmlBuilder<AppMessage>,
  slotId: string,
  title: string,
  body: Html,
): Html =>
  h.section([h.Class("app-panel")], [
    h.h2([h.Class("app-panel-title")], [title]),
    body,
  ])

/** Nav order. Chat is first and default — the test loop never scrolls. */
const NAV_ITEMS: ReadonlyArray<{ readonly id: PanelId; readonly label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "presence", label: "Presence" },
  { id: "timeline", label: "Timeline" },
  { id: "jobs", label: "Jobs" },
  { id: "banners", label: "Banners" },
  { id: "messaging", label: "Messaging" },
  { id: "sovereignty", label: "Sovereignty" },
  { id: "permissions", label: "Permissions" },
  { id: "export", label: "Export" },
]

const navView = (model: AppModel, h: HtmlBuilder<AppMessage>): Html =>
  h.div([h.Class("app-nav")], [
    h.div([h.Class("app-nav-header")], [
      h.button(
        [
          h.Class("icon-btn"),
          h.Title("Close navigation"),
          h.OnClick(AppMessage.NavToggled({ open: false })),
        ],
        [icon.chevronLeft(h)]
      ),
    ]),
    ...NAV_ITEMS.map((item) =>
      h.button(
        [
          h.OnClick(AppMessage.SelectPanel({ panel: item.id })),
          h.Class(item.id === model.activePanel ? "nav-item nav-active" : "nav-item"),
        ],
        [item.label],
      ),
    ),
    // Settings at the bottom with gear icon.
    h.div([h.Class("app-nav-footer")], [
      h.button(
        [
          h.OnClick(AppMessage.SelectPanel({ panel: "settings" })),
          h.Class("settings" === model.activePanel ? "nav-item nav-active" : "nav-item"),
          h.Title("Settings"),
        ],
        [icon.settings(h), " Settings"],
      ),
    ]),
  ])

const activePanelView = (model: AppModel, h: HtmlBuilder<AppMessage>): Html => {
  switch (model.activePanel) {
    case "chat":
      return h.submodel({
        slotId: "app-shell",
        model: model.shell,
        view: shellSubmodelView,
        toParentMessage: (message) => AppMessage.GotShell({ message }),
      })
    case "presence":
      return panel(
        h,
        "app-asc",
        "presence",
        h.submodel({
          slotId: "app-asc",
          model: model.asc,
          view: ascSubmodelView,
          toParentMessage: (message) => AppMessage.GotAsc({ message }),
        }),
      )
    case "timeline":
      return panel(
        h,
        "app-timeline",
        "learning timeline",
        h.submodel({
          slotId: "app-timeline",
          model: model.timeline,
          view: timelineSubmodelView,
          toParentMessage: (message) => AppMessage.GotTimeline({ message }),
        }),
      )
    case "jobs":
      return panel(
        h,
        "app-jobs",
        "jobs",
        h.submodel({
          slotId: "app-jobs",
          model: model.jobs,
          view: jobsSubmodelView,
          toParentMessage: (message) => AppMessage.GotJobs({ message }),
        }),
      )
    case "banners":
      return panel(
        h,
        "app-banners",
        "banners",
        h.submodel({
          slotId: "app-banners",
          model: model.banners,
          view: bannersSubmodelView,
          toParentMessage: (message) => AppMessage.GotBanners({ message }),
        }),
      )
    case "sovereignty":
      return panel(
        h,
        "app-sovereignty",
        "sovereignty",
        h.submodel({
          slotId: "app-sovereignty",
          model: model.sovereignty,
          view: sovereigntySubmodelView,
          toParentMessage: (message) => AppMessage.GotSovereignty({ message }),
        }),
      )
    case "messaging":
      return panel(
        h,
        "app-messaging",
        "messaging",
        h.submodel({
          slotId: "app-messaging",
          model: model.messaging,
          view: messagingSubmodelView,
          toParentMessage: (message) => AppMessage.GotMessaging({ message }),
        }),
      )
    case "permissions":
      return panel(
        h,
        "app-permissions",
        "permissions",
        permissionsView(model.shell.permissions, h as never),
      )
    case "export":
      return panel(
        h,
        "app-export",
        "export",
        h.submodel({
          slotId: "app-export",
          model: model.exportState,
          view: exportSubmodelView,
          toParentMessage: (message) => AppMessage.GotExport({ message }),
        }),
      )
    case "settings":
      return panel(
        h,
        "app-settings",
        "settings",
        h.submodel({
          slotId: "app-settings",
          model: model.shell,
          view: settingsSubmodelView,
          toParentMessage: (message) => AppMessage.GotShell({ message }),
        }),
      )
  }
}

/** First-run onboarding takes over the whole window until done or skipped. */
const onboardingOverlay = (model: AppModel, h: HtmlBuilder<AppMessage>): Html | null =>
  model.onboarding.step === "done" || model.onboarding.skipped
    ? null
    : h.div([h.Class("app-onboarding-overlay")], [
        h.submodel({
          slotId: "app-onboarding",
          model: model.onboarding,
          view: onboardingSubmodelView,
          toParentMessage: (message) => AppMessage.GotOnboarding({ message }),
        }),
      ])

export const view = (model: AppModel, h: HtmlBuilder<AppMessage>): Document => {
  const overlay = onboardingOverlay(model, h)
  return {
    title: "AImy",
    body: h.div([h.Class("app")], [
      // Nav sidebar with collapse ◀ in its header. Floating ☰ reopens when closed.
      ...(model.navOpen ? [navView(model, h)] : []),
      ...(!model.navOpen
        ? [
            h.button(
              [
                h.Class("app-nav-fab"),
                h.Title("Open navigation"),
                h.OnClick(AppMessage.NavToggled({ open: true })),
              ],
              [icon.menu(h)]
            ),
          ]
        : []),
      h.main([h.Class("app-main")], [activePanelView(model, h)]),
      h.submodel({
        slotId: "app-devtools",
        model: model.devtools,
        view: devtoolsSubmodelView,
        toParentMessage: (message) => AppMessage.GotDevtools({ message }),
      }),
      ...(overlay === null ? [] : [overlay]),
    ]),
  }
}
