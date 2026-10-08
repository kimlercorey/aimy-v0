/**
 * messaging/forward.ts — Phase 4: outbound banner forwarding.
 *
 * Subscribes to the comms banner hub; forwards banners matching the user's
 * ForwardingPrefs to the paired chat. Forwarding failures are logged, never
 * retried silently — a missed critical banner surfaces in-app (the hub still
 * has it).
 *
 * Prefs are in-memory with file persistence (0600) so the CLI wizard's
 * choices survive restarts. The gateway never forwards when disabled or
 * when no chat is paired.
 */
import { Effect, Stream } from "effect"
import { promises as fs } from "node:fs"
import { dirname } from "node:path"
import type { Banner, BannerEvent, BannerSeverity } from "../../comms/types.js"
import type { CommsBannerShape } from "../../comms/service.js"
import { DEFAULT_FORWARDING_PREFS, type Channel, type ForwardingPrefs } from "./types.js"
import type { PairingRegistryShape } from "./pairing.js"
import { RegistryError } from "./errors.js"

export interface ForwardDeps {
  readonly registry: PairingRegistryShape
  readonly channel: Channel
  readonly comms: CommsBannerShape
  /** Directory for prefs persistence (0600). */
  readonly dir: string
}

const PREFS_FILE = "messaging-forwarding-prefs.json"

/** Render a banner as a compact Telegram message. Pure. */
export const renderBanner = (banner: Banner): string => {
  const mark =
    banner.severity === "critical" ? "🔴" :
    banner.severity === "warning" ? "🟡" :
    banner.severity === "success" ? "🟢" : "🔵"
  return `${mark} ${banner.title}\n${banner.body}`
}

/** Should this banner forward under these prefs? Pure. */
export const shouldForward = (prefs: ForwardingPrefs, banner: Banner): boolean =>
  prefs.enabled && prefs.severities.includes(banner.severity)

export interface Forwarder {
  readonly getPrefs: () => Effect.Effect<ForwardingPrefs, never>
  readonly setPrefs: (prefs: ForwardingPrefs) => Effect.Effect<void, RegistryError>
  /** Forward one banner if prefs allow. Never fails the caller. */
  readonly forward: (banner: Banner) => Effect.Effect<void, never>
  /** Attempt the queued backlog once (the background flusher calls this). */
  readonly flush: () => Effect.Effect<void, never>
  /** Subscribe to the comms hub and forward matching banners. Runs until scope closes. */
  readonly run: () => Effect.Effect<void, never, Scope.Scope>
}

export const makeForwarder = (deps: ForwardDeps): Forwarder => {
  const file = `${deps.dir}/${PREFS_FILE}`
  let prefs: ForwardingPrefs = DEFAULT_FORWARDING_PREFS
  let loaded = false
  /** Bounded outbound queue: banners that failed to send, retried by the flusher. */
  const pending: Array<{ banner: Banner; attempts: number }> = []
  const MAX_QUEUE = 50
  const MAX_ATTEMPTS = 10
  const FLUSH_INTERVAL_MS = 30_000

  const load: Effect.Effect<void, never> = Effect.gen(function* () {
    if (loaded) return
    const raw: string | undefined = yield* Effect.tryPromise({
      try: () => fs.readFile(file, "utf-8"),
      catch: () => undefined as unknown as Error,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as Partial<ForwardingPrefs>
        if (typeof parsed.enabled === "boolean" && Array.isArray(parsed.severities)) {
          prefs = {
            enabled: parsed.enabled,
            severities: (parsed.severities as ReadonlyArray<BannerSeverity>).filter((s) =>
              ["info", "success", "warning", "critical"].includes(s)
            ),
          }
        }
      } catch {
        // Corrupt prefs → defaults (fail-safe, not fail-closed: forwarding
        // is a convenience, not a security boundary).
      }
    }
    loaded = true
  })

  const save = (p: ForwardingPrefs): Effect.Effect<void, RegistryError> =>
    Effect.tryPromise({
      try: async () => {
        await fs.mkdir(dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify(p, null, 2), { mode: 0o600 })
      },
      catch: (e) => new RegistryError({ reason: `prefs write failed: ${String(e)}` }),
    })

  const enqueue = (banner: Banner): void => {
    if (pending.length >= MAX_QUEUE) {
      const dropped = pending.shift()
      Effect.runSync(
        Effect.logWarning(
          `forwarding queue full — dropped oldest banner ${dropped?.banner.id} to make room`
        )
      )
    }
    pending.push({ banner, attempts: 0 })
  }

  const trySend = (banner: Banner): Effect.Effect<boolean, never> =>
    Effect.gen(function* (): Generator<Effect.Effect<unknown, never>, boolean, unknown> {
      const chat = yield* deps.registry.getPaired(deps.channel.name)
      if (chat === undefined) return true // unpaired mid-flight: drop quietly
      const ok: boolean = yield* deps.channel.send(chat, renderBanner(banner)).pipe(
        Effect.map(() => true),
        Effect.catch((e) =>
          Effect.succeed(false).pipe(
            Effect.tap(() => Effect.logWarning(`forwarding failed for banner ${banner.id}: ${e.reason}`))
          )
        )
      )
      return ok
    }).pipe(Effect.catch(() => Effect.succeed(true)))

  const flushOnce: Effect.Effect<void, never> =
    Effect.gen(function* () {
      while (pending.length > 0) {
        const head = pending[0]
        if (head === undefined) break
        const sent = yield* trySend(head.banner)
        if (sent) {
          pending.shift()
        } else if (head.attempts + 1 >= MAX_ATTEMPTS) {
          pending.shift()
          yield* Effect.logWarning(
            `forwarding gave up on banner ${head.banner.id} after ${MAX_ATTEMPTS} attempts`
          )
        } else {
          head.attempts += 1
          break // back off until the next flush cycle
        }
      }
    }).pipe(Effect.catch(() => Effect.void))

  const flusher: Effect.Effect<void, never> =
    Effect.gen(function* () {
      yield* Effect.sleep(FLUSH_INTERVAL_MS)
      yield* flushOnce
      return yield* flusher
    }).pipe(Effect.catch(() => Effect.void))

  const forward: Forwarder["forward"] = (banner) =>
    Effect.gen(function* () {
      yield* load
      if (!shouldForward(prefs, banner)) return
      const sent = yield* trySend(banner)
      if (!sent) enqueue(banner)
    }).pipe(Effect.catch(() => Effect.void))

  return {
    getPrefs: () => load.pipe(Effect.andThen(() => Effect.succeed(prefs))),
    setPrefs: (p) =>
      Effect.gen(function* () {
        yield* load
        prefs = p
        yield* save(p)
      }),
    forward,
    flush: () => flushOnce,
    run: () =>
      Effect.gen(function* () {
        yield* Effect.forkDetach(flusher)
        const stream = yield* deps.comms.subscribe()
        yield* Stream.runForEach(stream, (event: BannerEvent) =>
          event.type === "published" ? forward(event.banner) : Effect.void
        )
      }).pipe(Effect.catch(() => Effect.void)) as Effect.Effect<void, never, Scope.Scope>,
  }
}

// Effect/Scope are type-only in the seam; the concrete import is needed here.
import type { Scope } from "effect"
