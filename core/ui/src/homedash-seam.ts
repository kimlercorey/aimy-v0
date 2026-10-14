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

/** One world event carried by the GlobeNews widget (2026-10-13). */
export interface HomedashNewsEvent {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly source: string
  readonly url: string
  readonly atMs: number
  readonly lat?: number | undefined
  readonly lon?: number | undefined
  readonly place?: string | undefined
  readonly read: boolean
}

export interface HomedashWidget {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  /** Screen depth on the dash stage, 1–1000. Higher is on top. */
  readonly priority: number
  readonly settings: ReadonlyArray<HomedashSetting>
  /** GlobeNews + its feed component: current world events. */
  readonly news?: ReadonlyArray<HomedashNewsEvent> | undefined
  /** When the events were last scanned, epoch ms. */
  readonly newsUpdatedAt?: number | undefined
  /** Voice alerts currently repeating (Threat Channel §8). */
  readonly voiceAlerts?: ReadonlyArray<HomedashVoiceAlert> | undefined
}

/** One active voice alert: a threat inside the risk circle, announced until silenced. */
export interface HomedashVoiceAlert {
  readonly id: string
  readonly title: string
  readonly severity: "warning" | "critical"
}

export interface HomedashData {
  readonly widgets: ReadonlyArray<HomedashWidget>
}

/** A fetched news article as markdown, for the drawer (2026-10-13). */
export interface NewsArticle {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly url: string
}

export interface HomedashIpcShape {
  /** Load enabled widgets with manifests + effective settings. */
  readonly getHomedash: () => Promise<HomedashData>
  /** Persist one setting value for one widget. */
  readonly setSetting: (widgetId: string, key: string, value: string | number | boolean) => Promise<void>
  /** Mark one GlobeNews event read (its dot gains the cyan ring). */
  readonly markNewsRead: (id: string) => Promise<void>
  /** Fetch (or recall) one event's article as markdown for the drawer. */
  readonly getNewsArticle: (id: string) => Promise<NewsArticle>
  /** Run the world-news scan now (the feed's "last updated" click). */
  readonly refreshNews: () => Promise<void>
  /** Silence one repeating voice alert; returns the alerts still active. */
  readonly dismissVoiceAlert: (id: string) => Promise<ReadonlyArray<HomedashVoiceAlert>>
}

export class HomedashIpc extends Context.Service<HomedashIpc, HomedashIpcShape>()(
  "aimy/ui/HomedashIpc"
) {}
