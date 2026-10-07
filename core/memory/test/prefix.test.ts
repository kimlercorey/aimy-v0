/**
 * prefix.test.ts — cache-prefix-stable compaction (Track A, M9).
 *
 * Covers: protected id in window -> ProtectedInWindow (fail-closed);
 * prefix byte-identical across 50 randomized compactions; summary entry always
 * APPENDED, never inserted (prefix byte order untouched); verifyPrefixStable
 * names the diverging entry; measureCacheHitRate == 1.0 with protection.
 *
 * Architecture §3.9 / Hermes #130909: a cache break per compaction is a silent
 * cost multiplier. Hermes #126167: pins survive every transform.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  PrefixDivergence,
  ProtectedInWindow,
  measureCacheHitRate,
  snapshotPrefix,
  stageCompactionProtected,
  verifyPrefixStable,
} from "../prefix.js"
import { TokenUsage, accountUsage } from "../compaction.js"
import {
  SessionEntry,
  SessionTree,
  appendEntry,
  emptyTree,
} from "../session-tree.js"

/** Deterministic PRNG (mulberry32) so failures reproduce from the seed. */
const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const runSync = <A, E>(eff: Effect.Effect<A, E>): A => Effect.runSync(eff)

/** Build a linear-chain tree with deterministic ids (explicit ts). */
const buildChain = (sessionId: string, n: number, tsBase: number): { tree: SessionTree; ids: string[] } => {
  let tree = emptyTree(sessionId)
  const ids: string[] = []
  let parent: string | null = null
  for (let i = 0; i < n; i++) {
    const res: { tree: SessionTree; entry: SessionEntry } = runSync(
      appendEntry(tree, { parentId: parent, kind: "message", payload: { i, text: `entry-${String(i)}` }, ts: tsBase + i }),
    )
    tree = res.tree
    ids.push(res.entry.id)
    parent = res.entry.id
  }
  return { tree, ids }
}

const usage: TokenUsage = accountUsage({ promptText: "p".repeat(400), completionText: "c".repeat(40) })
const summarize = (entries: ReadonlyArray<SessionEntry>): string =>
  `summary of ${String(entries.length)} entries`

describe("stageCompactionProtected fails closed on protected ids", () => {
  it("protected id in window -> ProtectedInWindow naming the entry", () => {
    const { tree, ids } = buildChain("s", 8, 1000)
    const protectedIds = new Set([ids[2] as string])
    const eff = stageCompactionProtected(
      tree,
      { fromId: ids[1] as string, toId: ids[5] as string },
      summarize,
      usage,
      protectedIds,
    )
    try {
      runSync(eff)
      expect.unreachable("expected ProtectedInWindow")
    } catch (err) {
      expect(err).toBeInstanceOf(ProtectedInWindow)
      const e = err as ProtectedInWindow
      expect(e._tag).toBe("ProtectedInWindow")
      expect(e.entryId).toBe(ids[2])
      expect(e.sessionId).toBe("s")
    }
  })

  it("window after the protected range stages fine", () => {
    const { tree, ids } = buildChain("s", 8, 1000)
    const protectedIds = new Set([ids[0] as string, ids[1] as string])
    const staged = runSync(
      stageCompactionProtected(
        tree,
        { fromId: ids[4] as string, toId: ids[7] as string },
        summarize,
        usage,
        protectedIds,
      ),
    )
    expect(staged.summaryEntry.kind).toBe("summary")
  })

  it("the summary entry is APPENDED, never inserted — prefix byte order untouched", () => {
    const { tree, ids } = buildChain("s", 8, 1000)
    const protectedIds = new Set([ids[0] as string])
    const staged = runSync(
      stageCompactionProtected(
        tree,
        { fromId: ids[4] as string, toId: ids[7] as string },
        summarize,
        usage,
        protectedIds,
      ),
    )
    const candidate = staged.candidateTree
    expect(candidate.entries.length).toBe(tree.entries.length + 1)
    // every original entry keeps its exact position; the summary is last
    for (let i = 0; i < tree.entries.length; i++) {
      expect(candidate.entries[i]).toStrictEqual(tree.entries[i])
    }
    const last = candidate.entries[candidate.entries.length - 1] as SessionEntry
    expect(last.id).toBe(staged.summaryEntry.id)
    expect(last.kind).toBe("summary")
  })
})

describe("prefix snapshot and stability", () => {
  it("snapshot captures protected ids in tree order with content hashes", () => {
    const { tree, ids } = buildChain("s", 6, 1000)
    const protectedIds = new Set([ids[4] as string, ids[1] as string])
    const snap = snapshotPrefix(tree, protectedIds)
    // tree (append) order, not set order
    expect(snap.entryIds).toStrictEqual([ids[1], ids[4]])
    expect(snap.contentHashes).toHaveLength(2)
    expect(snap.contentHashes[0]).not.toBe(snap.contentHashes[1])
  })

  it("empty protected set -> empty snapshot, hit rate 1.0", () => {
    const { tree } = buildChain("s", 4, 1000)
    const snap = snapshotPrefix(tree, new Set())
    expect(snap.entryIds).toHaveLength(0)
    expect(measureCacheHitRate(snap, snap)).toBe(1.0)
  })
})

describe("verifyPrefixStable names divergence", () => {
  it("hash change -> PrefixDivergence naming the entry", () => {
    const { tree, ids } = buildChain("s", 5, 1000)
    const protectedIds = new Set([ids[0] as string, ids[3] as string])
    const before = snapshotPrefix(tree, protectedIds)
    const after = { ...before, contentHashes: [before.contentHashes[0], "tampered"] as ReadonlyArray<string> }
    try {
      runSync(verifyPrefixStable(before, after))
      expect.unreachable("expected PrefixDivergence")
    } catch (err) {
      expect(err).toBeInstanceOf(PrefixDivergence)
      expect((err as PrefixDivergence).entryId).toBe(ids[3])
    }
  })

  it("order change -> PrefixDivergence naming the entry", () => {
    const { tree, ids } = buildChain("s", 5, 1000)
    const protectedIds = new Set([ids[0] as string, ids[3] as string])
    const before = snapshotPrefix(tree, protectedIds)
    const after = {
      entryIds: [ids[3], ids[0]] as ReadonlyArray<string>,
      contentHashes: [before.contentHashes[1], before.contentHashes[0]] as ReadonlyArray<string>,
    }
    try {
      runSync(verifyPrefixStable(before, after))
      expect.unreachable("expected PrefixDivergence")
    } catch (err) {
      expect((err as PrefixDivergence).entryId).toBe(ids[0])
    }
  })

  it("length change -> PrefixDivergence", () => {
    const { tree, ids } = buildChain("s", 5, 1000)
    const protectedIds = new Set([ids[0] as string])
    const before = snapshotPrefix(tree, protectedIds)
    const after = snapshotPrefix(tree, new Set())
    try {
      runSync(verifyPrefixStable(before, after))
      expect.unreachable("expected PrefixDivergence")
    } catch (err) {
      expect(err).toBeInstanceOf(PrefixDivergence)
      expect((err as PrefixDivergence).entryId).toBeNull()
    }
  })
})

describe("prefix byte-identical across 50 randomized compactions (Hermes #130909)", () => {
  it("protected prefix never diverges; cache-hit rate stays 1.0", () => {
    for (let iter = 0; iter < 50; iter++) {
      const rand = mulberry32(9000 + iter)
      const n = 8 + Math.floor(rand() * 8) // 8..15 entries
      const { tree, ids } = buildChain(`s-${String(iter)}`, n, iter * 100_000)
      // protect the first 3 entries — they must never be summarized away
      const protectedIds = new Set<string>([ids[0] as string, ids[1] as string, ids[2] as string])
      const before = snapshotPrefix(tree, protectedIds)

      // random window strictly after the protected range
      const fromIdx = 3 + Math.floor(rand() * (n - 4))
      const toIdx = fromIdx + 1 + Math.floor(rand() * (n - 1 - fromIdx))
      const staged = runSync(
        stageCompactionProtected(
          tree,
          { fromId: ids[fromIdx] as string, toId: ids[toIdx] as string },
          summarize,
          usage,
          protectedIds,
        ),
      )
      const afterTree = staged.candidateTree
      const after = snapshotPrefix(afterTree, protectedIds)

      // byte-identity: no divergence, in order, hashes intact
      runSync(verifyPrefixStable(before, after))
      expect(measureCacheHitRate(before, after)).toBe(1.0)

      // summary appended, originals untouched in place
      expect(afterTree.entries.length).toBe(tree.entries.length + 1)
      for (let i = 0; i < tree.entries.length; i++) {
        expect(afterTree.entries[i]).toStrictEqual(tree.entries[i])
      }
    }
  })
})
