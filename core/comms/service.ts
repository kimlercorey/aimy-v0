/**
 * comms/service.ts — CommsBanner, the in-app system→user alert channel.
 *
 * Ground truth: architecture.md §1.1 row 11 + §12 M7; mvp-moscow.md MUST 15.
 *
 * Semantics (all structural, tested in test/comms.test.ts):
 *
 * - ORDERING: every publish assigns a strictly increasing global sequence
 *   number (resumed from the log after restarts) — the global causal order.
 *   The hub (an Effect `PubSub`) emits events in publish order, so
 *   per-source FIFO and global order coincide for subscribers.
 * - DEDUPE: same `dedupeKey` + same `source` within the dedupe TTL collapses
 *   into ONE banner with an incremented `count` — never a flood. Dedupe
 *   state is recorded in the log (`dedupe-hit` records), so it survives
 *   restarts.
 * - SEVERITY ROUTING: critical banners are NEVER deduped and NEVER
 *   auto-expire; info/success/warning banners expire by TTL (severity
 *   default, overridable per publish via `ttlMs`).
 * - DISMISSAL: `dismiss()` records `dismissedAt` on the banner and appends a
 *   `dismissed` log record. The banner is never deleted — the log is the
 *   audit trail. Dismiss is idempotent.
 * - TRUSTED BROADCAST: `source: "trusted-broadcast"` requires a genuine
 *   `TrustedBroadcastCapability` (see capability.ts). Missing →
 *   `TrustedBroadcastCapabilityMissing`; fabricated →
 *   `TrustedBroadcastCapabilityInvalid`. The local system cannot mint one.
 *
 * Time is Effect's `Clock` (`DateTime.now`), so tests drive expiry/dedupe
 * deterministically with `TestClock.adjust`. Production uses the live clock.
 *
 * LOCAL ONLY: no network anywhere in this module. The trusted-broadcast
 * TRANSPORT is later work (architecture §12 post-MVP #5); this is the
 * channel it will reuse.
 */
import { sha256Hex as sha256HexStr } from "../substrate/hash.js"
import { Context, DateTime, Effect, Layer, PubSub, Stream, type Scope } from "effect"

import type { AimyPaths } from "../substrate/config.js"
import { isTrustedBroadcastCapability, type TrustedBroadcastCapability } from "./capability.js"
import {
  BannerLogError,
  BannerNotFound,
  BannerValidationError,
  type CommsError,
  TrustedBroadcastCapabilityInvalid,
  TrustedBroadcastCapabilityMissing,
} from "./errors.js"
import type { BannerLogStoreShape } from "./store.js"
import { FileBannerLogStore, InMemoryBannerLogStore } from "./store.js"
import type {
  Banner,
  BannerEvent,
  BannerFilter,
  BannerLogRecord,
  BannerSeverity,
  NewBanner,
} from "./types.js"

/** Default auto-expiry TTL per severity. Critical has no TTL — it never auto-expires. */
export const DEFAULT_TTL_MS: Record<Exclude<BannerSeverity, "critical">, number> = {
  info: 24 * 60 * 60 * 1000,
  success: 24 * 60 * 60 * 1000,
  warning: 7 * 24 * 60 * 60 * 1000,
}

/** Default dedupe window: same dedupeKey + source collapses within 10 minutes. */
export const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000

/** The CommsBanner service interface — rendering-neutral data API for the M8 UI. */
export interface CommsBannerShape {
  /**
   * Publish a banner. Applies the trusted-broadcast capability gate, dedupe,
   * and severity routing. Emits a `published` (or `deduped`) event on the hub
   * and appends to the persistent log.
   */
  readonly publish: (
    input: NewBanner,
    capability?: TrustedBroadcastCapability,
  ) => Effect.Effect<Banner, CommsError>
  /**
   * Subscribe to banner events (published/deduped/dismissed/expired), in
   * global sequence order. The subscription is EAGER: it is live the moment
   * this Effect runs, so no event published after it can be missed. The
   * subscription's lifetime is the enclosing `Scope` (unsubscribe on scope
   * close).
   */
  readonly subscribe: () => Effect.Effect<Stream.Stream<BannerEvent>, never, Scope.Scope>
  /** Active banners by default; filters opt into dismissed/expired/source/severity. Sorted by sequence. */
  readonly listBanners: (filter?: BannerFilter) => Effect.Effect<ReadonlyArray<Banner>, CommsError>
  /** Record a dismissal (audit trail — the banner is retained, never deleted). Idempotent. */
  readonly dismiss: (id: string) => Effect.Effect<Banner, CommsError>
  /** The full append-only audit log, in append order. */
  readonly bannerLog: () => Effect.Effect<ReadonlyArray<BannerLogRecord>, CommsError>
}

export class CommsBanner extends Context.Service<CommsBanner, CommsBannerShape>()(
  "aimy/comms/CommsBanner",
) {}

/** Internal per-banner state (not all of it is public on `Banner`). */
interface BannerEntry {
  readonly banner: Banner
  readonly createdAtMs: number
  /** Dedupe window for this banner (default or per-publish override). Undefined for critical. */
  readonly dedupeTtlMs: number | undefined
}

interface BannerState {
  readonly byId: Map<string, BannerEntry>
  /** `${source}\n${dedupeKey}` → banner id, for the currently active (non-dismissed) dedupe target. */
  readonly dedupeIndex: Map<string, string>
  seq: number
}

const dedupeIndexKey = (source: string, dedupeKey: string): string => `${source}\n${dedupeKey}`

const sha256Hex = (parts: ReadonlyArray<string>): string =>
  sha256HexStr(parts.join("\n"))

/** Deterministic banner id: content hash + sequence (so identical re-publishes without dedupe stay distinct). */
const bannerId = (input: NewBanner, seq: number): string =>
  `banner-${sha256Hex([input.source, input.severity, input.dedupeKey ?? input.title, input.body, String(seq)]).slice(0, 16)}`

const parseIsoMs = (iso: string, what: string): Effect.Effect<number, BannerLogError> => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms)
    ? Effect.fail(new BannerLogError({ reason: `banner log has invalid timestamp (${what}): ${iso}` }))
    : Effect.succeed(ms)
}

const makeService = (store: BannerLogStoreShape): Effect.Effect<CommsBannerShape, BannerLogError> =>
  Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<BannerEvent>()

    // -- Replay the persistent log: rebuild in-memory state ----------------
    const now0 = yield* DateTime.now
    const now0Ms = DateTime.toEpochMillis(now0)
    const state: BannerState = { byId: new Map(), dedupeIndex: new Map(), seq: 0 }
    const records = yield* store.readAll()
    for (const record of records) {
      if (record.seq > state.seq) state.seq = record.seq
      const createdAtMs = yield* parseIsoMs(record.banner.createdAt, "createdAt")
      switch (record.kind) {
        case "published": {
          const dedupeTtlMs =
            record.banner.severity === "critical" ? undefined : (record.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS)
          state.byId.set(record.banner.id, { banner: record.banner, createdAtMs, dedupeTtlMs })
          const key = record.banner.dedupeKey
          if (
            key !== undefined &&
            record.banner.severity !== "critical" &&
            record.banner.dismissedAt === undefined &&
            dedupeTtlMs !== undefined &&
            now0Ms - createdAtMs < dedupeTtlMs
          ) {
            state.dedupeIndex.set(dedupeIndexKey(record.banner.source, key), record.banner.id)
          }
          break
        }
        case "dedupe-hit": {
          state.byId.set(record.banner.id, {
            banner: record.banner,
            createdAtMs,
            dedupeTtlMs: record.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS,
          })
          break
        }
        case "dismissed": {
          const entry = state.byId.get(record.banner.id)
          if (entry !== undefined) {
            state.byId.set(record.banner.id, { ...entry, banner: record.banner })
          }
          const key = record.banner.dedupeKey
          if (key !== undefined) state.dedupeIndex.delete(dedupeIndexKey(record.banner.source, key))
          break
        }
        case "expired": {
          state.byId.delete(record.banner.id)
          const key = record.banner.dedupeKey
          if (key !== undefined) state.dedupeIndex.delete(dedupeIndexKey(record.banner.source, key))
          break
        }
      }
    }

    const emit = (event: BannerEvent): Effect.Effect<void> =>
      PubSub.publish(hub, event).pipe(Effect.asVoid)

    const appendRecord = (
      kind: BannerLogRecord["kind"],
      banner: Banner,
      at: string,
      seq: number,
      dedupeTtlMs?: number,
    ): Effect.Effect<void, BannerLogError> =>
      store.append(
        dedupeTtlMs === undefined
          ? { v: 1, seq, at, kind, banner }
          : { v: 1, seq, at, kind, banner, dedupeTtlMs },
      )

    /** Lazily expire due banners: append audit records, emit events, drop from active state. */
    const expireDue = (nowMs: number): Effect.Effect<void, BannerLogError> =>
      Effect.gen(function* () {
        const iso = new Date(nowMs).toISOString()
        for (const [id, entry] of state.byId) {
          const expiresAt = entry.banner.expiresAt
          if (
            expiresAt !== undefined &&
            entry.banner.dismissedAt === undefined &&
            Date.parse(expiresAt) <= nowMs
          ) {
            state.byId.delete(id)
            const key = entry.banner.dedupeKey
            if (key !== undefined) state.dedupeIndex.delete(dedupeIndexKey(entry.banner.source, key))
            yield* appendRecord("expired", entry.banner, iso, entry.banner.sequence)
            yield* emit({ type: "expired", banner: entry.banner })
          }
        }
      })

    const publish: CommsBannerShape["publish"] = (input, capability) =>
      Effect.gen(function* () {
        // Capability gate FIRST: a trusted-broadcast attempt without a
        // genuine capability is the security-relevant signal.
        if (input.source === "trusted-broadcast") {
          if (capability === undefined) {
            return yield* Effect.fail(
              new TrustedBroadcastCapabilityMissing({
                reason: 'publishing source "trusted-broadcast" requires a TrustedBroadcastCapability',
              }),
            )
          }
          if (!isTrustedBroadcastCapability(capability)) {
            return yield* Effect.fail(
              new TrustedBroadcastCapabilityInvalid({
                reason: "value is not a genuine TrustedBroadcastCapability (possible forgery)",
              }),
            )
          }
        }
        if (input.title.trim() === "") {
          return yield* Effect.fail(new BannerValidationError({ reason: "banner title must not be empty" }))
        }
        if (input.ttlMs !== undefined && !(input.ttlMs > 0)) {
          return yield* Effect.fail(new BannerValidationError({ reason: "ttlMs must be positive" }))
        }

        const now = yield* DateTime.now
        const nowMs = DateTime.toEpochMillis(now)
        const iso = DateTime.formatIso(now)
        yield* expireDue(nowMs)

        const isCritical = input.severity === "critical"
        const dedupeTtlMs = isCritical ? undefined : (input.dedupeKey !== undefined ? DEFAULT_DEDUPE_TTL_MS : undefined)

        // Dedupe: same key + source, still inside the window, not dismissed → collapse.
        if (!isCritical && input.dedupeKey !== undefined) {
          const targetId = state.dedupeIndex.get(dedupeIndexKey(input.source, input.dedupeKey))
          const target = targetId !== undefined ? state.byId.get(targetId) : undefined
          if (
            target !== undefined &&
            target.banner.dismissedAt === undefined &&
            target.dedupeTtlMs !== undefined &&
            nowMs - target.createdAtMs < target.dedupeTtlMs
          ) {
            const collapsed: Banner = { ...target.banner, count: target.banner.count + 1 }
            Object.freeze(collapsed)
            state.byId.set(target.banner.id, { ...target, banner: collapsed })
            yield* appendRecord("dedupe-hit", collapsed, iso, collapsed.sequence, target.dedupeTtlMs)
            yield* emit({ type: "deduped", banner: collapsed })
            return collapsed
          }
          // Stale index entry (window passed while idle): drop it so the new banner takes over.
          if (targetId !== undefined) state.dedupeIndex.delete(dedupeIndexKey(input.source, input.dedupeKey))
        }

        const seq = state.seq + 1
        state.seq = seq
        const expiresAt = isCritical
          ? undefined
          : new Date(nowMs + (input.ttlMs ?? DEFAULT_TTL_MS[input.severity])).toISOString()
        const banner: Banner = {
          id: bannerId(input, seq),
          severity: input.severity,
          source: input.source,
          title: input.title,
          body: input.body,
          createdAt: iso,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          actions: input.actions ?? [],
          ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
          count: 1,
          sequence: seq,
        }
        Object.freeze(banner)
        state.byId.set(banner.id, { banner, createdAtMs: nowMs, dedupeTtlMs })
        if (!isCritical && input.dedupeKey !== undefined) {
          state.dedupeIndex.set(dedupeIndexKey(input.source, input.dedupeKey), banner.id)
        }
        yield* appendRecord("published", banner, iso, seq, dedupeTtlMs)
        yield* emit({ type: "published", banner })
        return banner
      })

    const listBanners: CommsBannerShape["listBanners"] = (filter = {}) =>
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        yield* expireDue(nowMs)
        const out: Array<Banner> = []
        for (const { banner } of state.byId.values()) {
          if (!filter.includeDismissed && banner.dismissedAt !== undefined) continue
          if (!filter.includeExpired && banner.expiresAt !== undefined && Date.parse(banner.expiresAt) <= nowMs) {
            continue
          }
          if (filter.source !== undefined && banner.source !== filter.source) continue
          if (filter.severity !== undefined && banner.severity !== filter.severity) continue
          out.push(banner)
        }
        out.sort((a, b) => a.sequence - b.sequence)
        return out as ReadonlyArray<Banner>
      })

    const dismiss: CommsBannerShape["dismiss"] = (id) =>
      Effect.gen(function* () {
        const entry = state.byId.get(id)
        if (entry === undefined) {
          return yield* Effect.fail(new BannerNotFound({ id }))
        }
        if (entry.banner.dismissedAt !== undefined) return entry.banner // idempotent
        const now = yield* DateTime.now
        const iso = DateTime.formatIso(now)
        const dismissed: Banner = { ...entry.banner, dismissedAt: iso }
        Object.freeze(dismissed)
        state.byId.set(id, { ...entry, banner: dismissed })
        const key = dismissed.dedupeKey
        if (key !== undefined) state.dedupeIndex.delete(dedupeIndexKey(dismissed.source, key))
        yield* appendRecord("dismissed", dismissed, iso, dismissed.sequence)
        yield* emit({ type: "dismissed", banner: dismissed })
        return dismissed
      })

    const bannerLog: CommsBannerShape["bannerLog"] = () => store.readAll()

    return {
      publish,
      subscribe: () => PubSub.subscribe(hub).pipe(Effect.map((sub) => Stream.fromSubscription(sub))),
      listBanners,
      dismiss,
      bannerLog,
    }
  })

/** Options for the persistent layer. */
export interface CommsBannerOptions {
  /** XDG paths (substrate/config.ts `resolvePaths`). */
  readonly paths: AimyPaths
  /** Install UUID — namespaces the log: `<state>/<instanceId>/comms/banner-log.jsonl`. */
  readonly instanceId: string
}

/**
 * Persistent layer: append-only JSONL log in the XDG state dir, namespaced by
 * instance UUID. Banners survive restarts; the sequence counter resumes from
 * the log. Construction replays the log and fails closed (`BannerLogError`)
 * on a corrupt or unreadable log.
 */
export const CommsBannerLive = (options: CommsBannerOptions): Layer.Layer<CommsBanner, BannerLogError> =>
  Layer.effect(
    CommsBanner,
    makeService(FileBannerLogStore(options.paths, options.instanceId)),
  )

/**
 * Build a fresh ephemeral layer for tests: same semantics, in-memory log, no
 * I/O. A FUNCTION (not a shared value) because Effect layers memoize
 * construction — sharing one layer value across provides would share banner
 * state between tests. The error channel is uninhabited in practice (the
 * in-memory store cannot fail).
 */
export const CommsBannerEphemeral = (): Layer.Layer<CommsBanner, BannerLogError> =>
  Layer.effect(CommsBanner, makeService(InMemoryBannerLogStore()))
