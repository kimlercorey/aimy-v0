/**
 * compaction.test.ts — compaction preserves originals, references them, and
 * quarantines unverified output.
 *
 * Covers: summary entry references preserved originals; originals still in the
 * tree; invariants hold post-compaction; quarantine rejects unverified or
 * inconsistent staged output; reasoning-token accounting labels estimates.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  CompactionError,
  TokenUsage,
  accountUsage,
  commitCompaction,
  compactBranch,
  estimateTokens,
  stageCompaction,
  verifyStaged,
} from "../compaction.js"
import { SessionEntry, checkInvariants, getBranch } from "../session-tree.js"
import { AllowAllGate, MemoryPaths, MemoryService, MemoryServiceLive, resolveMemoryDirs } from "../service.js"

const tmpRoots: string[] = []
const layer = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-cmp-test-"))
  tmpRoots.push(dir)
  const base = resolveMemoryDirs()
  const paths = Layer.succeed(MemoryPaths, {
    ...base,
    sessionsDir: path.join(dir, "sessions"),
    storesDir: path.join(dir, "stores"),
  })
  return Layer.provide(MemoryServiceLive, Layer.mergeAll(AllowAllGate, paths))
})()
afterEach(() => {
  // keep the tmp dir for the whole file (sessions accumulate across tests is fine)
})

// The layer provides exactly MemoryService (and cannot fail at build),
// so after provide the requirement channel is empty. The cast bridges the
// generic R, which TypeScript cannot narrow through Effect.provide.
const runP = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)

const summarize = (entries: ReadonlyArray<SessionEntry>): string =>
  `summary of ${String(entries.length)} entries: ${entries.map((e) => e.kind).join(",")}`

const usage: TokenUsage = accountUsage({ promptText: "p".repeat(400), completionText: "c".repeat(40) })

const seedSession = async (sessionId: string, n: number): Promise<string[]> => {
  const mem = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))
  const ids: string[] = []
  let parent: string | null = null
  for (let i = 0; i < n; i++) {
    const e: SessionEntry = await runP(mem.append(sessionId, { parentId: parent, kind: "message", payload: { i } }))
    ids.push(e.id)
    parent = e.id
  }
  return ids
}

describe("compactBranch", () => {
  it("summary references preserved originals; originals untouched; invariants hold", async () => {
    const ids = await seedSession("cmp-1", 5)
    const mem = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))

    const summary = await runP(
      compactBranch("cmp-1", { fromId: ids[0] as string, toId: ids[2] as string }, summarize, usage),
    )
    expect(summary.kind).toBe("summary")
    const payload = summary.payload as unknown as { references: string[]; window: unknown; usage: TokenUsage }
    expect(payload.references).toEqual([ids[0], ids[1], ids[2]])
    expect(summary.parentId).toBe(ids[2])

    const tree = await runP(mem.read("cmp-1"))
    // originals preserved: 5 originals + 1 summary
    expect(tree.entries).toHaveLength(6)
    const idSet = new Set(tree.entries.map((e) => e.id))
    for (const id of ids) expect(idSet.has(id)).toBe(true)
    // invariants hold (read already validates, but assert explicitly)
    Effect.runSync(checkInvariants(tree))
    // summary is the leaf of the compacted branch
    const path = Effect.runSync(getBranch(tree, summary.id))
    expect(path[path.length - 1]?.id).toBe(summary.id)
  })

  it("compacting a sub-window mid-branch keeps the tail reachable", async () => {
    const ids = await seedSession("cmp-2", 4)
    const mem = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))
    await runP(compactBranch("cmp-2", { fromId: ids[0] as string, toId: ids[1] as string }, summarize, usage))
    const tree = await runP(mem.read("cmp-2"))
    // tail entry (ids[3]) still walks to the root through the summary
    const path = Effect.runSync(getBranch(tree, ids[3] as string))
    expect(path[0]?.id).toBe(ids[0])
    expect(path.map((e) => e.id)).toContain(ids[3])
  })
})

describe("quarantine", () => {
  it("commitCompaction refuses unverified staged output", async () => {
    await seedSession("cmp-q1", 2)
    const mem = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))
    const tree = await runP(mem.read("cmp-q1"))
    const staged = Effect.runSync(
      stageCompaction(tree, { fromId: tree.entries[0]?.id as string, toId: tree.entries[1]?.id as string }, summarize, usage),
    )
    expect(staged.verified).toBe(false)
    const err = await Effect.runPromise(
      Effect.flip(Effect.provide(commitCompaction(staged), layer)),
    )
    expect(err).toBeInstanceOf(CompactionError)
    expect((err as CompactionError).reason).toContain("unverified")
    // and nothing was appended
    expect((await runP(mem.read("cmp-q1"))).entries).toHaveLength(2)
  })

  it("verifyStaged rejects a candidate with the wrong entry count", async () => {
    await seedSession("cmp-q2", 2)
    const mem = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))
    const tree = await runP(mem.read("cmp-q2"))
    const staged = Effect.runSync(
      stageCompaction(tree, { fromId: tree.entries[0]?.id as string, toId: tree.entries[1]?.id as string }, summarize, usage),
    )
    const tampered = {
      ...staged,
      candidateTree: { ...staged.candidateTree, entries: [...staged.candidateTree.entries, ...staged.candidateTree.entries] },
    }
    const err = Effect.runSync(Effect.flip(verifyStaged(tree, tampered)))
    expect(err._tag).toBe("SessionTreeError")
  })

  it("stageCompaction rejects a window start that is not on the anchor branch", async () => {
    await seedSession("cmp-q3", 3)
    const mem = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))
    const tree = await runP(mem.read("cmp-q3"))
    // fork a side branch, then try to window from the side branch onto the main line
    const side = Effect.runSync(
      (await import("../session-tree.js")).appendEntry(tree, {
        parentId: tree.entries[0]?.id as string,
        kind: "message",
        payload: { side: true },
        ts: 999,
      }),
    )
    const err = Effect.runSync(
      Effect.flip(
        stageCompaction(side.tree, { fromId: side.entry.id, toId: tree.entries[2]?.id as string }, summarize, usage),
      ),
    )
    expect(err._tag).toBe("SessionTreeError")
  })
})

describe("reasoning-token-aware accounting (Pi #9409)", () => {
  it("reported reasoning tokens are used as-is", () => {
    const u = accountUsage({ promptText: "x".repeat(400), completionText: "y".repeat(40), reportedReasoningTokens: 7 })
    expect(u.reasoningTokens).toBe(7)
    expect(u.estimatedReasoning).toBe(false)
  })

  it("unreported reasoning tokens fall back to a LABELED conservative estimate", () => {
    const u = accountUsage({ promptText: "x".repeat(400), completionText: "y".repeat(40) })
    expect(u.estimatedReasoning).toBe(true)
    expect(u.reasoningTokens).toBeGreaterThan(0)
    expect(u.reasoningTokens).toBe(u.completionTokens * 2)
  })

  it("estimateTokens never claims to measure", () => {
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("")).toBe(0)
  })
})
