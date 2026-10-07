/**
 * persistence.ts — file-trio discipline for the memory backend.
 *
 * Hermes #119668 adopted as a service-implementation invariant (arch §3.2):
 *   1. Cross-process lock  — lockfile with stale-lock detection (dead pid or
 *      age past the TTL is broken, never waited on forever).
 *   2. Drift guard         — write temp + fsync + atomic rename + read-back
 *      verify. On a failed round-trip: refuse, restore from `.bak`, fail typed.
 *   3. Content-fingerprinted ids — enforced in session-tree.ts; list shifts
 *      can never delete or edit the wrong entry.
 *
 * All memory file I/O belongs to MemoryService (service.ts); this module only
 * exposes the primitives the service uses. Nothing else in the codebase should
 * import this module directly.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Data, Effect } from "effect"

/** Typed error for every persistence failure. Wrapped as MemoryStoreError at the service layer. */
export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly path: string
  readonly reason: string
}> {}

const fail = (p: string, reason: string) => Effect.fail(new PersistenceError({ path: p, reason }))

/**
 * Effect v4 note: `Effect.promise` turns a rejected promise into an uncatchable
 * defect. This helper keeps rejections on the failure channel so `Effect.catch`
 * / `Effect.mapError` can handle them.
 */
const tryRaw = <A>(thunk: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: thunk, catch: (e) => e })

export const LOCK_TTL_MS = 30_000

interface LockRecord {
  readonly pid: number
  readonly ts: number
}

const lockPathFor = (targetPath: string) => `${targetPath}.lock`
const bakPathFor = (targetPath: string) => `${targetPath}.bak`

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readLock = (lockPath: string): Effect.Effect<LockRecord | null, PersistenceError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const raw = await fs.promises.readFile(lockPath, "utf8")
        return JSON.parse(raw) as LockRecord
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw e
      }
    },
    catch: (e) => new PersistenceError({ path: lockPath, reason: `cannot read lockfile: ${String(e)}` }),
  })

/**
 * Run `op` while holding an exclusive cross-process lock on `targetPath`.
 * Stale locks (holder pid dead, or older than LOCK_TTL_MS) are broken.
 * Fail-fast when another live process holds the lock — the caller decides
 * whether to retry.
 */
export const withFileLock = <A, E, R>(
  targetPath: string,
  op: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PersistenceError, R> => {
  const lockPath = lockPathFor(targetPath)
  const record: LockRecord = { pid: process.pid, ts: Date.now() }
  // NOTE (Effect v4): try/catch inside Effect.gen does NOT catch yielded
  // failures, so the EEXIST path is handled with Effect.catch instead.
  const acquire: Effect.Effect<void, PersistenceError> = tryRaw(() =>
    fs.promises.writeFile(lockPath, JSON.stringify(record), { flag: "wx", mode: 0o600 }),
  ).pipe(
    Effect.asVoid,
    Effect.catch((e: unknown) =>
      Effect.gen(function* () {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          return yield* fail(lockPath, `cannot create lockfile: ${String(e)}`)
        }
        const existing = yield* readLock(lockPath)
        if (existing === null) return yield* acquire // raced with a release; retry
        const stale = !pidAlive(existing.pid) || Date.now() - existing.ts > LOCK_TTL_MS
        if (!stale) {
          return yield* fail(targetPath, `locked by live process ${String(existing.pid)}`)
        }
        yield* tryRaw(() => fs.promises.unlink(lockPath)).pipe(
          Effect.catch(() => Effect.void),
        )
        return yield* acquire
      }),
    ),
  )
  const release = tryRaw(() => fs.promises.unlink(lockPath)).pipe(
    Effect.catch(() => Effect.void),
  )
  const ensureDir = tryRaw(() => fs.promises.mkdir(path.dirname(targetPath), { recursive: true })).pipe(
    Effect.mapError(
      (e) => new PersistenceError({ path: targetPath, reason: `cannot create parent directory: ${String(e)}` }),
    ),
  )
  return Effect.flatMap(ensureDir, () =>
    Effect.scoped(Effect.acquireRelease(acquire, () => release).pipe(Effect.andThen(op))),
  )
}

/** sha256 fingerprint of bytes, used for the read-back drift check. */
export const fingerprint = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex")

/**
 * Drift-guarded write: temp file in the same directory + fsync + atomic
 * rename + read-back verify. On verification failure the previous content is
 * restored from `.bak` and the write is refused (typed error, never a
 * half-written file).
 *
 * Fault injection for tests: `fault: "before-rename"` simulates a crash after
 * the temp file is synced but before the rename — the original file must be
 * untouched and no error is raised by the simulation itself (it just returns
 * without renaming, as a killed process would).
 */
export const atomicWrite = (
  targetPath: string,
  content: string | Uint8Array,
  opts?: { readonly fault?: "before-rename" },
): Effect.Effect<void, PersistenceError> =>
  Effect.gen(function* () {
    const dir = path.dirname(targetPath)
    yield* tryRaw(() => fs.promises.mkdir(dir, { recursive: true })).pipe(
      Effect.mapError((e) => new PersistenceError({ path: dir, reason: `cannot create directory: ${String(e)}` })),
    )
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content)
    const expected = fingerprint(bytes)
    const tmpPath = `${targetPath}.tmp.${String(process.pid)}`

    // 1. preserve a rollback copy of the current file, if any
    const hadPrevious = yield* tryRaw(() =>
      fs.promises
        .access(targetPath)
        .then(() => true)
        .catch(() => false),
    ).pipe(Effect.catch(() => Effect.succeed(false)))
    if (hadPrevious) {
      yield* tryRaw(() => fs.promises.copyFile(targetPath, bakPathFor(targetPath))).pipe(
        Effect.mapError((e) => new PersistenceError({ path: targetPath, reason: `cannot snapshot .bak: ${String(e)}` })),
      )
    }

    // 2. write temp + fsync (durable before the rename)
    const fh = yield* Effect.tryPromise({
      try: () => fs.promises.open(tmpPath, "w", 0o600),
      catch: (e) => new PersistenceError({ path: tmpPath, reason: `cannot open temp file: ${String(e)}` }),
    })
    const written = yield* Effect.scoped(
      Effect.acquireRelease(Effect.succeed(fh), (h) =>
        tryRaw(() => h.close()).pipe(Effect.catch(() => Effect.void)),
      ).pipe(
        Effect.flatMap((h) =>
          Effect.tryPromise({
            try: async () => {
              await h.writeFile(bytes)
              await h.sync()
            },
            catch: (e) => new PersistenceError({ path: tmpPath, reason: `temp write/fsync failed: ${String(e)}` }),
          }),
        ),
      ),
    )
    void written

    if (opts?.fault === "before-rename") {
      // simulated crash: leave the temp file, do not rename, do not clean up
      return
    }

    // 3. atomic rename
    yield* Effect.tryPromise({
      try: () => fs.promises.rename(tmpPath, targetPath),
      catch: (e) => new PersistenceError({ path: targetPath, reason: `atomic rename failed: ${String(e)}` }),
    })

    // 4. read-back verify; on drift, restore from .bak and refuse
    const actual = yield* Effect.tryPromise({
      try: async () => fingerprint(await fs.promises.readFile(targetPath)),
      catch: (e) => new PersistenceError({ path: targetPath, reason: `read-back failed: ${String(e)}` }),
    })
    if (actual !== expected) {
      if (hadPrevious) {
        yield* tryRaw(() => fs.promises.copyFile(bakPathFor(targetPath), targetPath)).pipe(
          Effect.catch(() => Effect.void),
        )
      } else {
        yield* tryRaw(() => fs.promises.unlink(targetPath)).pipe(
          Effect.catch(() => Effect.void),
        )
      }
      return yield* fail(targetPath, "drift detected: read-back fingerprint mismatch, restored previous content")
    }
  }).pipe(Effect.asVoid)

/** Read a UTF-8 text file; missing file reads as empty string (not an error). */
export const readText = (filePath: string): Effect.Effect<string, PersistenceError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await fs.promises.readFile(filePath, "utf8")
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""
        throw e
      }
    },
    catch: (e) => new PersistenceError({ path: filePath, reason: `cannot read file: ${String(e)}` }),
  })

/** Read a JSONL file as its non-blank lines. Corrupt lines are the caller's concern. */
export const readJsonlLines = (filePath: string): Effect.Effect<ReadonlyArray<string>, PersistenceError> =>
  Effect.map(readText(filePath), (text) => text.split("\n").filter((l) => l.trim().length > 0))

/**
 * Append one JSONL line under the file-trio discipline: the whole file is
 * read, the line appended in memory, and the file rewritten via atomicWrite —
 * all under the cross-process lock. Append-only at the format level even
 * though the write is a full-file rewrite at the OS level.
 */
export const appendJsonlLine = (filePath: string, line: string): Effect.Effect<void, PersistenceError> =>
  withFileLock(filePath, Effect.gen(function* () {
    const text = yield* readText(filePath)
    const next = text.length === 0 ? `${line}\n` : text.endsWith("\n") ? `${text}${line}\n` : `${text}\n${line}\n`
    yield* atomicWrite(filePath, next)
  }))

/** Full-file rewrite under lock + drift guard (used for session trees). */
export const writeWholeFile = (filePath: string, content: string): Effect.Effect<void, PersistenceError> =>
  withFileLock(filePath, atomicWrite(filePath, content))

/** Delete a file if it exists (used by tests / future eviction paths). */
export const removeFile = (filePath: string): Effect.Effect<void, PersistenceError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await fs.promises.unlink(filePath)
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
      }
      for (const suffix of [".lock", ".bak"]) {
        try {
          await fs.promises.unlink(`${filePath}${suffix}`)
        } catch {
          /* best effort */
        }
      }
    },
    catch: (e) => new PersistenceError({ path: filePath, reason: `cannot remove file: ${String(e)}` }),
  })
