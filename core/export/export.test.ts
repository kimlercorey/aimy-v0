/**
 * export.test.ts — DataExport (MUST #16) behavior.
 *
 * - full export round-trip: seed the five real services, export, verify;
 * - independent receipt verification (`verifyBundle` re-reads from disk);
 * - tamper evidence: one flipped byte (in a data file, in a recorded hash,
 *   in the receipt body) and one added file all fail typed;
 * - locker discipline: a seeded canary secret value appears NOWHERE in the
 *   bundle; the locker manifest carries names/scopes/created-at only;
 * - secrets export as re-entry prompts, never plaintext.
 */
import * as os from "node:os"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { ExportError } from "../substrate/errors.js"
import { Redacted } from "../substrate/types.js"
import type { AimyPaths } from "../substrate/config.js"
import { ensureInstanceId, IdentityService, IdentityServiceLive } from "../identity/identity.js"
import { FileLockerLive, SecretLocker } from "../identity/locker.js"
import { InMemoryTimelineStore, LearningTimeline, LearningTimelineLive } from "../learning/src/timeline.js"
import {
  AllowAllGate,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
  type MemoryDirs
} from "../memory/service.js"
import { ModuleHost, makeModuleHost } from "../module-seam/src/host.js"
import { ModuleLifecycle, ModuleLifecycleLive } from "../module-seam/src/lifecycle.js"
import { makeModuleHooks } from "../module-seam/src/hooks.js"
import { allowAllKernel } from "../module-seam/src/kernel-seam.js"
import { makeBackendSet, makeDirectGate } from "../module-seam/src/sandbox.js"
import { stubIdentitySeam } from "../module-seam/src/instance.js"
import { makeMapSkillStore } from "../module-seam/src/skill-index.js"

import { EXPORTER_VERSION, RECEIPT_FILE_NAME, exportData, verifyBundle } from "./index.js"

// Known-valid SKILL.md (mirrors module-seam's own fixture shape).
const SKILL_MD = `---
name: web-retrieval
version: 1.0.0
description: Web retrieval reference module.
author: AImy
license: ISC
aimy:
  hooks: [beforeToolCall, afterToolCall]
  tools: [web_fetch, web_search, skill_view]
  filesystem:
    read: [/data/retrieval]
    write: []
  network:
    vendorHosts: [api.search.example, cdn.fetch.example]
  memory:
    stores: [retrieval]
    write: true
  subprocess: false
---

# Web Retrieval

Body text here.
`

const CANARY = "export-canary-secret-VALUE-9f3k2-zzz"
const OTHER_SECRET = "some-other-secret-value"

const readUtf8 = (p: string): Effect.Effect<string, unknown> => Effect.promise(() => fs.readFile(p, "utf-8"))
const writeUtf8 = (p: string, s: string): Effect.Effect<void, unknown> => Effect.promise(() => fs.writeFile(p, s, "utf-8"))
const statPath = (p: string): Effect.Effect<unknown, unknown> => Effect.promise(() => fs.stat(p))

const makePaths = (): Effect.Effect<{ root: string; paths: AimyPaths }, unknown> =>
  Effect.promise(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimy-export-test-"))
    return {
      root,
      paths: {
        data: path.join(root, "data"),
        config: path.join(root, "config"),
        state: path.join(root, "state")
      }
    }
  })

/** Full sovereign stack over temp dirs: identity + locker + memory + host + timeline. */
const testStack = (paths: AimyPaths) =>
  Effect.gen(function* () {
    const instanceId = yield* ensureInstanceId(paths)
    const lockerLayer = FileLockerLive({
      passphrase: Redacted.make("export-test-passphrase"),
      instanceId,
      paths
    })
    const identityLayer = Layer.provide(IdentityServiceLive({ instanceId, paths }), lockerLayer)
    const memoryDirs: MemoryDirs = {
      sessionsDir: path.join(paths.state, "memory", "sessions"),
      storesDir: path.join(paths.state, "memory", "stores")
    }
    const memoryLayer = Layer.provide(
      MemoryServiceLive,
      Layer.mergeAll(AllowAllGate, Layer.succeed(MemoryPaths, memoryDirs))
    )
    const kernel = allowAllKernel
    const hostLayer = Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const lifecycle = yield* ModuleLifecycle
          return Layer.succeed(
            ModuleHost,
            makeModuleHost({
              lifecycle,
              hooks: makeModuleHooks({ impls: [], kernel }),
              kernel,
              identity: stubIdentitySeam("test-instance"),
              backends: makeBackendSet(makeDirectGate(kernel)),
              platform: "linux",
              skills: [{ name: "web-retrieval", description: "Web retrieval reference module." }],
              skillStore: makeMapSkillStore(new Map([["web-retrieval", "# Web Retrieval\n\nBody"]]))
            })
          )
        })
      ),
      ModuleLifecycleLive
    )
    const timelineLayer = Layer.provide(LearningTimelineLive, InMemoryTimelineStore)
    return Layer.mergeAll(identityLayer, lockerLayer, memoryLayer, hostLayer, timelineLayer)
  })

const seedWorld: Effect.Effect<
  void,
  unknown,
  MemoryService | SecretLocker | ModuleHost | LearningTimeline
> = Effect.gen(function* () {
  const memory = yield* MemoryService
  const locker = yield* SecretLocker
  const host = yield* ModuleHost
  const timeline = yield* LearningTimeline

  const e1 = yield* memory.append("s-alpha", { parentId: null, kind: "message", payload: { text: "hello" } })
  yield* memory.append("s-alpha", { parentId: e1.id, kind: "message", payload: { text: "world" } })
  yield* memory.append("s-beta", { parentId: null, kind: "message", payload: { text: "other" } })
  yield* memory.set("profile", "name", "Kimler")
  yield* memory.set("environment", "os", "linux")

  yield* timeline.recordEvent({
    type: "review-fork.proposed-add",
    provenance: { origin: "review-fork", sessionId: "s-alpha", profileId: "default" },
    evidenceIds: [],
    payload: { store: "profile", summary: "prefers concise answers" }
  })

  yield* locker.store("api/canary-token", Redacted.make(CANARY), { profile: "default" })
  yield* locker.store("oauth/google", Redacted.make(OTHER_SECRET), { profile: "personal" })

  yield* host.install({ moduleId: "web-retrieval", skillMd: SKILL_MD, tier: "T0" })
  yield* host.enable("web-retrieval")
})

const setupExported = (outDir: string) =>
  Effect.gen(function* () {
    const { paths } = yield* makePaths()
    const stack = yield* testStack(paths)
    const summary = yield* Effect.provide(seedWorld.pipe(Effect.andThen(exportData({ outDir }))), stack)
    return { paths, stack, summary }
  })

/** Assert a verifyBundle run failed with a typed ExportError matching `pattern`. */
const expectVerifyFailure = (exit: Exit.Exit<unknown, ExportError>, pattern: RegExp): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause)
    expect(failure._tag).toBe("Some")
    if (failure._tag === "Some") {
      expect(failure.value).toBeInstanceOf(ExportError)
      expect(failure.value.reason).toMatch(pattern)
    }
  }
}

const readAllBundleBytes = (dir: string): Effect.Effect<string, unknown> =>
  Effect.promise(async () => {
    const chunks: Array<string> = []
    const walk = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true })
      for (const e of entries) {
        const full = path.join(current, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) chunks.push(await fs.readFile(full, "utf-8"))
      }
    }
    await walk(dir)
    return chunks.join("\n")
  })

describe("DataExport round-trip", () => {
  it.effect("exports every store and verifies independently", () =>
    Effect.gen(function* () {
      const outDirSeed = yield* makePaths()
      const outDir = path.join(outDirSeed.paths.state, "export-bundle")
      const { stack, summary } = yield* setupExported(outDir)
      expect(summary.outDir).toBe(outDir)
      expect(summary.fileCount).toBeGreaterThan(5)

      // Independent verification: fresh read from disk, no shared state.
      const receipt = yield* verifyBundle(outDir)
      expect(receipt.instanceId).toBe(summary.receipt.instanceId)
      expect(receipt.bundleHash).toBe(summary.receipt.bundleHash)
      expect(receipt.exporterVersion).toBe(EXPORTER_VERSION)

      // Spot-check the bundle contents against the live services.
      const identityDoc = JSON.parse(yield* readUtf8(path.join(outDir, "identity/identity.json"))) as {
        instanceId: string
      }
      const identity = yield* Effect.provide(Effect.map(IdentityService, (s) => s), stack)
      expect(identityDoc.instanceId).toBe(identity.instanceId)

      const sessions = yield* Effect.promise(() => fs.readdir(path.join(outDir, "memory/sessions")))
      expect([...sessions].sort()).toEqual(["s-alpha.jsonl", "s-beta.jsonl"])
      const alpha = yield* readUtf8(path.join(outDir, "memory/sessions/s-alpha.jsonl"))
      expect(alpha).toContain("hello")
      expect(alpha).toContain("world")

      const profile = JSON.parse(yield* readUtf8(path.join(outDir, "memory/stores/profile.json"))) as {
        entries: Array<{ key: string; value: unknown }>
      }
      expect(profile.entries).toContainEqual({ key: "name", value: "Kimler" })

      const timeline = JSON.parse(yield* readUtf8(path.join(outDir, "timeline/timeline.json"))) as {
        nodeCount: number
        nodes: Array<{ type: string }>
      }
      expect(timeline.nodeCount).toBe(1)
      expect(timeline.nodes[0]?.type).toBe("review-fork.proposed-add")

      const modules = JSON.parse(yield* readUtf8(path.join(outDir, "modules/modules.json"))) as {
        moduleCount: number
        modules: Array<{ moduleId: string; manifest: { tools: Array<string> } }>
      }
      expect(modules.moduleCount).toBe(1)
      expect(modules.modules[0]?.moduleId).toBe("web-retrieval")
      expect(modules.modules[0]?.manifest.tools).toContain("web_fetch")

      const skills = JSON.parse(yield* readUtf8(path.join(outDir, "skills/skill-index.json"))) as {
        entries: Array<{ name: string }>
      }
      expect(skills.entries.map((e) => e.name)).toContain("web-retrieval")
    })
  )

  it.effect("writes the receipt last and lists every file exactly once", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const outDir = path.join(paths.state, "export-bundle")
      const { summary } = yield* setupExported(outDir)

      const receipt = JSON.parse(yield* readUtf8(path.join(outDir, RECEIPT_FILE_NAME))) as {
        files: Record<string, string>
      }
      const listed = Object.keys(receipt.files).sort()
      expect(listed).not.toContain(RECEIPT_FILE_NAME)
      expect(listed.length).toBe(summary.fileCount)
      // every listed file exists on disk
      for (const rel of listed) {
        yield* statPath(path.join(outDir, ...rel.split("/")))
      }
    })
  )
})

describe("tamper evidence", () => {
  it.effect("a flipped byte in a data file fails verifyBundle typed", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const outDir = path.join(paths.state, "export-bundle")
      yield* setupExported(outDir)

      // Flip one byte in a bundled data file.
      const target = path.join(outDir, "memory/sessions/s-alpha.jsonl")
      const raw = yield* readUtf8(target)
      const flipped = (raw[0] === "{" ? "[" : "{") + raw.slice(1)
      yield* writeUtf8(target, flipped)

      const exit = yield* Effect.exit(verifyBundle(outDir))
      expectVerifyFailure(exit, /^export:file-hash-mismatch:/)
    })
  )

  it.effect("a tampered file hash in the receipt fails typed", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const outDir = path.join(paths.state, "export-bundle")
      yield* setupExported(outDir)

      // Flip one hex char of a recorded file hash inside the receipt.
      const receiptPath = path.join(outDir, RECEIPT_FILE_NAME)
      const receipt = JSON.parse(yield* readUtf8(receiptPath)) as { files: Record<string, string> }
      const firstKey = Object.keys(receipt.files).sort()[0] as string
      const hash = receipt.files[firstKey] as string
      receipt.files[firstKey] = (hash[0] === "0" ? "1" : "0") + hash.slice(1)
      yield* writeUtf8(receiptPath, JSON.stringify(receipt, null, 2) + "\n")

      const exit = yield* Effect.exit(verifyBundle(outDir))
      expectVerifyFailure(exit, /^export:file-hash-mismatch:/)
    })
  )

  it.effect("a tampered receipt body fails typed on the bundle hash", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const outDir = path.join(paths.state, "export-bundle")
      yield* setupExported(outDir)

      // Change exportedAt: every file hash still matches, but the recomputed
      // bundle-level hash no longer matches the stored one.
      const receiptPath = path.join(outDir, RECEIPT_FILE_NAME)
      const receipt = JSON.parse(yield* readUtf8(receiptPath)) as { exportedAt: string }
      receipt.exportedAt = receipt.exportedAt.replace("T", "t")
      yield* writeUtf8(receiptPath, JSON.stringify(receipt, null, 2) + "\n")

      const exit = yield* Effect.exit(verifyBundle(outDir))
      expectVerifyFailure(exit, /^export:bundle-hash-mismatch$/)
    })
  )

  it.effect("an added file fails verifyBundle typed", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const outDir = path.join(paths.state, "export-bundle")
      yield* setupExported(outDir)

      yield* writeUtf8(path.join(outDir, "sneaky.txt"), "planted")

      const exit = yield* Effect.exit(verifyBundle(outDir))
      expectVerifyFailure(exit, /^export:unexpected-file:/)
    })
  )
})

describe("locker discipline", () => {
  it.effect("no secret value appears anywhere in the bundle (canary test)", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const outDir = path.join(paths.state, "export-bundle")
      yield* setupExported(outDir)

      // The canary was stored in the locker; grep every bundle byte for it.
      const blob = yield* readAllBundleBytes(outDir)
      expect(blob).not.toContain(CANARY)
      // The other seeded secret value is absent too.
      expect(blob).not.toContain(OTHER_SECRET)
      // …and the identity document carries only the PUBLIC key.
      const identityDoc = yield* readUtf8(path.join(outDir, "identity/identity.json"))
      expect(identityDoc).not.toContain("private")
    })
  )

  it.effect("the locker manifest carries names, scopes and created-at only", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const outDir = path.join(paths.state, "export-bundle")
      yield* setupExported(outDir)

      const manifest = JSON.parse(yield* readUtf8(path.join(outDir, "locker/locker-manifest.json"))) as {
        entryCount: number
        entries: Array<{ name: string; scope: { profile: string }; createdAt: number }>
      }
      expect(manifest.entryCount).toBe(3)
      const names = manifest.entries.map((e) => e.name).sort()
      // The instance signing key (sealed by IdentityService at first install)
      // is a locker entry too — manifest-only, like everything else.
      expect(names).toEqual(["api/canary-token", "identity/instance-signing-key", "oauth/google"])
      const byName = new Map(manifest.entries.map((e) => [e.name, e.scope.profile] as const))
      expect(byName.get("identity/instance-signing-key")).toBe("instance")
      for (const entry of manifest.entries) {
        expect(Object.keys(entry).sort()).toEqual(["createdAt", "name", "scope"])
        expect(typeof entry.createdAt).toBe("number")
        expect(Object.keys(entry.scope)).toEqual(["profile"])
      }
      // Structural: the serialized manifest has no value-shaped content.
      const blob = JSON.stringify(manifest)
      expect(blob).not.toContain(CANARY)
      expect(blob).not.toContain(OTHER_SECRET)
    })
  )

  it.effect("secrets export as re-entry prompts, never plaintext", () =>
    Effect.gen(function* () {
      const { paths } = yield* makePaths()
      const outDir = path.join(paths.state, "export-bundle")
      yield* setupExported(outDir)

      const reenter = JSON.parse(yield* readUtf8(path.join(outDir, "secrets-to-reenter.json"))) as {
        secretCount: number
        secrets: Array<{ name: string; scope: { profile: string }; prompt: string }>
      }
      expect(reenter.secretCount).toBe(3)
      const names = reenter.secrets.map((s) => s.name).sort()
      expect(names).toEqual(["api/canary-token", "identity/instance-signing-key", "oauth/google"])
      for (const s of reenter.secrets) {
        expect(Object.keys(s).sort()).toEqual(["createdAt", "name", "prompt", "scope"])
        expect(s.prompt).toContain(s.name)
        expect(s.prompt).toContain(s.scope.profile)
        expect(s.prompt).not.toContain(CANARY)
      }
      expect(JSON.stringify(reenter)).not.toContain(CANARY)
      expect(JSON.stringify(reenter)).not.toContain(OTHER_SECRET)
    })
  )
})
