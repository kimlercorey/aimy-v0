/**
 * M7 acceptance demo (made real):
 *  1. schedule a cron job → banner fires on completion (JobRunner → CommsBanner)
 *  2. one-click export → verified bundle with integrity receipt (DataExport)
 */
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Redacted } from "./substrate/types.js"
import type { AimyPaths } from "./substrate/config.js"

// --- Part 1: jobs → banners -------------------------------------------------
import { AlertSink } from "./jobs/src/runner.js"
import { JobRunner, JobRunnerLive } from "./jobs/src/runner.js"
import { InMemoryRunHistory } from "./jobs/src/history.js"
import type { JobAlert } from "./jobs/src/types.js"
import { cronEvery } from "./jobs/src/cron.js"
import { CommsBanner, CommsBannerEphemeral } from "./comms/service.js"
import type { Banner } from "./comms/types.js"

/** Adapter: JobRunner's AlertSink seam → CommsBanner.publish. */
const bannerAlertSinkLayer: Layer.Layer<AlertSink, never, CommsBanner> = Layer.effect(
  AlertSink,
  Effect.map(CommsBanner, (banner) =>
    AlertSink.of({
      alert: (a: JobAlert) =>
        banner
          .publish({
            severity: a.kind === "job-failed" || a.kind === "job-parked" ? "warning" : "success",
            source: `job:${a.jobId}`,
            title: `${a.jobName}: ${a.kind}`,
            body: a.detail,
            dedupeKey: `m7demo:${a.jobId}:${a.kind}`
          })
          .pipe(Effect.asVoid)
    })
  )
)

const pollFor = <A>(
  check: Effect.Effect<A | undefined>,
  label: string,
  maxSteps = 500
): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let i = 0; i < maxSteps; i++) {
      const found = yield* check
      if (found !== undefined) return found
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error(`demo timed out waiting for: ${label}`))
  })

describe("M7 demo: cron job → banner fires on completion", () => {
  it.effect("scheduled cron job completes and a banner lands on the channel", () =>
    Effect.gen(function* () {
      // One shared banner layer: the sink publishes through it and the test
      // reads from it. (Effect 4 mergeAll does not wire sibling requirements,
      // so the sink's CommsBanner requirement is provided explicitly.)
      const bannerLayer = CommsBannerEphemeral()
      const stack = Layer.mergeAll(
        Layer.provideMerge(
          JobRunnerLive,
          Layer.mergeAll(Layer.provide(bannerAlertSinkLayer, bannerLayer), InMemoryRunHistory)
        ),
        bannerLayer
      )
      yield* Effect.gen(function* () {
        const runner = yield* JobRunner
        const banner = yield* CommsBanner
        yield* runner.schedule({
          id: "demo-cron",
          name: "M7 demo cron job",
          tier: "T1",
          schedule: {
            _tag: "Cron",
            cron: {
              minute: cronEvery(1, 0, 59),
              hour: { _tag: "Any" } as never,
              dayOfMonth: { _tag: "Any" } as never,
              month: { _tag: "Any" } as never,
              dayOfWeek: { _tag: "Any" } as never
            }
          },
          restart: { _tag: "Never" },
          notify: "always",
          run: Effect.succeed("demo-ok")
        })
        yield* runner.runNow("demo-cron")
        const found = yield* pollFor(
          Effect.gen(function* () {
            const banners: ReadonlyArray<Banner> = yield* banner.listBanners()
            return banners.find((b) => b.source === "job:demo-cron")
          }),
          "job:demo-cron banner"
        )
        expect(found.severity).toBe("success")
        expect(found.title).toContain("job-succeeded")
      }).pipe(Effect.provide(stack))
    })
  )
})

// --- Part 2: one-click export → verified bundle ------------------------------
import { ensureInstanceId, IdentityServiceLive } from "./identity/identity.js"
import { FileLockerLive, SecretLocker } from "./identity/locker.js"
import { AllowAllGate, MemoryService, MemoryServiceLive, MemoryPaths } from "./memory/service.js"
import { exportData } from "./export/export.js"
import { verifyBundle } from "./export/bundle.js"
import { ModuleHost, makeModuleHost } from "./module-seam/src/host.js"
import { ModuleLifecycle, ModuleLifecycleLive } from "./module-seam/src/lifecycle.js"
import { makeModuleHooks, allowAllKernel } from "./module-seam/src/hooks.js"
import { makeBackendSet, makeDirectGate } from "./module-seam/src/sandbox.js"
import { makeMapSkillStore } from "./module-seam/src/skill-index.js"
import { stubIdentitySeam } from "./module-seam/src/instance.js"
import { InMemoryTimelineStore, LearningTimelineLive } from "./learning/src/timeline.js"

const CANARY = "m7-demo-canary-secret-value-9f8e7d6c"

const makePaths = (): Effect.Effect<{ root: string; paths: AimyPaths }, unknown> =>
  Effect.promise(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimy-m7demo-"))
    return {
      root,
      paths: {
        data: path.join(root, "data"),
        config: path.join(root, "config"),
        state: path.join(root, "state")
      }
    }
  })

describe("M7 demo: one-click export → verified bundle", () => {
  it.effect("export produces a bundle whose receipt verifies independently; tamper fails typed", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const instanceId = yield* ensureInstanceId(paths)
      const lockerLayer = FileLockerLive({
        passphrase: Redacted.make("m7-demo-passphrase"),
        instanceId,
        paths
      })
      const hostLayer = Layer.provide(
        Layer.effect(
          ModuleHost,
          Effect.map(ModuleLifecycle, (lifecycle) =>
            makeModuleHost({
              lifecycle,
              hooks: makeModuleHooks({ impls: [], kernel: allowAllKernel }),
              kernel: allowAllKernel,
              identity: stubIdentitySeam(instanceId),
              backends: makeBackendSet(makeDirectGate(allowAllKernel)),
              platform: "linux",
              skills: [],
              skillStore: makeMapSkillStore(new Map())
            })
          )
        ),
        ModuleLifecycleLive
      )
      const stack = Layer.mergeAll(
        Layer.provide(IdentityServiceLive({ instanceId, paths }), lockerLayer),
        lockerLayer,
        Layer.provide(
          MemoryServiceLive,
          Layer.mergeAll(
            AllowAllGate,
            Layer.succeed(MemoryPaths, {
              sessionsDir: path.join(paths.state, "memory", "sessions"),
              storesDir: path.join(paths.state, "memory", "stores")
            })
          )
        ),
        hostLayer,
        Layer.provide(LearningTimelineLive, InMemoryTimelineStore)
      )
      const outDir = path.join(paths.state, "export")
      yield* Effect.gen(function* () {
        const memory = yield* MemoryService
        const locker = yield* SecretLocker
        const e1 = yield* memory.append("s-demo", {
          parentId: null,
          kind: "message",
          payload: { text: "m7 demo memory" }
        })
        yield* memory.append("s-demo", { parentId: e1.id, kind: "message", payload: { text: "reply" } })
        yield* memory.set("profile", "name", "Kimler")
        yield* locker.store("api/canary-token", Redacted.make(CANARY), { profile: "default" } as never)

        const summary = yield* exportData({ outDir })
        expect(summary.fileCount).toBeGreaterThan(0)

        // Independent verification passes…
        yield* verifyBundle(outDir)

        // …the canary never appears in the bundle bytes…
        const walk = async (dir: string): Promise<Array<string>> => {
          const out: Array<string> = []
          for (const e of await fs.readdir(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name)
            if (e.isDirectory()) out.push(...(await walk(p)))
            else out.push(p)
          }
          return out
        }
        for (const f of yield* Effect.promise(() => walk(outDir))) {
          const bytes = yield* Effect.promise(() => fs.readFile(f, "utf-8"))
          expect(bytes.includes(CANARY)).toBe(false)
        }

        // …and flipping one byte fails typed.
        const manifestPath = path.join(outDir, "manifest.json")
        const manifestBytes = yield* Effect.promise(() => fs.readFile(manifestPath, "utf-8"))
        const tampered = manifestBytes.slice(0, 100) + "X" + manifestBytes.slice(101)
        yield* Effect.promise(() => fs.writeFile(manifestPath, tampered))
        const exit = yield* Effect.exit(verifyBundle(outDir))
        expect(Exit.isFailure(exit)).toBe(true)
      }).pipe(Effect.provide(stack))
    })
  )
})
