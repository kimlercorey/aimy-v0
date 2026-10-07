/**
 * ui/src/ops/banners-slice.ts — the banner-queue slice: Schema Model,
 * Messages, pure update, and foldkit Commands against the real `CommsBanner`.
 *
 * Architecture §3.5: the banner queue is a priority queue —
 * info < job < cron < security < broadcast. The service (`CommsBanner`)
 * owns banners, dedupe, dismissal, and the audit log. The UI owns the
 * MUST controls: dismiss (→ service.dismiss), snooze, mute-by-category, and
 * quiet hours — these live in this slice's Model, applied as pure view
 * filters over the service's banner list.
 *
 * Severity/source mapping to §3.5's priority ladder: the service's severities
 * are info|success|warning|critical and its sources are system|job:*|
 * scheduler|asc-diagnostic|trusted-broadcast. Critical is the security rung
 * (never deduped, never auto-expires); broadcast is the top source rung.
 * Quiet hours suppress everything below critical.
 */
import { Effect, Schema } from "effect"
import { define as defineCommand } from "foldkit/command"
import { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"

import { CommsBanner } from "../../../comms/service.js"

// ─── Model ───────────────────────────────────────────────────────────────────

export const BannerSeveritySchema = Schema.Literals(["info", "success", "warning", "critical"])

/** Known banner sources; `job:<jobId>` sources are free-form strings. */
export const BannerSourceSchema = Schema.Literals([
  "system",
  "scheduler",
  "asc-diagnostic",
  "trusted-broadcast",
])

export const BannerActionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
})

export const BannerSchema = Schema.Struct({
  id: Schema.String,
  severity: BannerSeveritySchema,
  source: Schema.String,
  title: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.optional(Schema.String),
  actions: Schema.Array(BannerActionSchema),
  dedupeKey: Schema.optional(Schema.String),
  count: Schema.Number,
  dismissedAt: Schema.optional(Schema.String),
  sequence: Schema.Number,
})
export type UiBanner = typeof BannerSchema.Type
export type UiBannerSeverity = typeof BannerSeveritySchema.Type

export const QuietHoursSchema = Schema.Struct({
  enabled: Schema.Boolean,
  /** Local hour (0-23) quiet hours start. */
  startHour: Schema.Number,
  /** Local hour (0-23) quiet hours end. */
  endHour: Schema.Number,
})
export type QuietHours = typeof QuietHoursSchema.Type

export const BannersStatusSchema = Schema.Literals(["loading", "ready", "error"])

export const Model = Schema.Struct({
  /** Snapshot of `CommsBanner.listBanners()`. */
  banners: Schema.Array(BannerSchema),
  /** Snoozed banners: banner id → epoch ms the snooze lifts. */
  snoozedUntil: Schema.Record(Schema.String, Schema.Number),
  /** Muted severities (e.g. ["info"]). */
  mutedSeverities: Schema.Array(BannerSeveritySchema),
  /** Muted source prefixes (e.g. ["job:"], ["scheduler"]). */
  mutedSources: Schema.Array(Schema.String),
  quietHours: QuietHoursSchema,
  showDismissed: Schema.Boolean,
  status: BannersStatusSchema,
  lastError: Schema.optional(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  banners: [],
  snoozedUntil: {},
  mutedSeverities: [],
  mutedSources: [],
  quietHours: { enabled: false, startHour: 22, endHour: 7 },
  showDismissed: false,
  status: "loading",
  lastError: undefined,
}

// ─── Messages ────────────────────────────────────────────────────────────────

export const Message = defineMessageUnion({
  BannersRefreshRequested: {},
  BannersRefreshed: {
    banners: Schema.Array(BannerSchema),
  },
  BannersRefreshFailed: { reason: Schema.String },
  BannerDismissRequested: { id: Schema.String },
  BannerDismissed: { banner: BannerSchema },
  BannerSnoozed: { id: Schema.String, untilMs: Schema.Number },
  BannerUnsnoozed: { id: Schema.String },
  BannerSeverityMuted: { severity: BannerSeveritySchema },
  BannerSeverityUnmuted: { severity: BannerSeveritySchema },
  BannerSourceMuted: { source: Schema.String },
  BannerSourceUnmuted: { source: Schema.String },
  QuietHoursChanged: { quietHours: QuietHoursSchema },
  ShowDismissedToggled: {},
  BannerOperationFailed: {
    id: Schema.String,
    action: Schema.String,
    reason: Schema.String,
  },
})
export type Message = typeof Message.Type

// ─── Commands ────────────────────────────────────────────────────────────────

const decodeBanners = Schema.decodeUnknownEffect(Schema.Array(BannerSchema))

/** Read the queue from the real service. */
export const RefreshBanners = defineCommand("banners/refresh", {
  args: { includeDismissed: Schema.Boolean },
  messages: [Message.BannersRefreshed, Message.BannersRefreshFailed],
  execute: ({ includeDismissed }) =>
    Effect.gen(function* () {
      const comms = yield* CommsBanner
      const banners = yield* comms.listBanners({ includeDismissed })
      return Message.BannersRefreshed({ banners: yield* decodeBanners(banners) })
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.BannersRefreshFailed({ reason: String(cause) })),
      ),
    ),
})

/** Dismiss: recorded in the service's audit trail, never deleted. */
export const DismissBanner = defineCommand("banners/dismiss", {
  args: { id: Schema.String },
  messages: [Message.BannerDismissed, Message.BannerOperationFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const comms = yield* CommsBanner
      const banner = yield* comms.dismiss(id)
      return Message.BannerDismissed({ banner: yield* decodeBanners([banner]).pipe(Effect.map((bs) => bs[0] as UiBanner)) })
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.BannerOperationFailed({ id, action: "dismiss", reason: String(cause) })),
      ),
    ),
})

// ─── Update ──────────────────────────────────────────────────────────────────

/** Services the slice's Commands need; the shell provides them as `resources`. */
export type BannersResources = CommsBanner

export type BannersUpdateReturn = Update.Return<Model, Message, BannersResources>

const refreshAfterDismiss = (model: Model): BannersUpdateReturn => ({
  model,
  commands: [RefreshBanners({ includeDismissed: model.showDismissed })],
})

export const update = (model: Model, message: Message): BannersUpdateReturn =>
  Message.match<BannersUpdateReturn>(message, {
    BannersRefreshRequested: () => ({
      model: modifyFields(model, {
        status: () => "loading" as const,
        lastError: () => undefined,
      }),
      commands: [RefreshBanners({ includeDismissed: model.showDismissed })],
    }),
    BannersRefreshed: ({ banners }) => ({
      model: modifyFields(model, {
        banners: () => banners,
        status: () => "ready" as const,
        lastError: () => undefined,
      }),
    }),
    BannersRefreshFailed: ({ reason }) => ({
      model: modifyFields(model, {
        status: () => "error" as const,
        lastError: () => reason,
      }),
    }),
    BannerDismissRequested: ({ id }) => ({
      model,
      commands: [DismissBanner({ id })],
    }),
    BannerDismissed: () => refreshAfterDismiss(model),
    BannerSnoozed: ({ id, untilMs }) => ({
      model: modifyFields(model, {
        snoozedUntil: (s) => ({ ...s, [id]: untilMs }),
      }),
    }),
    BannerUnsnoozed: ({ id }) => ({
      model: modifyFields(model, {
        snoozedUntil: (s) => {
          const next = { ...s }
          delete next[id]
          return next
        },
      }),
    }),
    BannerSeverityMuted: ({ severity }) => ({
      model: modifyFields(model, {
        mutedSeverities: (ms) => (ms.includes(severity) ? ms : [...ms, severity]),
      }),
    }),
    BannerSeverityUnmuted: ({ severity }) => ({
      model: modifyFields(model, {
        mutedSeverities: (ms) => ms.filter((m) => m !== severity),
      }),
    }),
    BannerSourceMuted: ({ source }) => ({
      model: modifyFields(model, {
        mutedSources: (ms) => (ms.includes(source) ? ms : [...ms, source]),
      }),
    }),
    BannerSourceUnmuted: ({ source }) => ({
      model: modifyFields(model, {
        mutedSources: (ms) => ms.filter((m) => m !== source),
      }),
    }),
    QuietHoursChanged: ({ quietHours }) => ({
      model: modifyFields(model, { quietHours: () => quietHours }),
    }),
    ShowDismissedToggled: () => {
      const next = modifyFields(model, { showDismissed: (v) => !v })
      return {
        model: next,
        commands: [RefreshBanners({ includeDismissed: next.showDismissed })],
      }
    },
    BannerOperationFailed: ({ reason }) => ({
      model: modifyFields(model, { lastError: () => reason }),
    }),
  })

// ─── Priority + visibility (pure) ────────────────────────────────────────────

/** Source rung on the §3.5 ladder: info < job < cron < security < broadcast. */
const sourceRank = (source: string): number => {
  if (source === "trusted-broadcast") return 4
  if (source.startsWith("job:")) return 3
  if (source === "scheduler") return 2
  if (source === "asc-diagnostic") return 1
  return 0
}

const severityRank = (severity: UiBannerSeverity): number => {
  switch (severity) {
    case "critical":
      return 3
    case "warning":
      return 2
    case "success":
      return 1
    case "info":
      return 0
  }
}

/**
 * Priority-ordered: critical first (the security rung), then source rank,
 * then severity rank, then newest sequence first.
 */
export const priorityOrdered = (banners: ReadonlyArray<UiBanner>): ReadonlyArray<UiBanner> =>
  [...banners].sort((a, b) => {
    const crit = (b.severity === "critical" ? 1 : 0) - (a.severity === "critical" ? 1 : 0)
    if (crit !== 0) return crit
    const src = sourceRank(b.source) - sourceRank(a.source)
    if (src !== 0) return src
    const sev = severityRank(b.severity) - severityRank(a.severity)
    if (sev !== 0) return sev
    return b.sequence - a.sequence
  })

/** True when `nowMs` (epoch ms) falls inside the quiet-hours window (local time). */
export const inQuietHours = (quietHours: QuietHours, nowMs: number): boolean => {
  if (!quietHours.enabled) return false
  const hour = new Date(nowMs).getHours()
  const { startHour, endHour } = quietHours
  return startHour <= endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour
}

const sourceMuted = (banner: UiBanner, mutedSources: ReadonlyArray<string>): boolean =>
  mutedSources.some(
    (prefix) => banner.source === prefix || banner.source.startsWith(prefix),
  )

/**
 * The visible queue: service banners → priority order → UI controls applied
 * (snooze, mute-by-severity, mute-by-source, quiet hours). Dismissal is owned
 * by the service (the snapshot already excludes dismissed unless requested).
 */
export const visibleBanners = (model: Model, nowMs: number): ReadonlyArray<UiBanner> => {
  const quiet = inQuietHours(model.quietHours, nowMs)
  return priorityOrdered(model.banners).filter((banner) => {
    const snoozedUntil = model.snoozedUntil[banner.id]
    if (snoozedUntil !== undefined && nowMs < snoozedUntil) return false
    if (model.mutedSeverities.includes(banner.severity)) return false
    if (sourceMuted(banner, model.mutedSources)) return false
    if (quiet && banner.severity !== "critical") return false
    return true
  })
}
