/**
 * ui/src/ops/banners-view.ts — the banner-queue view.
 *
 * Pure function of the banners slice Model. Banners render priority-ordered
 * (critical first — the security rung — then broadcast > job > scheduler >
 * system), each with dismiss, snooze, and its audit facts (source, sequence,
 * dedupe count, dismissal state). The control bar holds mute-by-severity,
 * mute-by-source, and quiet-hours — all slice state, all revocable.
 */
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"

import {
  inQuietHours,
  Message,
  visibleBanners,
  type Model,
  type QuietHours,
  type UiBanner,
  type UiBannerSeverity,
} from "./banners-slice.js"

const SEVERITIES: ReadonlyArray<UiBannerSeverity> = ["info", "success", "warning", "critical"]

const SNOOZE_PRESETS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "8h", ms: 8 * 60 * 60 * 1000 },
]

const SOURCE_PREFIXES: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: "job:", label: "jobs" },
  { prefix: "scheduler", label: "scheduler" },
  { prefix: "system", label: "system" },
  { prefix: "asc-diagnostic", label: "asc diagnostics" },
  { prefix: "trusted-broadcast", label: "broadcasts" },
]

// Note: snoozed banners are filtered by `visibleBanners` before render,
// so this only ever sees banners that should be shown.
const viewBanner = (banner: UiBanner, nowMs: number, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Class(`banner banner-${banner.severity}`), h.Key(banner.id)],
    [
      h.div([h.Class("banner-head")], [
        h.span([h.Class("banner-severity")], [banner.severity]),
        h.span([h.Class("banner-source")], [banner.source]),
        h.span([h.Class("banner-title")], [banner.title]),
        ...(banner.count > 1 ? [h.span([h.Class("banner-count")], [`×${banner.count}`])] : []),
        h.time([], [banner.createdAt]),
      ]),
      h.p([h.Class("banner-body")], [banner.body]),
      h.div([h.Class("banner-meta")], [
        h.span([], [`seq ${banner.sequence}`]),
        ...(banner.dedupeKey !== undefined ? [h.span([], [`dedupe ${banner.dedupeKey}`])] : []),
        ...(banner.dismissedAt !== undefined
          ? [h.span([h.Class("banner-dismissed")], [`dismissed ${banner.dismissedAt}`])]
          : []),
        ...(banner.actions.length > 0
          ? [h.span([], [`actions: ${banner.actions.map((a) => a.label).join(", ")}`])]
          : []),
      ]),
      h.div([h.Class("banner-controls")], [
        banner.dismissedAt === undefined
          ? h.button([h.OnClick(Message.BannerDismissRequested({ id: banner.id }))], ["dismiss"])
          : null,
        ...SNOOZE_PRESETS.map((preset) =>
          h.button(
            [
              h.OnClick(
                Message.BannerSnoozed({ id: banner.id, untilMs: nowMs + preset.ms }),
              ),
              h.Title(`snooze for ${preset.label}`),
            ],
            [`snooze ${preset.label}`],
          ),
        ),
      ]),
    ],
  )

const viewMuteBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section([h.Class("banners-mutes")], [
    h.span([], ["mute severity: "]),
    ...SEVERITIES.map((severity) => {
      const muted = model.mutedSeverities.includes(severity)
      return h.button(
        [
          h.Class(muted ? "muted" : ""),
          h.OnClick(
            muted
              ? Message.BannerSeverityUnmuted({ severity })
              : Message.BannerSeverityMuted({ severity }),
          ),
        ],
        [`${muted ? "unmute" : "mute"} ${severity}`],
      )
    }),
    h.span([], ["mute source: "]),
    ...SOURCE_PREFIXES.map(({ prefix, label }) => {
      const muted = model.mutedSources.includes(prefix)
      return h.button(
        [
          h.Class(muted ? "muted" : ""),
          h.OnClick(
            muted
              ? Message.BannerSourceUnmuted({ source: prefix })
              : Message.BannerSourceMuted({ source: prefix }),
          ),
        ],
        [`${muted ? "unmute" : "mute"} ${label}`],
      )
    }),
  ])

const viewQuietHours = (model: Model, h: HtmlBuilder<Message>): Html => {
  const qh: QuietHours = model.quietHours
  return h.section([h.Class("banners-quiet")], [
    h.label([], [
      h.input([
        h.Checked(qh.enabled),
        h.OnChange(() =>
          Message.QuietHoursChanged({
            quietHours: { ...qh, enabled: !qh.enabled },
          }),
        ),
      ]),
      " quiet hours (suppresses everything below critical)",
    ]),
    h.label([], [
      "start ",
      h.input([
        h.Value(String(qh.startHour)),
        h.OnInput((v) => {
          const startHour = Number.parseInt(v, 10)
          return Message.QuietHoursChanged({
            quietHours: {
              ...qh,
              startHour: Number.isNaN(startHour) ? qh.startHour : startHour,
            },
          })
        }),
      ]),
    ]),
    h.label([], [
      "end ",
      h.input([
        h.Value(String(qh.endHour)),
        h.OnInput((v) => {
          const endHour = Number.parseInt(v, 10)
          return Message.QuietHoursChanged({
            quietHours: { ...qh, endHour: Number.isNaN(endHour) ? qh.endHour : endHour },
          })
        }),
      ]),
    ]),
    inQuietHours(qh, Date.now())
      ? h.span([h.Class("quiet-active")], ["quiet hours active"])
      : null,
  ])
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const nowMs = Date.now()
  const visible = visibleBanners(model, nowMs)
  return h.section([h.Class("banners-panel")], [
    h.h2([], ["banners"]),
    h.p([h.Class("banners-sub")], [
      "priority-ordered: critical (security) first, then broadcast > job > scheduler > system. Dismissal is audit-trailed in the service — never deleted.",
    ]),
    model.status === "loading" ? h.p([], ["loading banners…"]) : null,
    model.status === "error"
      ? h.p([h.Class("error")], [`banners failed to load: ${model.lastError ?? "unknown"}`])
      : null,
    model.lastError !== undefined && model.status !== "error"
      ? h.p([h.Class("error")], [`last operation failed: ${model.lastError}`])
      : null,
    h.p([], [
      h.button([h.OnClick(Message.BannersRefreshRequested())], ["refresh"]),
      h.label([], [
        h.input([
          h.Checked(model.showDismissed),
          h.OnChange(() => Message.ShowDismissedToggled()),
        ]),
        " show dismissed (audit trail)",
      ]),
    ]),
    viewMuteBar(model, h),
    viewQuietHours(model, h),
    visible.length > 0
      ? h.ul(
          [h.Class("banners-list")],
          visible.map((banner) => viewBanner(banner, nowMs, h)),
        )
      : h.p([], ["no banners — the queue is quiet."]),
  ])
}

/** Submodel view for foldChild composition by the shell (Track 1). */
export const bannersSubmodelView = defineView<Model, Message>((model, h) => view(model, h))
