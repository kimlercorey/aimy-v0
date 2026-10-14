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
import { projectsPanelView } from "../chat/drawer.js"
import { composerView } from "../chat/view.js"
import { homeDashView } from "../homedash-view.js"
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
const projectsSubmodelView = defineView<ShellModel, ShellMessage>(
  (model, h) => projectsPanelView(h, model.session.drawer),
)
const homeDashSubmodelView = defineView<ShellModel, ShellMessage>(
  (model, h) => homeDashView(h, model.session),
)
// The Home panel's composer (2026-10-13): the same composer the
// chat panel renders under its message list, mounted under the
// dash stage — the dash is where work starts, and a home with
// no way to type strands the user (Kimler: "I no longer have a
// chat bar at the bottom"). Draft + send state live in the shell
// model, so the two mounts never disagree.
const homeComposerSubmodelView = defineView<ShellModel, ShellMessage>(
  (model, h) => composerView(h, model.session),
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
    // Wayfinding header (2026-10-13): the homedash door + the name of
    // where you are. The icon is a button home; the title is location,
    // never brand.
    h.div([h.Class("app-panel-header")], [
      h.button(
        [
          h.Class("app-home-btn"),
          h.Title("Home — the dash"),
          h.OnClick(AppMessage.SelectPanel({ panel: "home" })),
        ],
        [icon.home(h)],
      ),
      h.h2([h.Class("app-panel-title")], [title]),
    ]),
    body,
  ])

/**
 * Navigation (UI workplan Part 1A, 2026-10-12): the rail is the user's
 * mental model, not the platform's org chart. Three destinations —
 * Chat (home), Projects, Memory — then the platform machinery grouped
 * under one labelled door ("Platform"), demoted to secondary rows but
 * still one click away, and Settings in the footer. Every row carries
 * its Lucide icon + label (Part 1B: one icon per concept, rail size
 * class). Selection derives solely from model.activePanel — exactly
 * one row is ever active.
 */
interface NavEntry {
  readonly id: PanelId
  readonly label: string
  readonly icon: (h: HtmlBuilder<AppMessage>) => Html
}

const NAV_PRIMARY: ReadonlyArray<NavEntry> = [
  { id: "home", label: "Home", icon: icon.home },
  { id: "chat", label: "Chat", icon: icon.messageCircle },
  { id: "projects", label: "Projects", icon: icon.folder },
  { id: "memory", label: "Memory", icon: icon.bookOpen },
]

const NAV_PLATFORM: ReadonlyArray<NavEntry> = [
  { id: "presence", label: "Presence", icon: icon.user },
  { id: "jobs", label: "Jobs", icon: icon.briefcase },
  { id: "banners", label: "Banners", icon: icon.bell },
  { id: "messaging", label: "Messaging", icon: icon.mail },
  { id: "sovereignty", label: "Sovereignty", icon: icon.shield },
  { id: "permissions", label: "Permissions", icon: icon.lock },
  { id: "export", label: "Export", icon: icon.upload },
]

const navItem = (model: AppModel, h: HtmlBuilder<AppMessage>, entry: NavEntry, sub: boolean): Html =>
  h.button(
    [
      h.OnClick(AppMessage.SelectPanel({ panel: entry.id })),
      h.Class(
        `nav-item${sub ? " nav-sub" : ""}${entry.id === model.activePanel ? " nav-active" : ""}`,
      ),
      h.Title(entry.label),
    ],
    [entry.icon(h), h.span([h.Class("nav-label")], [entry.label])],
  )

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
    ...NAV_PRIMARY.map((item) => navItem(model, h, item, false)),
    h.div([h.Class("nav-group-label")], ["Platform"]),
    ...NAV_PLATFORM.map((item) => navItem(model, h, item, true)),
    // Settings at the bottom — the providers/personality panel.
    h.div([h.Class("app-nav-footer")], [
      navItem(model, h, { id: "settings", label: "Settings", icon: icon.settings }, false),
    ]),
  ])

const activePanelView = (model: AppModel, h: HtmlBuilder<AppMessage>): Html => {
  switch (model.activePanel) {
    case "home":
      return panel(
        h,
        "app-home",
        "Home",
        h.div([h.Class("app-home-stack")], [
          h.submodel({
            slotId: "app-home",
            model: model.shell,
            view: homeDashSubmodelView,
            toParentMessage: (message) => AppMessage.GotShell({ message }),
          }),
          h.submodel({
            slotId: "app-home-composer",
            model: model.shell,
            view: homeComposerSubmodelView,
            toParentMessage: (message) => AppMessage.GotShell({ message }),
          }),
        ]),
      )
    case "chat":
      return h.submodel({
        slotId: "app-shell",
        model: model.shell,
        view: shellSubmodelView,
        toParentMessage: (message) => AppMessage.GotShell({ message }),
      })
    case "projects":
      return panel(
        h,
        "app-projects",
        "Projects",
        h.submodel({
          slotId: "app-projects",
          model: model.shell,
          view: projectsSubmodelView,
          toParentMessage: (message) => AppMessage.GotShell({ message }),
        }),
      )
    case "memory":
      return panel(
        h,
        "app-timeline",
        "Memory",
        h.submodel({
          slotId: "app-timeline",
          model: model.timeline,
          view: timelineSubmodelView,
          toParentMessage: (message) => AppMessage.GotTimeline({ message }),
        }),
      )
    case "presence":
      return panel(
        h,
        "app-asc",
        "Presence",
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
        "Timeline",
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
        "Jobs",
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
        "Banners",
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
        "Sovereignty",
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
        "Messaging",
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
        "Permissions",
        permissionsView(model.shell.permissions, h as never),
      )
    case "export":
      return panel(
        h,
        "app-export",
        "Export",
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
        "Settings",
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
