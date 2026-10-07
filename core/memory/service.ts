/**
 * service.ts — MemoryService, the sole reader/writer of every memory store.
 *
 * Architecture §3.2 / §3.4: memory is a backend interface, never direct file
 * reads (Hermes #47349); every memory operation passes a permission gate from
 * day one (Hermes #34352). All file I/O lives inside this service — modules,
 * the learning loop, the UI, and export all go through it.
 *
 * The PermissionGate is a Context.Service dependency injected into the service
 * layer. The real SafetyKernel wires the production gate in later; this module
 * ships AllowAllGate and DenyAllGate test layers that prove the gate is
 * actually consulted on every operation.
 */
import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { MemoryStoreError, PermissionDenied } from "./errors-shim.js"
import { resolvePaths } from "../substrate/config.js"
import {
  PersistenceError,
  appendJsonlLine,
  readText,
  writeWholeFile,
} from "./persistence.js"
import {
  NewEntry,
  SessionEntry,
  SessionTree,
  appendEntry,
  emptyTree,
  fork as forkTree,
  fromJsonl,
  getBranch,
  toJsonl,
} from "./session-tree.js"

/** Namespaced key-value stores (§3.2): one fact, one store. */
export type KvNamespace = "profile" | "environment" | "skills"
export const KV_NAMESPACES: ReadonlyArray<KvNamespace> = ["profile", "environment", "skills"]

/**
 * PermissionGate — injected dependency. The production SafetyKernel provides
 * the real implementation; tests use AllowAllGate / DenyAllGate.
 */
export interface PermissionGateShape {
  readonly checkMemory: (op: "read" | "write", store: string) => Effect.Effect<void, PermissionDenied>
}
export class PermissionGate extends Context.Service<PermissionGate, PermissionGateShape>()(
  "aimy/memory/PermissionGate",
) {}

/** Test layer: allows every memory operation. */
export const AllowAllGate: Layer.Layer<PermissionGate> = Layer.succeed(PermissionGate, {
  checkMemory: () => Effect.void,
})

/** Test layer: denies every memory operation. Proves the gate is consulted. */
export const DenyAllGate: Layer.Layer<PermissionGate> = Layer.succeed(PermissionGate, {
  // Canonical PermissionDenied shape (substrate contract): memory reads are
  // T0 (local read), writes are T1 (local write).
  checkMemory: (op, store) =>
    Effect.fail(
      new PermissionDenied({
        tool: `memory:${store}:${op}`,
        tier: op === "read" ? "T0" : "T1",
        reason: "denied by DenyAllGate",
      }),
    ),
})

/**
 * The on-disk directories memory actually uses. Derived from the substrate
 * path layout at integration: `<state>/memory/sessions` and
 * `<state>/memory/stores`. Injectable so tests can point at a temp dir.
 */
export interface MemoryDirs {
  readonly sessionsDir: string
  readonly storesDir: string
}

/** Resolve memory directories from the canonical AImy path layout. */
export const resolveMemoryDirs = (): MemoryDirs => {
  const base = resolvePaths()
  const memoryDir = path.join(base.state, "memory")
  return {
    sessionsDir: path.join(memoryDir, "sessions"),
    storesDir: path.join(memoryDir, "stores"),
  }
}

/** Resolved on-disk paths, injectable so tests can point at a temp dir. */
export class MemoryPaths extends Context.Service<MemoryPaths, MemoryDirs>()("aimy/memory/MemoryPaths") {}
export const MemoryPathsLive: Layer.Layer<MemoryPaths> = Layer.succeed(MemoryPaths, resolveMemoryDirs())

export type MemoryOpError = MemoryStoreError | PermissionDenied

const sessionStoreName = (sessionId: string) => `session:${sessionId}`
const kvStoreName = (ns: KvNamespace) => `kv:${ns}`

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const checkSessionId = (sessionId: string): Effect.Effect<void, MemoryStoreError> =>
  SESSION_ID_RE.test(sessionId)
    ? Effect.void
    : Effect.fail(new MemoryStoreError({ store: sessionId, reason: "invalid session id" }))

const sessionFile = (paths: MemoryDirs, sessionId: string) =>
  path.join(paths.sessionsDir, `${sessionId}.jsonl`)
const kvFile = (paths: MemoryDirs, ns: KvNamespace) => path.join(paths.storesDir, `${ns}.jsonl`)

interface KvLine {
  readonly key: string
  readonly value: unknown
  readonly v: number
  readonly ts: number
}

/** The service interface. Every method consults the PermissionGate first. */
export interface MemoryServiceShape {
  readonly append: (
    sessionId: string,
    input: NewEntry,
  ) => Effect.Effect<SessionEntry, MemoryOpError>
  readonly read: (sessionId: string) => Effect.Effect<SessionTree, MemoryOpError>
  /** Resolve the branch anchored at `fromId` (root-to-anchor path). */
  readonly branch: (sessionId: string, fromId: string) => Effect.Effect<ReadonlyArray<SessionEntry>, MemoryOpError>
  /** Clone a session's history into a new session id. */
  readonly fork: (sessionId: string, newSessionId: string) => Effect.Effect<void, MemoryOpError>
  readonly get: (ns: KvNamespace, key: string) => Effect.Effect<unknown, MemoryOpError>
  readonly set: (ns: KvNamespace, key: string, value: unknown) => Effect.Effect<void, MemoryOpError>
  /**
   * Enumerate known session ids (sorted). The read API export (MUST #16)
   * needs to walk every session tree without bypassing the service.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<string>, MemoryOpError>
  /** Enumerate keys in a kv namespace (sorted). Same rationale as `listSessions`. */
  readonly listKeys: (ns: KvNamespace) => Effect.Effect<ReadonlyArray<string>, MemoryOpError>
}

export class MemoryService extends Context.Service<MemoryService, MemoryServiceShape>()(
  "aimy/memory/MemoryService",
) {}

const toStoreError = (store: string) => (e: { readonly _tag: string; readonly reason: string }) =>
  new MemoryStoreError({ store, reason: `${e._tag}: ${e.reason}` })

/** Live implementation. Requires PermissionGate + MemoryPaths. */
export const MemoryServiceLive: Layer.Layer<MemoryService, never, PermissionGate | MemoryPaths> =
  Layer.effect(
    MemoryService,
    Effect.gen(function* () {
      const gate = yield* PermissionGate
      const paths = yield* MemoryPaths

      const loadTree = (sessionId: string): Effect.Effect<SessionTree, MemoryStoreError> =>
        Effect.gen(function* () {
          yield* checkSessionId(sessionId)
          const text = yield* readText(sessionFile(paths, sessionId)).pipe(
            Effect.mapError((e) => new MemoryStoreError({ store: sessionStoreName(sessionId), reason: e.reason })),
          )
          return yield* fromJsonl(sessionId, text).pipe(
            Effect.mapError(toStoreError(sessionStoreName(sessionId))),
          )
        })

      const readKvLines = (ns: KvNamespace): Effect.Effect<ReadonlyArray<KvLine>, MemoryStoreError> =>
        Effect.gen(function* () {
          const text = yield* readText(kvFile(paths, ns)).pipe(
            Effect.mapError((e) => new MemoryStoreError({ store: kvStoreName(ns), reason: e.reason })),
          )
          const lines: KvLine[] = []
          for (const raw of text.split("\n")) {
            if (raw.trim().length === 0) continue
            let parsed: unknown
            try {
              parsed = JSON.parse(raw)
            } catch {
              return yield* Effect.fail(
                new MemoryStoreError({ store: kvStoreName(ns), reason: "corrupt kv line" }),
              )
            }
            const rec = parsed as Partial<KvLine>
            if (typeof rec.key !== "string" || typeof rec.v !== "number") {
              return yield* Effect.fail(
                new MemoryStoreError({ store: kvStoreName(ns), reason: "malformed kv line" }),
              )
            }
            lines.push({ key: rec.key, value: rec.value, v: rec.v, ts: typeof rec.ts === "number" ? rec.ts : 0 })
          }
          return lines
        })

      const append: MemoryServiceShape["append"] = (sessionId, input) =>
        Effect.gen(function* () {
          yield* gate.checkMemory("write", sessionStoreName(sessionId))
          const tree = yield* loadTree(sessionId)
          const { tree: next, entry } = yield* appendEntry(tree, input).pipe(
            Effect.mapError(toStoreError(sessionStoreName(sessionId))),
          )
          yield* writeWholeFile(sessionFile(paths, sessionId), toJsonl(next)).pipe(
            Effect.mapError((e) =>
              new MemoryStoreError({ store: sessionStoreName(sessionId), reason: e.reason }),
            ),
          )
          return entry
        })

      const read: MemoryServiceShape["read"] = (sessionId) =>
        Effect.gen(function* () {
          yield* gate.checkMemory("read", sessionStoreName(sessionId))
          return yield* loadTree(sessionId)
        })

      const branch: MemoryServiceShape["branch"] = (sessionId, fromId) =>
        Effect.gen(function* () {
          yield* gate.checkMemory("read", sessionStoreName(sessionId))
          const tree = yield* loadTree(sessionId)
          return yield* getBranch(tree, fromId).pipe(
            Effect.flatMap((p) =>
              p.length === 0
                ? Effect.fail(
                    new MemoryStoreError({ store: sessionStoreName(sessionId), reason: `unknown entry ${fromId}` }),
                  )
                : Effect.succeed(p),
            ),
            Effect.mapError((e) =>
              e instanceof MemoryStoreError ? e : toStoreError(sessionStoreName(sessionId))(e),
            ),
          )
        })

      const fork: MemoryServiceShape["fork"] = (sessionId, newSessionId) =>
        Effect.gen(function* () {
          yield* gate.checkMemory("read", sessionStoreName(sessionId))
          yield* gate.checkMemory("write", sessionStoreName(newSessionId))
          yield* checkSessionId(newSessionId)
          const tree = yield* loadTree(sessionId)
          const clone = forkTree(tree, newSessionId)
          yield* writeWholeFile(sessionFile(paths, newSessionId), toJsonl(clone)).pipe(
            Effect.mapError((e) =>
              new MemoryStoreError({ store: sessionStoreName(newSessionId), reason: e.reason }),
            ),
          )
        })

      const get: MemoryServiceShape["get"] = (ns, key) =>
        Effect.gen(function* () {
          yield* gate.checkMemory("read", kvStoreName(ns))
          const lines = yield* readKvLines(ns)
          let found: KvLine | undefined
          for (const l of lines) if (l.key === key) found = l
          return found?.value
        })

      const set: MemoryServiceShape["set"] = (ns, key, value) =>
        Effect.gen(function* () {
          yield* gate.checkMemory("write", kvStoreName(ns))
          const lines = yield* readKvLines(ns)
          let v = 0
          for (const l of lines) if (l.key === key && l.v > v) v = l.v
          const line: KvLine = { key, value, v: v + 1, ts: Date.now() }
          yield* appendJsonlLine(kvFile(paths, ns), JSON.stringify(line)).pipe(
            Effect.mapError((e) => new MemoryStoreError({ store: kvStoreName(ns), reason: e.reason })),
          )
        })

      const listSessions: MemoryServiceShape["listSessions"] = () =>
        Effect.gen(function* () {
          yield* gate.checkMemory("read", "sessions:index")
          const names = yield* Effect.tryPromise({
            try: () =>
              fs.readdir(paths.sessionsDir).catch((cause: unknown) => {
                if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [] as Array<string>
                throw cause
              }),
            catch: () => new MemoryStoreError({ store: "sessions:index", reason: "session index unreadable" }),
          })
          const ids = names
            .filter((n) => n.endsWith(".jsonl"))
            .map((n) => n.slice(0, -".jsonl".length))
            .filter((id) => SESSION_ID_RE.test(id))
          return [...ids].sort()
        })

      const listKeys: MemoryServiceShape["listKeys"] = (ns) =>
        Effect.gen(function* () {
          yield* gate.checkMemory("read", kvStoreName(ns))
          const lines = yield* readKvLines(ns)
          const seen = new Set<string>()
          for (const l of lines) seen.add(l.key)
          return [...seen].sort()
        })

      return MemoryService.of({ append, read, branch, fork, get, set, listSessions, listKeys })
    }),
  )

/** Convenience: the full test stack — live service over AllowAllGate + real paths. */
export const MemoryTestLayers = {
  allowAll: Layer.provide(MemoryServiceLive, Layer.mergeAll(AllowAllGate, MemoryPathsLive)),
  denyAll: Layer.provide(MemoryServiceLive, Layer.mergeAll(DenyAllGate, MemoryPathsLive)),
}

// Re-export tree types that callers legitimately need alongside the service
// (they operate on in-memory values, not files).
export { emptyTree }
export type { NewEntry, SessionEntry, SessionTree }
