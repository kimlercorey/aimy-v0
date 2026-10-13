/**
 * The HomeDash seam (2026-10-13): enabled widgets, their manifests,
 * and their effective settings — the same shape as the IPC payload,
 * re-declared so the UI never imports the desktop protocol.
 *
 * A widget declares its settings in its manifest (available/
 * <id>/widget.json); the platform transposes them into Settings and
 * persists values in ~/.aimy/homedash/settings.json. The reserved
 * key "priority" (1–1000) is the widget's screen depth on the dash.
 */
import { Context } from "effect"

export interface HomedashSetting {
  readonly key: string
  /** "slider" | "toggle" | "select" | "number" — the control to render. */
  readonly type: string
  readonly label: string
  readonly value: string | number | boolean
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly step?: number | undefined
  readonly options?: ReadonlyArray<string> | undefined
}

export interface HomedashWidget {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  /** Screen depth on the dash stage, 1–1000. Higher is on top. */
  readonly priority: number
  readonly settings: ReadonlyArray<HomedashSetting>
}

export interface HomedashData {
  readonly widgets: ReadonlyArray<HomedashWidget>
}

export interface HomedashIpcShape {
  /** Load enabled widgets with manifests + effective settings. */
  readonly getHomedash: () => Promise<HomedashData>
  /** Persist one setting value for one widget. */
  readonly setSetting: (widgetId: string, key: string, value: string | number | boolean) => Promise<void>
}

export class HomedashIpc extends Context.Service<HomedashIpc, HomedashIpcShape>()(
  "aimy/ui/HomedashIpc"
) {}
