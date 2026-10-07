/**
 * comms/test/comms.test.ts — CommsBanner channel behavior.
 *
 * Covers: global causal ordering (per-source FIFO + global sequence),
 * dedupe (100 identical job banners → 1 banner, count=100), critical
 * severity routing (never deduped, never expires), info TTL expiry,
 * dismissal audit trail, trusted-broadcast capability forgery, input
 * validation, and restart persistence (sequence + dedupe survive a rebuild
 * from the log; logs are namespaced by instance UUID).
 *
 * Time is Effect's TestClock here: `DateTime.now` inside the service reads
 * the test clock, so `TestClock.adjust` drives expiry/dedupe deterministically.
 * (NOTE: @effect/vitest's it.effect provides TestClock, so Effect.sleep would
 * hang — this suite never sleeps; it adjusts the clock instead.)
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { resolvePaths } from "../../substrate/config.js"
import {
  BannerLogError,
  BannerNotFound,
  CommsBanner,
  CommsBannerEphemeral,
  CommsBannerLive,
  DEFAULT_DEDUPE_TTL_MS,
  TrustedBroadcastCapability,
  type BannerEvent,
  type CommsBannerShape,
  type NewBanner,
} from "../index.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const infoBanner = (overrides: Partial<NewBanner> = {}): NewBanner => ({
  severity: "info",
  source: "system",
  title: "test banner",
  body: "test body",
  ...overrides,
})

const jobDone = (jobId: string): NewBanner => ({
  severity: "success",
  source: `job:${jobId}`,
  title: `job ${jobId} completed`,
  body: "exit 0",
  dedupeKey: "job-completed",
})

const withComms = <A, E>(
  use: (svc: CommsBannerShape) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E | BannerLogError, Scope.Scope> =>
  Effect.gen(function* () {
    const svc = yield* CommsBanner
    return yield* use(svc)
  }).pipe(Effect.provide(CommsBannerEphemeral()))

/** Subscribe, run `publish`, then collect exactly `n` events in arrival order. */
const collectEvents = (
  svc: CommsBannerShape,
  n: number,
  publish: () => Effect.Effect<unknown, unknown, Scope.Scope>,
): Effect.Effect<ReadonlyArray<BannerEvent>, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    // Eager subscription: live before the first publish, so nothing is missed.
    // it.effect runs tests inside Effect.scoped, so the Scope is available here.
    const stream = yield* svc.subscribe()
    yield* publish()
    return yield* stream.pipe(Stream.take(n), Stream.runCollect)
  })

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("ordering", () => {
  it.effect("assigns a strictly increasing global sequence across sources", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const b1 = yield* svc.publish(infoBanner({ source: "system" }))
        const b2 = yield* svc.publish(infoBanner({ source: "job:nightly-backup" }))
        const b3 = yield* svc.publish(infoBanner({ source: "scheduler" }))
        assert.isTrue(b2.sequence === b1.sequence + 1 && b3.sequence === b2.sequence + 1)
        const listed = yield* svc.listBanners()
        assert.deepEqual(
          listed.map((b) => b.sequence),
          [b1.sequence, b2.sequence, b3.sequence],
        )
      }),
    ),
  )

  it.effect("subscribers see per-source FIFO in global causal order", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const events = yield* collectEvents(svc, 4, () =>
          Effect.gen(function* () {
            yield* svc.publish(infoBanner({ source: "system", title: "s1" }))
            yield* svc.publish(infoBanner({ source: "job:a", title: "j1" }))
            yield* svc.publish(infoBanner({ source: "system", title: "s2" }))
            yield* svc.publish(infoBanner({ source: "job:a", title: "j2" }))
          }),
        )
        const seqs = events.map((e) => e.banner.sequence)
        assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
        assert.deepEqual(
          events.filter((e) => e.banner.source === "system").map((e) => e.banner.title),
          ["s1", "s2"],
        )
        assert.deepEqual(
          events.filter((e) => e.banner.source === "job:a").map((e) => e.banner.title),
          ["j1", "j2"],
        )
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

describe("dedupe", () => {
  it.effect("collapses 100 identical job-completion banners into 1 banner with count=100", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        for (let i = 0; i < 100; i++) {
          yield* svc.publish(jobDone("nightly-backup"))
        }
        const banners = yield* svc.listBanners()
        assert.lengthOf(banners, 1)
        assert.strictEqual((banners[0] as { count: number }).count, 100)
        // The audit log still records every occurrence: 1 published + 99 dedupe-hits.
        const log = yield* svc.bannerLog()
        assert.strictEqual(log.filter((r) => r.kind === "published").length, 1)
        assert.strictEqual(log.filter((r) => r.kind === "dedupe-hit").length, 99)
      }),
    ),
  )

  it.effect("dedupe is scoped to (source, dedupeKey): different jobs do not collapse", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        yield* svc.publish(jobDone("a"))
        yield* svc.publish(jobDone("b"))
        yield* svc.publish({ ...jobDone("a"), dedupeKey: "other-key" })
        const banners = yield* svc.listBanners()
        assert.lengthOf(banners, 3)
      }),
    ),
  )

  it.effect("dedupe window expires: a re-occurrence after the TTL is a new banner", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        yield* svc.publish(jobDone("nightly-backup"))
        yield* TestClock.adjust(`${DEFAULT_DEDUPE_TTL_MS + 1} millis`)
        yield* svc.publish(jobDone("nightly-backup"))
        const banners = yield* svc.listBanners()
        assert.lengthOf(banners, 2)
        assert.deepEqual(
          banners.map((b) => b.count),
          [1, 1],
        )
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Severity routing
// ---------------------------------------------------------------------------

describe("severity routing", () => {
  it.effect("critical banners are never deduped: same key+source yields two banners", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const critical = (): NewBanner => ({
          severity: "critical",
          source: "system",
          title: "disk failure",
          body: "array degraded",
          dedupeKey: "disk-failure",
        })
        yield* svc.publish(critical())
        yield* svc.publish(critical())
        const banners = yield* svc.listBanners()
        assert.lengthOf(banners, 2)
        assert.isTrue(banners.every((b) => b.count === 1))
      }),
    ),
  )

  it.effect("critical banners never auto-expire; info banners expire by TTL", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const crit = yield* svc.publish({
          severity: "critical",
          source: "asc-diagnostic",
          title: "diagnostic failure",
          body: "monthly check failed",
          ttlMs: 1000, // must be ignored for critical
        })
        assert.isUndefined(crit.expiresAt)
        yield* svc.publish(infoBanner({ title: "ephemeral", ttlMs: 1000 }))
        yield* TestClock.adjust("30 days")
        const banners = yield* svc.listBanners()
        assert.lengthOf(banners, 1)
        assert.strictEqual(banners[0]?.severity, "critical")
        // The expiry is audited, not silent.
        const log = yield* svc.bannerLog()
        assert.isTrue(log.some((r) => r.kind === "expired"))
      }),
    ),
  )

  it.effect("emits an expired event on the hub when a banner lapses", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const events = yield* collectEvents(svc, 2, () =>
          Effect.gen(function* () {
            yield* svc.publish(infoBanner({ title: "ephemeral", ttlMs: 1000 }))
            yield* TestClock.adjust("2 seconds")
            yield* svc.listBanners() // lazy sweep runs here
          }),
        )
        assert.deepEqual(
          events.map((e) => e.type),
          ["published", "expired"],
        )
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Dismissal audit
// ---------------------------------------------------------------------------

describe("dismissal", () => {
  it.effect("dismiss records dismissedAt; the banner is retained, not deleted", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const banner = yield* svc.publish(infoBanner({ title: "dismiss me" }))
        const dismissed = yield* svc.dismiss(banner.id)
        assert.isDefined(dismissed.dismissedAt)
        assert.lengthOf(yield* svc.listBanners(), 0)
        const withDismissed = yield* svc.listBanners({ includeDismissed: true })
        assert.lengthOf(withDismissed, 1)
        const log = yield* svc.bannerLog()
        assert.isTrue(log.some((r) => r.kind === "dismissed" && r.banner.id === banner.id))
      }),
    ),
  )

  it.effect("dismiss is idempotent and unknown ids fail typed", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const banner = yield* svc.publish(infoBanner())
        yield* svc.dismiss(banner.id)
        yield* svc.dismiss(banner.id) // no second audit record
        const log = yield* svc.bannerLog()
        assert.strictEqual(log.filter((r) => r.kind === "dismissed").length, 1)

        const err = yield* Effect.flip(svc.dismiss("banner-does-not-exist"))
        assert.instanceOf(err, BannerNotFound)
        assert.strictEqual(err.id, "banner-does-not-exist")
        assert.strictEqual(err.id, "banner-does-not-exist")
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Trusted-broadcast capability seam
// ---------------------------------------------------------------------------

describe("trusted-broadcast capability", () => {
  it.effect("publishing trusted-broadcast without a capability fails typed", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const err = yield* Effect.flip(
          svc.publish({
            severity: "critical",
            source: "trusted-broadcast",
            title: "security disclosure",
            body: "CVE in a bundled dependency",
          }),
        )
        assert.strictEqual(err._tag, "TrustedBroadcastCapabilityMissing")
        assert.lengthOf(yield* svc.listBanners(), 0)
      }),
    ),
  )

  it.effect("a forged capability value fails typed (not silently accepted)", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const forged = { brand: "trusted-broadcast-capability" } as unknown as TrustedBroadcastCapability
        const err = yield* Effect.flip(
          svc.publish(
            {
              severity: "critical",
              source: "trusted-broadcast",
              title: "security disclosure",
              body: "CVE in a bundled dependency",
            },
            forged,
          ),
        )
        assert.strictEqual(err._tag, "TrustedBroadcastCapabilityInvalid")
        assert.lengthOf(yield* svc.listBanners(), 0)
      }),
    ),
  )

  it("the capability has no public construction path (compile-time structural test)", () => {
    // @ts-expect-error — private constructor: no typed code outside
    // capability.ts can mint a TrustedBroadcastCapability. If this line ever
    // compiles (constructor made public), tsc fails on the unused
    // '@ts-expect-error' directive — that failure IS the test.
    new TrustedBroadcastCapability()
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  it.effect("rejects empty titles and non-positive TTLs with typed errors", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const e1 = yield* Effect.flip(svc.publish(infoBanner({ title: "   " })))
        assert.strictEqual(e1._tag, "BannerValidationError")
        const e2 = yield* Effect.flip(svc.publish(infoBanner({ ttlMs: 0 })))
        assert.strictEqual(e2._tag, "BannerValidationError")
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Persistence: restart recovery + instance namespacing
// ---------------------------------------------------------------------------

describe("persistence", () => {
  const tmpStateDir = () =>
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "aimy-comms-test-")))

  const liveFor = (stateDir: string, instanceId: string) =>
    CommsBannerLive({
      paths: resolvePaths({ env: { XDG_STATE_HOME: stateDir }, home: stateDir }),
      instanceId,
    })

  const withLive = <A, E>(
    stateDir: string,
    instanceId: string,
    use: (svc: CommsBannerShape) => Effect.Effect<A, E, never>,
  ): Effect.Effect<A, E | BannerLogError, never> =>
    Effect.gen(function* () {
      const svc = yield* CommsBanner
      return yield* use(svc)
    }).pipe(Effect.provide(liveFor(stateDir, instanceId)))

  it.effect("banners, sequence, and dedupe survive a layer rebuild (restart)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpStateDir()
      const id = "11111111-2222-4333-8444-555555555555"

      yield* withLive(dir, id, (svc) =>
        Effect.gen(function* () {
          yield* svc.publish(jobDone("nightly-backup"))
          yield* svc.publish(jobDone("nightly-backup")) // count=2
          yield* svc.publish(infoBanner({ title: "hello" }))
        }),
      )

      // "Restart": build a brand-new layer over the same directory.
      yield* withLive(dir, id, (svc) =>
        Effect.gen(function* () {
          const banners = yield* svc.listBanners()
          assert.lengthOf(banners, 2)
          const job = banners.find((b) => b.source === "job:nightly-backup")
          assert.strictEqual(job?.count, 2)
          // Sequence resumes from the log, not from 1. (The dedupe hit above
          // consumed no sequence number: 2 banners published → next is 3.)
          const next = yield* svc.publish(infoBanner({ title: "after restart" }))
          assert.strictEqual(next.sequence, 3)
          // Dedupe still collapses into the pre-restart banner.
          const again = yield* svc.publish(jobDone("nightly-backup"))
          assert.strictEqual(again.id, job?.id)
          assert.strictEqual(again.count, 3)
          assert.lengthOf(yield* svc.listBanners(), 3)
        }),
      )

      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )

  it.effect("logs are namespaced by instance UUID: another instance sees nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpStateDir()
      yield* withLive(dir, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", (svc) =>
        svc.publish(infoBanner({ title: "instance A banner" })),
      )
      yield* withLive(dir, "ffffffff-0000-4111-9222-333333333333", (svc) =>
        Effect.gen(function* () {
          assert.lengthOf(yield* svc.listBanners(), 0)
        }),
      )
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )

  it.effect("a corrupt log fails closed instead of silently starting empty", () =>
    Effect.gen(function* () {
      const dir = yield* tmpStateDir()
      const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
      const file = path.join(dir, "aimy", id, "comms", "banner-log.jsonl")
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(file, "this is not json\n"))
      const exit = yield* Effect.exit(
        withLive(dir, id, (svc) => svc.listBanners()).pipe(Effect.asVoid),
      )
      assert.strictEqual(exit._tag, "Failure")
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )
})

// ---------------------------------------------------------------------------
// Subscribe API shape
// ---------------------------------------------------------------------------

describe("subscribe", () => {
  it.effect("each subscriber receives published, deduped, and dismissed events", () =>
    withComms((svc) =>
      Effect.gen(function* () {
        const stream = yield* svc.subscribe()
        const banner = yield* svc.publish(jobDone("nightly-backup"))
        yield* svc.publish(jobDone("nightly-backup")) // deduped
        yield* svc.dismiss(banner.id)
        const events = yield* stream.pipe(Stream.take(3), Stream.runCollect)
        assert.deepEqual(
          events.map((e) => e.type),
          ["published", "deduped", "dismissed"],
        )
      }),
    ),
  )
})
