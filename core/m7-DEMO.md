# M7 acceptance demo log

Proven by `core/m7-demo.test.ts` (2 tests, green). Run: `npx vitest run m7-demo.test.ts`.

## 1. Cron job → banner fires on completion

- Built the production-shape stack: `JobRunnerLive` + `InMemoryRunHistory` +
  a real `CommsBanner` (ephemeral layer) wired through the `AlertSink` seam
  (`bannerAlertSinkLayer`: `JobAlert` → `CommsBanner.publish` with
  `source: job:<jobId>`).
- Scheduled `demo-cron` (tier T1, cron every minute, restart Never,
  `notify: "always"`), triggered via `runNow`.
- Result: banner published with `source: "job:demo-cron"`,
  `severity: "success"`, title containing `job-succeeded`. Found via
  `banner.listBanners()` — the full path job → AlertSink → banner channel
  works end to end.

## 2. One-click export → verified bundle

- Built the sovereign stack over temp dirs: IdentityService + FileLocker
  (seeded with a canary secret), MemoryService (seeded sessions + kv),
  ModuleHost, LearningTimeline.
- `exportData({ outDir })` produced the bundle; `verifyBundle(outDir)`
  (independent re-read from disk) passed.
- Canary sweep: every byte of every bundle file checked — the secret value
  appears nowhere; only the locker manifest (names + scopes) ships, plus
  `secrets-to-reenter.json`.
- Tamper: flipped one byte of `manifest.json` → `verifyBundle` failed with a
  typed `ExportError`.
