# comms — CommsBanner channel (M7, Track 3)

The in-app channel for system→user alerts (job done, cron status) — MoSCoW
MUST 15, architecture §1.1 row 11 + §12 M7. Product-owner trusted broadcast
(MoSCoW Should) **reuses this channel** later under its own opt-in/audit
terms; the `source` field and the capability seam below are the extension
point.

**Local only. No network. No UI.** This library is data structures +
an Effect service. The M8 Foldkit UI consumes `listBanners()`,
`subscribe()`, `dismiss()`, `bannerLog()`.

## Files

| File | Contents |
|---|---|
| `types.ts` | `Banner`, `BannerSource`, `NewBanner`, `BannerEvent`, `BannerLogRecord`, `BannerFilter` — data only |
| `errors.ts` | `CommsError` union (`BannerLogError`, `BannerValidationError`, `TrustedBroadcastCapabilityMissing`, `TrustedBroadcastCapabilityInvalid`, `BannerNotFound`) — never thrown, only returned |
| `capability.ts` | `TrustedBroadcastCapability` — the trusted-broadcast seam (see below) |
| `store.ts` | Append-only log backends: `FileBannerLogStore` (XDG state dir) + `InMemoryBannerLogStore` |
| `service.ts` | `CommsBanner` tag + shape, `CommsBannerLive` / `CommsBannerEphemeral` layers |
| `test/comms.test.ts` | 18 tests: ordering, dedupe, critical routing, dismissal audit, capability forgery, validation, persistence |

## API

```ts
import { CommsBanner, CommsBannerLive } from "./comms/index.js"
import { resolvePaths } from "../substrate/config.js"

const layer = CommsBannerLive({
  paths: resolvePaths(),          // XDG state dir
  instanceId: "<install-uuid>",   // namespaces the log
})

const program = Effect.gen(function* () {
  const comms = yield* CommsBanner

  // Publish — typed, validated, capability-gated for trusted-broadcast.
  const banner = yield* comms.publish({
    severity: "success",
    source: "job:nightly-backup",
    title: "nightly backup completed",
    body: "42 files, 0 errors",
    dedupeKey: "job-completed",   // collapse repeats within the dedupe TTL
    actions: [{ id: "view-job", label: "View job" }],  // handled by the M8 UI
  })

  // Subscribe — eager, in global sequence order, scoped lifetime.
  const stream = yield* comms.subscribe()
  yield* stream.pipe(Stream.tap((e) => Console.log(e.type, e.banner.title)), Stream.runDrain)

  const active = yield* comms.listBanners()                       // active only
  const all = yield* comms.listBanners({ includeDismissed: true })
  yield* comms.dismiss(banner.id)                                 // audited, not deleted
  const audit = yield* comms.bannerLog()                          // full append-only log
})
```

## Semantics

**Ordering.** Every publish assigns a strictly increasing global sequence
number — the global causal order. The hub (an Effect `PubSub`) emits in
publish order, so per-source FIFO and global order coincide for subscribers.
The counter resumes from the log after restarts.

**Dedupe.** Same `dedupeKey` + same `source` within the dedupe TTL
(`DEFAULT_DEDUPE_TTL_MS`, 10 minutes) collapses into ONE banner with an
incremented `count` — never a flood. Dedupe hits are `dedupe-hit` log
records, so dedupe survives restarts. Dismissing a banner removes it as a
dedupe target (a re-occurrence after dismissal is a new banner).

**Severity routing.**
- `critical` — NEVER deduped and NEVER auto-expires. `ttlMs` is ignored;
  `expiresAt` is never set. A critical banner stays until dismissed.
- `info` / `success` / `warning` — expire by TTL: per-publish `ttlMs`
  overrides the severity default (`DEFAULT_TTL_MS`: 24h info/success,
  7d warning). Expiry is lazy (evaluated on publish/list) and audited:
  an `expired` log record + hub event, never silent.

**Dismissal audit.** `dismiss(id)` records `dismissedAt` and appends a
`dismissed` log record. The banner is RETAINED — the log is the audit
trail. Dismiss is idempotent; unknown ids fail with `BannerNotFound`.

**Banner ids** are deterministic: `sha256(source, severity,
dedupeKey-or-title, body, sequence)` — no randomness, stable across
restarts via the persisted sequence.

## Trusted-broadcast seam (structural, not documentary)

`source: "trusted-broadcast"` is a RESERVED origin for the future
opt-in vendor broadcast (security-flaw disclosure first — MoSCoW Should,
architecture §12 post-MVP #5). The channel distinguishes it from
`system` / `job:<id>` / `scheduler` / `asc-diagnostic` origins, with
different audit requirements, per the MoSCoW spec.

The unforgeability property is structural:

- `TrustedBroadcastCapability` has a **private constructor** and no
  factory is exported from `capability.ts`. There is no code path in the
  local system that can produce an instance.
- `publish()` requires `instanceof TrustedBroadcastCapability` for the
  `trusted-broadcast` source. Missing → `TrustedBroadcastCapabilityMissing`;
  a fabricated value (structurally faked object) →
  `TrustedBroadcastCapabilityInvalid` — the runtime `instanceof` check
  backs the compile-time type so a cast object fails closed instead of
  being silently accepted.

The future opt-in vendor-network module gains the sole minting site via an
explicit, auditable change to `capability.ts`. Until then, the capability
type has no inhabitant — local code (JobRunner, scheduler, ASC
diagnostics, modules) cannot forge a broadcast. A compile-time test
(`@ts-expect-error` on `new TrustedBroadcastCapability()`) fails the
build if a public construction path ever appears.

## Persistence

`CommsBannerLive` appends every lifecycle transition (`published`,
`dedupe-hit`, `dismissed`, `expired`) as one JSON line to
`<XDG state>/<instanceId>/comms/banner-log.jsonl` (`v: 1` records).
Construction replays the log: banners, the sequence counter, and dedupe
state all survive restarts. A corrupt line fails closed (`BannerLogError`)
— never silently skipped, mirroring identity's corrupt-id rule. Logs are
namespaced by install UUID: one instance's banners are invisible to
another's.

`CommsBannerEphemeral()` (note: a function — layers memoize construction,
so each call builds a fresh layer) is the same service over an in-memory
log, for tests.

## Testing notes

Time is Effect's `Clock` (`DateTime.now`), so `@effect/vitest`'s
`it.effect` provides `TestClock`: `TestClock.adjust` drives
expiry/dedupe deterministically — the suite never sleeps (a sleep would
hang under the test clock). `subscribe()` is eager, so tests subscribe
before publishing with no fork and no race.
