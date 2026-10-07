/**
 * comms/types.ts — CommsBanner channel data types (M7, Track 3).
 *
 * Ground truth: architecture.md §1.1 row 11 (CommsBanner: the in-app channel
 * for system→user alerts — job done, cron status; product-owner trusted
 * broadcast REUSES this channel later under its own opt-in/audit terms) and
 * §12 M7 spec; mvp-moscow.md MUST 15 + the "trusted broadcast" Should item
 * (the channel must support a `source` field distinguishing system/job/
 * scheduler origins from a future trusted-broadcast origin, with different
 * audit requirements).
 *
 * This module is DATA ONLY — no UI, no rendering, no network. The M8 Foldkit
 * UI consumes `listBanners()` / `subscribe()` / `dismiss()` / `bannerLog()`.
 * The channel is LOCAL ONLY (architecture §1.3: local-only out of the box;
 * the trusted broadcast TRANSPORT is later work — this is the channel it
 * will reuse).
 */

/** Banner severity. Routing rules live in service.ts; the ordering here is display priority. */
export type BannerSeverity = "info" | "success" | "warning" | "critical"

/**
 * Banner origin. `job:<jobId>` tags banners emitted by the JobRunner (M7
 * track 2); `scheduler` is the cron-schedule source; `asc-diagnostic` is
 * the ASC engine's monthly diagnostic cadence (architecture §12 M5
 * extension point); `trusted-broadcast` is the RESERVED future origin for
 * product-owner broadcast (MoSCoW Should) — it cannot be published without
 * a {@link TrustedBroadcastCapability} (see capability.ts).
 */
export type BannerSource = "system" | `job:${string}` | "scheduler" | "asc-diagnostic" | "trusted-broadcast"

/** A typed UI action the M8 Foldkit shell will handle (e.g. "view-job", "open-timeline"). Data only. */
export interface BannerAction {
  readonly id: string
  readonly label: string
}

/**
 * A banner (event-channel record). Immutable once published; `count` grows
 * through dedupe; `dismissedAt` records dismissal (never deletion — audit
 * trail). `sequence` is the global causal order: strictly increasing per
 * publish across all sources, resumed from the log after restarts.
 */
export interface Banner {
  /** Deterministic id: sha256 over (source, severity, dedupeKey-or-title, body, sequence). */
  readonly id: string
  readonly severity: BannerSeverity
  readonly source: BannerSource
  readonly title: string
  readonly body: string
  readonly createdAt: string // ISO-8601 UTC
  readonly expiresAt?: string // ISO-8601 UTC; never set for critical banners
  readonly actions: ReadonlyArray<BannerAction>
  readonly dedupeKey?: string
  /** How many identical occurrences collapsed into this banner (dedupe). Starts at 1. */
  readonly count: number
  /** Set by dismiss(); the record is RETAINED, not deleted (audit trail). */
  readonly dismissedAt?: string // ISO-8601 UTC
  /** Global causal order. */
  readonly sequence: number
}

/** Input to `publish`. `expiresAt` is derived from `ttlMs`, never supplied. */
export interface NewBanner {
  readonly severity: BannerSeverity
  readonly source: BannerSource
  readonly title: string
  readonly body: string
  readonly actions?: ReadonlyArray<BannerAction>
  /**
   * Dedupe key: same key + same source within the dedupe TTL collapses into
   * ONE banner with an incremented `count`. Ignored for critical banners
   * (critical is never deduped away).
   */
  readonly dedupeKey?: string
  /** Auto-expiry TTL in ms; overrides the severity default. Ignored for critical. */
  readonly ttlMs?: number
}

/** Events emitted on the in-process hub. */
export type BannerEvent =
  | { readonly type: "published"; readonly banner: Banner }
  | { readonly type: "deduped"; readonly banner: Banner }
  | { readonly type: "dismissed"; readonly banner: Banner }
  | { readonly type: "expired"; readonly banner: Banner }

/**
 * Append-only log record (audit trail). `kind` distinguishes lifecycle
 * transitions; `banner` is a deep-frozen snapshot at that transition.
 * `dedupeTtlMs` is recorded on publish so dedupe survives restarts.
 */
export interface BannerLogRecord {
  readonly v: 1
  readonly seq: number
  readonly at: string // ISO-8601 UTC
  readonly kind: "published" | "dedupe-hit" | "dismissed" | "expired"
  readonly banner: Banner
  readonly dedupeTtlMs?: number
}

/** Filters for `listBanners()`. Defaults: active banners only (not dismissed, not expired). */
export interface BannerFilter {
  readonly includeDismissed?: boolean
  readonly includeExpired?: boolean
  readonly source?: BannerSource
  readonly severity?: BannerSeverity
}
