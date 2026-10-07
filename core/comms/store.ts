/**
 * comms/store.ts — the append-only persistent banner log.
 *
 * Ground truth: architecture §1.2 (XDG base dirs respected from day one) and
 * the M7 spec — banners survive restarts via a persistent log namespaced by
 * the install UUID. The log is the audit trail: dismissal and expiry are
 * RECORDED here, never deleted.
 *
 * Format: one JSON object per line (`banner-log.jsonl`), `v: 1` records.
 * Replay is fail-closed: a corrupt line is a typed `BannerLogError`, never
 * silently skipped (mirrors identity's corrupt-id rule).
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"

import type { AimyPaths } from "../substrate/config.js"
import { BannerLogError } from "./errors.js"
import type { BannerLogRecord } from "./types.js"

/** File name of the log inside `<state>/<instanceId>/comms/`. */
export const BANNER_LOG_FILE_NAME = "banner-log.jsonl"

/** The append-only log backend. */
export interface BannerLogStoreShape {
  /** Append one record. */
  readonly append: (record: BannerLogRecord) => Effect.Effect<void, BannerLogError>
  /** Read the full log, in append order. */
  readonly readAll: () => Effect.Effect<ReadonlyArray<BannerLogRecord>, BannerLogError>
}

/** instanceIds namespace the log directory: reject path traversal, fail closed. */
const sanitizeInstanceId = (instanceId: string): Effect.Effect<string, BannerLogError> =>
  instanceId === "" || instanceId.includes("/") || instanceId.includes("\\") || instanceId.includes("..")
    ? Effect.fail(new BannerLogError({ reason: `invalid instance id for banner log namespacing: ${instanceId}` }))
    : Effect.succeed(instanceId)

const logFileFor = (paths: AimyPaths, instanceId: string): string =>
  path.join(paths.state, instanceId, "comms", BANNER_LOG_FILE_NAME)

const ensureDir = (file: string): Effect.Effect<void, BannerLogError> =>
  Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }),
    catch: () => new BannerLogError({ reason: "banner log directory unwritable" }),
  })

const parseLine = (line: string, lineNo: number): Effect.Effect<BannerLogRecord, BannerLogError> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== "object" || parsed === null || (parsed as { v?: unknown }).v !== 1) {
        throw new Error("not a v1 banner log record")
      }
      return parsed as BannerLogRecord
    },
    catch: () => new BannerLogError({ reason: `banner log corrupt at line ${lineNo}` }),
  })

/**
 * File-backed store: `<XDG state>/<instanceId>/comms/banner-log.jsonl`.
 * Appends are atomic-enough single writes; reads replay the whole file.
 */
export const FileBannerLogStore = (paths: AimyPaths, instanceId: string): BannerLogStoreShape => {
  const fileEffect = Effect.gen(function* () {
    const safe = yield* sanitizeInstanceId(instanceId)
    return logFileFor(paths, safe)
  })
  return {
    append: (record) =>
      Effect.gen(function* () {
        const file = yield* fileEffect
        yield* ensureDir(file)
        const line = `${JSON.stringify(record)}\n`
        yield* Effect.tryPromise({
          try: () => fs.appendFile(file, line, { mode: 0o600 }),
          catch: () => new BannerLogError({ reason: "banner log append failed" }),
        })
      }),
    readAll: () =>
      Effect.gen(function* () {
        const file = yield* fileEffect
        const raw = yield* Effect.tryPromise({
          try: () =>
            fs.readFile(file, "utf-8").catch((cause: unknown) => {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ""
              throw cause
            }),
          catch: () => new BannerLogError({ reason: "banner log unreadable" }),
        })
        const lines = raw.split("\n").filter((l) => l.trim() !== "")
        const records: Array<BannerLogRecord> = []
        for (let i = 0; i < lines.length; i++) {
          records.push(yield* parseLine(lines[i] as string, i + 1))
        }
        return records as ReadonlyArray<BannerLogRecord>
      }),
  }
}

/** In-memory store for tests. Same append/readAll contract, no I/O. */
export const InMemoryBannerLogStore = (): BannerLogStoreShape & {
  readonly records: () => Effect.Effect<ReadonlyArray<BannerLogRecord>>
} => {
  const records: Array<BannerLogRecord> = []
  return {
    append: (record) => Effect.sync(() => void records.push(structuredClone(record))),
    readAll: () => Effect.sync(() => records.map((r) => structuredClone(r)) as ReadonlyArray<BannerLogRecord>),
    records: () => Effect.sync(() => records.map((r) => structuredClone(r)) as ReadonlyArray<BannerLogRecord>),
  }
}
