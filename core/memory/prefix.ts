/**
 * prefix.ts — cache-prefix-stable compaction (Track A, M9).
 *
 * Architecture §3.9 / Hermes #130909: compaction must not break the prompt
 * cache every cycle — a cache break per compaction is a silent cost multiplier.
 * Mechanism: frozen prefix snapshots + stable prefix ordering.
 *
 * The cache-prefix contract:
 *   - snapshotPrefix() captures the frozen prefix: the ordered list of
 *     protected entry ids + their content hashes (sha256 of canonical
 *     payload). This IS the contract Track B's PinRegistry protects.
 *   - verifyPrefixStable() is the byte-identity check across a compaction;
 *     any divergence is a typed error naming the entry.
 *   - stageCompactionProtected() is the fail-closed staging path: a window
 *     containing protected ids is REJECTED (ProtectedInWindow) — pinned/policy
 *     content is never summarized away (Hermes #126167: pins survive every
 *     transform).
 *   - the summary entry is always APPENDED (never inserted), so the prefix
 *     byte order is untouched.
 *
 * SEAM CONTRACT: protected content is communicated as ReadonlySet<string> of
 * entry ids. Track B's PinRegistry produces that set; no Pin type is defined
 * here. This module never touches compaction.ts / session-tree.ts signatures.
 */
import { createHash } from "node:crypto"
import { Data, Effect } from "effect"
import {
  CompactionWindow,
  StagedCompaction,
  TokenUsage,
  stageCompaction,
} from "./compaction.js"
import {
  SessionEntry,
  SessionTree,
  SessionTreeError,
  getBranch,
} from "./session-tree.js"

/** A compaction window contained a protected (pinned/policy) entry id.
 *  Fail-closed: pinned content is never summarized away. */
export class ProtectedInWindow extends Data.TaggedError("ProtectedInWindow")<{
  readonly sessionId: string
  readonly entryId: string
}> {}

/** The frozen prefix diverged across a compaction. Names the offending entry. */
export class PrefixDivergence extends Data.TaggedError("PrefixDivergence")<{
  readonly entryId: string | null
  readonly reason: string
}> {}

export type PrefixError = ProtectedInWindow | PrefixDivergence

/** The frozen prefix: ordered protected entry ids + their content hashes. */
export interface PrefixSnapshot {
  readonly entryIds: ReadonlyArray<string>
  readonly contentHashes: ReadonlyArray<string>
}

/** sha256 of the canonical payload — the content fingerprint for the prefix contract. */
const contentHash = (entry: SessionEntry): string =>
  createHash("sha256").update(JSON.stringify(entry.payload)).digest("hex")

/**
 * Capture the frozen prefix: protected entry ids in tree (append) order plus
 * their content hashes. The order IS the contract — prompt caches key on
 * prefix byte order, so this is the byte-identity baseline compaction is
 * measured against.
 */
export const snapshotPrefix = (
  tree: SessionTree,
  protectedIds: ReadonlySet<string>,
): PrefixSnapshot => {
  const entryIds: string[] = []
  const contentHashes: string[] = []
  for (const entry of tree.entries) {
    if (protectedIds.has(entry.id)) {
      entryIds.push(entry.id)
      contentHashes.push(contentHash(entry))
    }
  }
  return { entryIds, contentHashes }
}

/**
 * Byte-identity check of the frozen prefix across a compaction. Checks, in
 * order: same length, same ids in the same positions, same content hashes.
 * Any divergence is a typed error naming the entry — never a silent mismatch.
 */
export const verifyPrefixStable = (
  before: PrefixSnapshot,
  after: PrefixSnapshot,
): Effect.Effect<void, PrefixDivergence> =>
  Effect.gen(function* () {
    if (before.entryIds.length !== after.entryIds.length) {
      return yield* Effect.fail(
        new PrefixDivergence({
          entryId: null,
          reason:
            `prefix length changed across compaction: ` +
            `${String(before.entryIds.length)} -> ${String(after.entryIds.length)}`,
        }),
      )
    }
    for (let i = 0; i < before.entryIds.length; i++) {
      const id = before.entryIds[i] as string
      if (after.entryIds[i] !== id) {
        return yield* Effect.fail(
          new PrefixDivergence({
            entryId: id,
            reason: `prefix order changed at position ${String(i)}: expected ${id}, found ${String(after.entryIds[i])}`,
          }),
        )
      }
      if (after.contentHashes[i] !== before.contentHashes[i]) {
        return yield* Effect.fail(
          new PrefixDivergence({ entryId: id, reason: "protected entry content hash changed across compaction" }),
        )
      }
    }
  })

/**
 * Prefix-aware staging: like stageCompaction, but fail-closed against the
 * protected set. A window containing ANY protected id is rejected BEFORE the
 * summarizer runs — pinned/policy content is never summarized away
 * (Hermes #126167). The existing stageCompaction signature is untouched.
 */
export const stageCompactionProtected = (
  tree: SessionTree,
  window: CompactionWindow,
  summarize: (entries: ReadonlyArray<SessionEntry>) => string,
  usage: TokenUsage,
  protectedIds: ReadonlySet<string>,
): Effect.Effect<StagedCompaction, ProtectedInWindow | SessionTreeError> =>
  Effect.gen(function* () {
    const branchPath = yield* getBranch(tree, window.toId)
    const fromIdx = branchPath.findIndex((e) => e.id === window.fromId)
    if (fromIdx === -1) {
      return yield* Effect.fail(
        new SessionTreeError({ reason: "compaction window start not on the anchor branch", entryId: window.fromId }),
      )
    }
    for (const entry of branchPath.slice(fromIdx)) {
      if (protectedIds.has(entry.id)) {
        return yield* Effect.fail(
          new ProtectedInWindow({ sessionId: tree.sessionId, entryId: entry.id }),
        )
      }
    }
    return yield* stageCompaction(tree, window, summarize, usage)
  })

/**
 * Simulated cache-hit metric: fraction of frozen-prefix entries byte-identical
 * (id + content hash, in order) across the compaction. 1.0 when the prefix is
 * protected — the demo reports this per compaction. A vacuous (empty) prefix
 * scores 1.0.
 */
export const measureCacheHitRate = (before: PrefixSnapshot, after: PrefixSnapshot): number => {
  if (before.entryIds.length === 0) return 1.0
  let matched = 0
  const n = Math.min(before.entryIds.length, after.entryIds.length)
  for (let i = 0; i < n; i++) {
    if (after.entryIds[i] === before.entryIds[i] && after.contentHashes[i] === before.contentHashes[i]) {
      matched++
    }
  }
  return matched / before.entryIds.length
}
