/**
 * session-tree.ts — JSONL session tree (pure core, no I/O).
 *
 * Architecture §3.1: sessions are append-only JSONL trees. Every entry carries
 * `id` + `parentId`; root-to-leaf paths are branches; the leaf defines the
 * active branch. Branching is implicit: appending with a non-leaf parentId
 * starts a new branch — history is never rewritten in place.
 *
 * Ids are content-fingerprinted (sha256 of parentId + payload + ts), per
 * Hermes #119668: list shifts can never delete or edit the wrong entry.
 *
 * Property-testable invariants (Pi #9930):
 *   - parentId chains are acyclic
 *   - exactly one leaf per branch (every root->leaf path ends in a leaf)
 *   - every entry's parent exists
 *   - compaction entries reference preserved originals (checked in compaction.ts)
 */
import { createHash } from "node:crypto"
import { Data, Effect } from "effect"

/** Typed error for tree-structure violations. */
export class SessionTreeError extends Data.TaggedError("SessionTreeError")<{
  readonly reason: string
  readonly entryId?: string
}> {}

/** Kinds of first-class session entries. `summary` is written only by compaction. */
export type EntryKind =
  | "message"
  | "tool-call"
  | "tool-result"
  | "checkpoint"
  | "metadata"
  | "summary"

export interface SessionEntry {
  readonly id: string
  readonly parentId: string | null
  readonly kind: EntryKind
  readonly payload: Readonly<Record<string, unknown>>
  readonly ts: number
}

export interface SessionTree {
  readonly version: 1
  readonly sessionId: string
  /** Append order. The tree is append-only: entries are never mutated or removed. */
  readonly entries: ReadonlyArray<SessionEntry>
}

export interface NewEntry {
  readonly parentId: string | null
  readonly kind: EntryKind
  readonly payload: Readonly<Record<string, unknown>>
  readonly ts?: number
}

/** Content-fingerprinted id: sha256(parentId || canonical payload || ts), hex, truncated. */
export const makeEntryId = (
  parentId: string | null,
  payload: Readonly<Record<string, unknown>>,
  ts: number,
): string =>
  createHash("sha256")
    .update(JSON.stringify({ parentId, payload, ts }))
    .digest("hex")
    .slice(0, 32)

const newTree = (sessionId: string): SessionTree => ({
  version: 1,
  sessionId,
  entries: [],
})

const byId = (tree: SessionTree): ReadonlyMap<string, SessionEntry> =>
  new Map(tree.entries.map((e) => [e.id, e]))

/**
 * Append one entry. Fails if the parent does not exist or would create a
 * cycle (defensive — a fresh id can never be an ancestor, but the check keeps
 * the invariant explicit and testable).
 */
export const appendEntry = (
  tree: SessionTree,
  input: NewEntry,
): Effect.Effect<{ tree: SessionTree; entry: SessionEntry }, SessionTreeError> =>
  Effect.gen(function* () {
    const ts = input.ts ?? Date.now()
    const entry: SessionEntry = {
      id: makeEntryId(input.parentId, input.payload, ts),
      parentId: input.parentId,
      kind: input.kind,
      payload: input.payload,
      ts,
    }
    const index = byId(tree)
    if (entry.parentId !== null && !index.has(entry.parentId)) {
      return yield* Effect.fail(
        new SessionTreeError({ reason: "parent entry does not exist", entryId: entry.parentId }),
      )
    }
    if (index.has(entry.id)) {
      return yield* Effect.fail(
        new SessionTreeError({ reason: "entry id already present (duplicate content)", entryId: entry.id }),
      )
    }
    return { tree: { ...tree, entries: [...tree.entries, entry] }, entry }
  })

/**
 * Continue from any point in history: resolves the branch head `fromId` to its
 * root-to-entry path. Branching is implicit on append — this just validates
 * the anchor and returns the path so callers can continue from it.
 */
export const branch = (
  tree: SessionTree,
  fromId: string,
): Effect.Effect<ReadonlyArray<SessionEntry>, SessionTreeError> =>
  Effect.flatMap(getBranch(tree, fromId), (path) =>
    path.length === 0
      ? Effect.fail(new SessionTreeError({ reason: "branch anchor does not exist", entryId: fromId }))
      : Effect.succeed(path),
  )

/** Clone history into a new session (deep copy; ids are content-derived, so they survive). */
export const fork = (tree: SessionTree, newSessionId: string): SessionTree => ({
  version: 1,
  sessionId: newSessionId,
  entries: structuredClone(tree.entries),
})

/**
 * Root-to-entry path for `entryId`. Terminates because chains are validated
 * acyclic; returns [] when the id is unknown.
 */
export const getBranch = (
  tree: SessionTree,
  entryId: string,
): Effect.Effect<ReadonlyArray<SessionEntry>, SessionTreeError> =>
  Effect.gen(function* () {
    const index = byId(tree)
    // NOTE (M9): built leaf-first with push + a single reverse. The previous
    // `unshift` per step made this O(depth²) per call and checkInvariants
    // O(n³) — the quarantine gate could not run on a 10k-entry session.
    // Order of the returned path is unchanged (root-to-entry).
    const path: SessionEntry[] = []
    const seen = new Set<string>()
    let cursor: string | null = entryId
    while (cursor !== null) {
      if (seen.has(cursor)) {
        return yield* Effect.fail(
          new SessionTreeError({ reason: "parentId cycle detected", entryId: cursor }),
        )
      }
      seen.add(cursor)
      const entry = index.get(cursor)
      if (entry === undefined) return path.reverse()
      path.push(entry)
      cursor = entry.parentId
    }
    return path.reverse()
  })

/** Entries with no children — the candidate heads of active branches. */
export const leaves = (tree: SessionTree): ReadonlyArray<SessionEntry> => {
  const parented = new Set(tree.entries.flatMap((e) => (e.parentId === null ? [] : [e.parentId])))
  return tree.entries.filter((e) => !parented.has(e.id))
}

/** Root entries (no parent) — a tree may have several after merges, but normally one. */
export const roots = (tree: SessionTree): ReadonlyArray<SessionEntry> =>
  tree.entries.filter((e) => e.parentId === null)

/**
 * Validate the tree invariants. Used after every mutation and by the
 * compaction quarantine gate before a session pointer advances.
 *
 * M9: single memoized pass, O(n). The previous per-entry getBranch loop was
 * O(n²) with a large constant (43s on a 10k-entry session) — the quarantine
 * gate could not run at production scale. Same checks, same error messages,
 * linear time.
 */
export const checkInvariants = (tree: SessionTree): Effect.Effect<void, SessionTreeError> =>
  Effect.gen(function* () {
    const index = byId(tree)
    // 1. every parent exists
    for (const e of tree.entries) {
      if (e.parentId !== null && !index.has(e.parentId)) {
        return yield* Effect.fail(
          new SessionTreeError({ reason: "entry references missing parent", entryId: e.id }),
        )
      }
    }
    // 2. acyclic, and every chain reaches a root. Each entry is walked at
    //    most once: once an id is known to reach a root, later walks stop
    //    there (amortized O(n) total).
    const reachesRoot = new Set<string>()
    for (const e of tree.entries) {
      let cursor: string | null = e.id
      const chain: string[] = []
      const seenLocal = new Set<string>()
      while (cursor !== null && !reachesRoot.has(cursor)) {
        if (seenLocal.has(cursor)) {
          return yield* Effect.fail(
            new SessionTreeError({ reason: "parentId cycle detected", entryId: cursor }),
          )
        }
        seenLocal.add(cursor)
        const node = index.get(cursor)
        if (node === undefined) {
          // unreachable: parents verified in step 1 — fail loudly, never silently
          return yield* Effect.fail(
            new SessionTreeError({ reason: "entry references missing parent", entryId: cursor }),
          )
        }
        chain.push(cursor)
        cursor = node.parentId
      }
      for (const id of chain) reachesRoot.add(id)
    }
    // 3. ids are content-fingerprinted: recompute and compare
    for (const e of tree.entries) {
      const expected = makeEntryId(e.parentId, e.payload, e.ts)
      if (expected !== e.id) {
        return yield* Effect.fail(
          new SessionTreeError({ reason: "entry id does not match content fingerprint", entryId: e.id }),
        )
      }
    }
  })

/** Empty tree for a session. Exported so persistence/service share one constructor. */
export const emptyTree = newTree

/** Serialize to JSONL (one entry per line). Tree envelope is line 0. */
export const toJsonl = (tree: SessionTree): string =>
  [JSON.stringify({ v: tree.version, sessionId: tree.sessionId }), ...tree.entries.map((e) => JSON.stringify(e))].join("\n") + "\n"

/** Parse JSONL back into a tree, validating invariants on load. */
export const fromJsonl = (sessionId: string, text: string): Effect.Effect<SessionTree, SessionTreeError> =>
  Effect.gen(function* () {
    const lines = text.split("\n").filter((l) => l.trim().length > 0)
    if (lines.length === 0) return newTree(sessionId)
    const first = lines[0] as string
    let header: { v?: number; sessionId?: string }
    try {
      header = JSON.parse(first) as { v?: number; sessionId?: string }
    } catch {
      return yield* Effect.fail(new SessionTreeError({ reason: "corrupt session file: bad header line" }))
    }
    if (header.v !== 1) {
      return yield* Effect.fail(new SessionTreeError({ reason: `unsupported session format v${String(header.v)}` }))
    }
    const entries: SessionEntry[] = []
    for (const line of lines.slice(1)) {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        return yield* Effect.fail(new SessionTreeError({ reason: "corrupt session file: bad entry line" }))
      }
      entries.push(raw as SessionEntry)
    }
    const tree: SessionTree = { version: 1, sessionId: header.sessionId ?? sessionId, entries }
    yield* checkInvariants(tree)
    return tree
  })
