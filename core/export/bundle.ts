/**
 * export/bundle.ts — bundle integrity: SHA-256 receipt + independent verifier.
 *
 * The one-click export (MUST #16) is verify-before-package:
 * - Every item is checksummed (SHA-256) BEFORE it is written to the bundle
 *   directory (`writeBundleFile` hashes the bytes, then writes).
 * - `manifest.json` (the integrity receipt) lists every file's hash plus a
 *   bundle-level hash, the export time, the instance id, and the exporter
 *   version.
 * - `verifyBundle(dir)` re-verifies the receipt INDEPENDENTLY: it re-reads
 *   everything from disk and recomputes every hash. It never trusts the
 *   packager's in-memory state — it doesn't even import the packager.
 *
 * Format decision (documented): a plain directory + `manifest.json`, NOT a
 * zip. Rationale: the bundle is human-inspectable and diffable (the
 * sovereignty thesis made visible); a zip is just this directory compressed,
 * and the user can compress it themselves. Zero dependencies either way.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"

import { ExportError } from "../substrate/errors.js"

export const EXPORTER_VERSION = "aimy-export/1.0.0"
export const RECEIPT_FILE_NAME = "manifest.json"
export const RECEIPT_VERSION = 1 as const

/** SHA-256 hex over a string (UTF-8) or raw bytes. */
export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex")

/**
 * Everything the bundle hash covers. `files` maps bundle-relative paths
 * (forward slashes) to SHA-256 hex digests.
 */
export interface ReceiptBody {
  readonly version: 1
  readonly exportedAt: string // ISO-8601 UTC
  readonly instanceId: string
  readonly exporterVersion: string
  readonly files: Readonly<Record<string, string>>
}

/** The integrity receipt, as written to `manifest.json`. */
export interface ExportReceipt extends ReceiptBody {
  readonly bundleHash: string
}

/**
 * Canonical serialization of the receipt body: file keys sorted, compact
 * JSON, fixed field order. The packager and the verifier must agree on this
 * byte-for-byte, or `bundleHash` mismatches are guaranteed.
 */
export const canonicalReceiptBody = (body: ReceiptBody): string => {
  const sorted = [...Object.keys(body.files)].sort()
  const files: Record<string, string> = {}
  for (const k of sorted) files[k] = body.files[k] as string
  return JSON.stringify({
    version: body.version,
    exportedAt: body.exportedAt,
    instanceId: body.instanceId,
    exporterVersion: body.exporterVersion,
    files
  })
}

/** The bundle-level hash: SHA-256 over the canonical receipt body. */
export const bundleHashFor = (body: ReceiptBody): string => sha256Hex(canonicalReceiptBody(body))

/** One packaged item: hashed before it was written. */
export interface BundleFile {
  readonly relPath: string
  readonly sha256: string
  readonly bytes: number
}

const fail = (reason: string): Effect.Effect<never, ExportError> =>
  Effect.fail(new ExportError({ reason }))

/**
 * Write one file into the bundle directory. The content is hashed BEFORE
 * writing (verify-before-package); the returned digest is what goes into
 * the receipt.
 */
export const writeBundleFile = (
  outDir: string,
  relPath: string,
  content: string
): Effect.Effect<BundleFile, ExportError> =>
  Effect.gen(function* () {
    const sha256 = sha256Hex(content)
    const bytes = Buffer.byteLength(content, "utf-8")
    const target = path.join(outDir, ...relPath.split("/"))
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, "utf-8")
      },
      catch: () => new ExportError({ reason: `export:write-failed:${relPath}` })
    })
    return { relPath, sha256, bytes }
  })

const listFilesRecursive = (dir: string): Effect.Effect<ReadonlyArray<string>, ExportError> =>
  Effect.tryPromise({
    try: async () => {
      const out: Array<string> = []
      const walk = async (current: string, prefix: string): Promise<void> => {
        const entries = await fs.readdir(current, { withFileTypes: true })
        for (const e of entries) {
          const rel = prefix === "" ? e.name : `${prefix}/${e.name}`
          if (e.isDirectory()) await walk(path.join(current, e.name), rel)
          else if (e.isFile()) out.push(rel)
        }
      }
      await walk(dir, "")
      return [...out].sort()
    },
    catch: () => new ExportError({ reason: "export:bundle-list-failed" })
  })

const isReceiptBody = (raw: unknown): raw is ReceiptBody => {
  if (typeof raw !== "object" || raw === null) return false
  const r = raw as Record<string, unknown>
  if (r["version"] !== RECEIPT_VERSION) return false
  if (typeof r["exportedAt"] !== "string") return false
  if (typeof r["instanceId"] !== "string") return false
  if (typeof r["exporterVersion"] !== "string") return false
  const files = r["files"]
  if (typeof files !== "object" || files === null) return false
  for (const v of Object.values(files as Record<string, unknown>)) {
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) return false
  }
  return true
}

/**
 * Independently verify a bundle directory against its own receipt.
 * Re-reads `manifest.json` and every listed file from disk, recomputes all
 * hashes, and checks:
 * - the receipt parses and is structurally valid;
 * - every listed file exists and matches its recorded hash;
 * - no unexpected extra files are present;
 * - the bundle-level hash matches the recomputed one.
 *
 * Failures are typed `ExportError`s. This function shares no state with the
 * packager — verification is from disk, or it isn't verification.
 */
export const verifyBundle = (dir: string): Effect.Effect<ExportReceipt, ExportError> =>
  Effect.gen(function* () {
    const receiptPath = path.join(dir, RECEIPT_FILE_NAME)
    const rawText: string = yield* Effect.tryPromise({
      try: () => fs.readFile(receiptPath, "utf-8"),
      catch: () => new ExportError({ reason: "export:receipt-unreadable" })
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText) as unknown
    } catch {
      return yield* fail("export:receipt-invalid")
    }
    if (!isReceiptBody(parsed)) {
      return yield* fail("export:receipt-invalid")
    }
    const receipt = parsed as ExportReceipt
    if (typeof (parsed as { bundleHash?: unknown }).bundleHash !== "string") {
      return yield* fail("export:receipt-invalid")
    }

    // Every listed file: re-read from disk, recompute, compare.
    for (const relPath of Object.keys(receipt.files).sort()) {
      // A receipt is self-consistent, not authenticated: never let a listed
      // path escape the bundle directory, even from a hand-written receipt.
      if (relPath.startsWith("/") || relPath.split("/").includes("..")) {
        return yield* fail(`export:receipt-invalid-path:${relPath}`)
      }
      const expected = receipt.files[relPath] as string
      const bytes: Uint8Array = yield* Effect.tryPromise({
        try: () => fs.readFile(path.join(dir, ...relPath.split("/"))),
        catch: () => new ExportError({ reason: `export:file-missing:${relPath}` })
      })
      const actual = sha256Hex(bytes)
      if (actual !== expected) {
        return yield* fail(`export:file-hash-mismatch:${relPath}`)
      }
    }

    // No unexpected extra files: the receipt enumerates the bundle exactly.
    const actualFiles = yield* listFilesRecursive(dir)
    for (const f of actualFiles) {
      if (f === RECEIPT_FILE_NAME) continue
      if (receipt.files[f] === undefined) {
        return yield* fail(`export:unexpected-file:${f}`)
      }
    }

    // Bundle-level hash over the canonical body.
    const body: ReceiptBody = {
      version: receipt.version,
      exportedAt: receipt.exportedAt,
      instanceId: receipt.instanceId,
      exporterVersion: receipt.exporterVersion,
      files: receipt.files
    }
    if (bundleHashFor(body) !== receipt.bundleHash) {
      return yield* fail("export:bundle-hash-mismatch")
    }
    return receipt
  })
