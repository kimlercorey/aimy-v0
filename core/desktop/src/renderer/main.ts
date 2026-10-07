/**
 * desktop/src/renderer/main.ts — the desktop renderer's entry point.
 *
 * Mounts the M8 composed app (`ui/src/composed` — the real shell + every
 * panel slice, imported, not forked) via foldkit's interactive browser
 * runtime, with the IPC-backed interpreter (`./resources.ts`) provided at
 * the boundary and the bridge-backed subscriptions (`./subscriptions.ts`)
 * pumping chat tokens and main→renderer events into the message flow.
 *
 * Fail-loud boot: a missing #root container or a missing preload bridge
 * renders an error into the page instead of a silent blank window.
 */
import { Runtime } from "foldkit"

import {
  AppModel,
  appUpdate,
  appView,
  initialAppModel,
  type AppMessage,
  type AppModel as AppModelType,
  type AppServices
} from "../../../ui/src/composed/index.js"

import { getAimy } from "./ipc.js"
import { ipcResources } from "./resources.js"
import { subscriptions } from "./subscriptions.js"

const escapeHtml = (raw: string): string =>
  raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const bootError = (message: string): void => {
  document.body.innerHTML =
    `<main class="boot-error"><h1>AImy failed to start</h1><p>${escapeHtml(message)}</p></main>`
}

const boot = (): void => {
  const container = document.getElementById("root")
  if (container === null) {
    bootError("missing #root container in index.html")
    return
  }
  try {
    // Fail fast when the preload bridge is absent — the subscriptions and
    // the command interpreter both need it, and a half-connected renderer
    // would lie about every panel.
    getAimy()
  } catch (error) {
    bootError(error instanceof Error ? error.message : String(error))
    return
  }

  const app = Runtime.makeApplication<AppModelType, AppMessage, AppServices>({
    Model: AppModel,
    init: () => ({ model: initialAppModel() }),
    update: appUpdate,
    view: appView,
    subscriptions,
    container,
    resources: ipcResources
  })
  Runtime.run(app)
}

try {
  boot()
} catch (error) {
  bootError(error instanceof Error ? error.message : String(error))
}
