/**
 * export/export.ts — DataExport: the one-click full export (MUST #16).
 *
 * A COMPOSED CAPABILITY, not a service and not a backdoor reader: a single
 * Effect program that walks the real services through their PUBLIC
 * interfaces only —
 * - `IdentityService` → the versioned, secret-free identity document;
 * - `MemoryService` → every session tree (`listSessions` + `read`) and
 *   every kv namespace (`listKeys` + `get`);
 * - `ModuleHost` → installed module records (`installedModules`, including
 *   capability manifests, staged/previous versions, trust decisions) and
 *   the skill index (`skillIndex`);
 * - `LearningTimeline` → the full learning timeline (`query`, archived
 *   nodes included);
 * - `SecretLocker` → the MANIFEST ONLY (`manifest()`): entry names, scopes,
 *   created-at — never values. Secrets export as re-entry prompts.
 *
 * Locker discipline is structural: this module never calls `retrieve` or
 * `store`, and the only locker API it touches is `manifest()`. There is no
 * code path in this module that can observe a secret value — the type of
 * `SecretManifestEntry` has no value field to read.
 *
 * Every item is checksummed (SHA-256) BEFORE packaging: `writeBundleFile`
 * hashes the bytes first, then writes. The bundle closes with `manifest.json`
 * (see bundle.ts); `verifyBundle` re-verifies it independently.
 */
import { Effect } from "effect"

import { ExportError } from "../substrate/errors.js"
import { IdentityService } from "../identity/identity.js"
import { SecretLocker } from "../identity/locker.js"
import { LearningTimeline } from "../learning/src/timeline.js"
import { KV_NAMESPACES, MemoryService, type KvNamespace } from "../memory/service.js"
import { toJsonl } from "../memory/session-tree.js"
import { ModuleHost } from "../module-seam/src/host.js"
import {
  EXPORTER_VERSION,
  RECEIPT_FILE_NAME,
  RECEIPT_VERSION,
  bundleHashFor,
  writeBundleFile,
  type BundleFile,
  type ExportReceipt,
  type ReceiptBody
} from "./bundle.js"

export interface ExportOptions {
  /** Bundle directory to write (created if missing). */
  readonly outDir: string
}

/**
 * Optional banner-log source. The CommsBanner channel (MUST #15) owns its own
 * log format; this seam lets the export include it without the export
 * depending on the banner service. When absent, the banner section is
 * simply omitted from the bundle.
 */
export interface BannerLogProvider {
  /** Bundle-relative path, e.g. "banner/banner-log.json". */
  readonly bundlePath: string
  /** The log content. Must be JSON-serializable. */
  readonly readLog: () => Effect.Effect<unknown, ExportError>
}

export interface ExportSummary {
  readonly outDir: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly receipt: ExportReceipt
}

type ExportDeps = IdentityService | MemoryService | SecretLocker | ModuleHost | LearningTimeline

const step = <A, E extends { readonly _tag: string }>(name: string, eff: Effect.Effect<A, E>): Effect.Effect<A, ExportError> =>
  Effect.mapError(eff, (e) => new ExportError({ reason: `export:${name}:${e._tag}` }))

const toJson = (value: unknown): Effect.Effect<string, ExportError> =>
  Effect.try({
    try: () => {
      const text = JSON.stringify(value, null, 2)
      if (text === undefined) throw new Error("unserializable")
      return text + "\n"
    },
    catch: () => new ExportError({ reason: "export:unserializable-payload" })
  })

/**
 * Run the one-click export. Requires the five sovereign services as layers;
 * writes the bundle directory and returns the summary (including the
 * in-memory receipt — note `verifyBundle` never trusts this copy; it
 * re-reads from disk).
 */
export const exportData = (
  options: ExportOptions,
  banner?: BannerLogProvider
): Effect.Effect<ExportSummary, ExportError, ExportDeps> =>
  Effect.gen(function* () {
    const identity = yield* IdentityService
    const memory = yield* MemoryService
    const locker = yield* SecretLocker
    const host = yield* ModuleHost
    const timeline = yield* LearningTimeline

    const files: Array<BundleFile> = []
    const pack = (relPath: string, content: string): Effect.Effect<void, ExportError> =>
      Effect.asVoid(Effect.tap(writeBundleFile(options.outDir, relPath, content), (f) => Effect.sync(() => { files.push(f) })))

    // 1. Identity: the versioned, secret-free identity document.
    yield* pack("identity/identity.json", yield* toJson(identity.document))

    // 2. Memory: every session tree + every kv namespace, via the service.
    const sessionIds = yield* step("memory:list-sessions", memory.listSessions())
    for (const sessionId of sessionIds) {
      const tree = yield* step(`memory:read-session`, memory.read(sessionId))
      yield* pack(`memory/sessions/${sessionId}.jsonl`, toJsonl(tree))
    }
    const namespaces: ReadonlyArray<KvNamespace> = KV_NAMESPACES
    for (const ns of namespaces) {
      const keys = yield* step(`memory:list-keys:${ns}`, memory.listKeys(ns))
      const entries: Array<{ readonly key: string; readonly value: unknown }> = []
      for (const key of keys) {
        const value = yield* step(`memory:get:${ns}`, memory.get(ns, key))
        entries.push({ key, value })
      }
      yield* pack(`memory/stores/${ns}.json`, yield* toJson({ namespace: ns, entries }))
    }

    // 3. Learning timeline: every node, archived ones included.
    const nodes = yield* step("timeline:query", timeline.query({ includeArchived: true }))
    yield* pack("timeline/timeline.json", yield* toJson({ nodeCount: nodes.length, nodes }))

    // 4. Modules: installed records (manifests, staged/previous, trust
    //    decisions) + the budget-capped skill index.
    const modules = yield* step("modules:list", host.installedModules())
    yield* pack("modules/modules.json", yield* toJson({ moduleCount: modules.length, modules }))
    const skillIndex = yield* step("modules:skill-index", host.skillIndex())
    yield* pack("skills/skill-index.json", yield* toJson(skillIndex))

    // 5. Locker manifest ONLY — names, scopes, created-at. Never values.
    const manifest = yield* step("locker:manifest", locker.manifest())
    yield* pack(
      "locker/locker-manifest.json",
      yield* toJson({ entryCount: manifest.length, entries: manifest })
    )
    // Secrets travel as re-entry prompts, never plaintext.
    const reenter = manifest.map((entry) => ({
      name: entry.name,
      scope: entry.scope,
      createdAt: entry.createdAt,
      prompt: `Re-enter the secret '${entry.name}' (profile '${entry.scope.profile}') on the new instance. The value was never exported; only this reminder travels with the bundle.`
    }))
    yield* pack("secrets-to-reenter.json", yield* toJson({ secretCount: reenter.length, secrets: reenter }))

    // 6. Banner log, only when a provider is wired in.
    if (banner !== undefined) {
      const log = yield* banner.readLog()
      yield* pack(banner.bundlePath, yield* toJson(log))
    }

    // 7. Integrity receipt, written last. Hashes were computed BEFORE each
    //    file was packaged (writeBundleFile hashes, then writes).
    const body: ReceiptBody = {
      version: RECEIPT_VERSION,
      exportedAt: new Date().toISOString(),
      instanceId: identity.instanceId,
      exporterVersion: EXPORTER_VERSION,
      files: Object.fromEntries(files.map((f) => [f.relPath, f.sha256]))
    }
    const receipt: ExportReceipt = { ...body, bundleHash: bundleHashFor(body) }
    const receiptFile = yield* writeBundleFile(options.outDir, RECEIPT_FILE_NAME, yield* toJson(receipt))

    const totalBytes = files.reduce((n, f) => n + f.bytes, 0) + receiptFile.bytes
    return {
      outDir: options.outDir,
      fileCount: files.length,
      totalBytes,
      receipt
    }
  })
