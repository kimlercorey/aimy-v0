/**
 * pins.test.ts — pins survive BYTE-IDENTICAL across every session transform
 * (Hermes #126167), and fail loudly when they don't.
 *
 * Transforms covered:
 *   (a) repeated compactions — pins survive the quarantine pipeline
 *   (b) session fork — synthetic continuation carries pins byte-identically
 *   (c) full context reassembly from the tree — the model-switch equivalent
 *       (serialize → parse → rebuild the prompt from scratch)
 * Plus: corruption is named by PinViolation; unpin is explicit and audited;
 * fitCheck fails loud on budget overflow.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  BudgetExceeded,
  Pin,
  PinError,
  PinViolation,
  activePins,
  cloneForSession,
  contentHash,
  emptyRegistry,
  fitCheck,
  pin,
  protectedIds,
  unpin,
  verifyPins,
} from "../pins.js"
import {
  SessionEntry,
  SessionTree,
  appendEntry,
  checkInvariants,
  emptyTree,
  fork,
  fromJsonl,
  toJsonl,
} from "../session-tree.js"
import { TokenUsage, accountUsage, stageCompaction, verifyStaged } from "../compaction.js"

const runSync = <A, E>(eff: Effect.Effect<A, E>): A => Effect.runSync(eff)
const runErr = <A, E>(eff: Effect.Effect<A, E>): E => Effect.runSync(Effect.flip(eff))

const usage: TokenUsage = accountUsage({ promptText: "p".repeat(400), completionText: "c".repeat(40) })

/** Build a deterministic linear tree of n message entries. */
const buildTree = (sessionId: string, n: number): { tree: SessionTree; ids: string[] } => {
  let current = emptyTree(sessionId)
  const ids: string[] = []
  let parent: string | null = null
  for (let i = 0; i < n; i++) {
    const result: { tree: SessionTree; entry: SessionEntry } = runSync(
      appendEntry(current, {
        parentId: parent,
        kind: "message",
        payload: { i, text: `entry ${i} — the quick brown fox jumps over the lazy dog` },
        ts: 1000 + i,
      }),
    )
    current = result.tree
    ids.push(result.entry.id)
    parent = result.entry.id
  }
  return { tree: current, ids }
}

/** Simulate one committed compaction (stage → verify → append the summary). */
const compactOnce = (tree: SessionTree, fromId: string, toId: string): SessionTree => {
  const staged = runSync(
    stageCompaction(tree, { fromId, toId }, (entries) => `summary of ${String(entries.length)}`, usage),
  )
  const verified = runSync(verifyStaged(tree, staged))
  const applied = runSync(
    appendEntry(tree, {
      parentId: verified.summaryInput.parentId,
      kind: "summary",
      payload: verified.summaryInput.payload as unknown as Readonly<Record<string, unknown>>,
      ts: 9000,
    }),
  )
  return applied.tree
}

describe("pin survival across transforms (Hermes #126167)", () => {
  it("(a) pins survive repeated compactions, byte-identical", () => {
    const { tree: t0, ids } = buildTree("s-pin-a", 12)
    let reg = emptyRegistry("s-pin-a")
    reg = runSync(pin(reg, t0, ids[2] as string, "system prompt"))
    reg = runSync(pin(reg, t0, ids[5] as string, "policy doc"))
    const pinnedHashes = new Map(activePins(reg).map((p: Pin) => [p.entryId, p.contentHash] as const))

    let tree = t0
    // three compaction rounds over the tail; pinned entries are mid-tree, never in the window
    for (let round = 0; round < 3; round++) {
      const tail = tree.entries.slice(-4)
      tree = compactOnce(tree, (tail[0] as SessionEntry).id, (tail[tail.length - 1] as SessionEntry).id)
      runSync(checkInvariants(tree))
      runSync(verifyPins(tree, reg))
      expect(protectedIds(reg)).toEqual(new Set([ids[2], ids[5]]))
    }
    // byte-identity: recomputed hashes match pin-time hashes exactly
    const index = new Map(tree.entries.map((e) => [e.id, e]))
    for (const [entryId, hash] of pinnedHashes) {
      expect(contentHash(index.get(entryId) as SessionEntry)).toBe(hash)
    }
  })

  it("(b) pins survive session fork (synthetic continuation)", () => {
    const { tree, ids } = buildTree("s-pin-b", 8)
    let reg = emptyRegistry("s-pin-b")
    reg = runSync(pin(reg, tree, ids[0] as string, "identity doc"))
    reg = runSync(pin(reg, tree, ids[7] as string, "user pin"))

    const forked = fork(tree, "s-pin-b-fork")
    expect(forked.sessionId).toBe("s-pin-b-fork")
    runSync(checkInvariants(forked))
    // pins are byte-identical in the fork (ids are content-derived, so they survive)
    runSync(verifyPins(forked, reg))
    // registry can be rehomed to the forked session without losing audit state
    const forkedReg = cloneForSession(reg, "s-pin-b-fork")
    expect(forkedReg.sessionId).toBe("s-pin-b-fork")
    expect(protectedIds(forkedReg)).toEqual(protectedIds(reg))
    runSync(verifyPins(forked, forkedReg))
  })

  it("(c) pins survive full context reassembly from the tree (model-switch equivalent)", () => {
    const { tree, ids } = buildTree("s-pin-c", 10)
    let reg = emptyRegistry("s-pin-c")
    reg = runSync(pin(reg, tree, ids[1] as string, "system prompt"))
    reg = runSync(pin(reg, tree, ids[4] as string, "policy doc"))

    // serialize → parse: the whole tree rebuilt from scratch, like a model switch
    const rebuilt = runSync(fromJsonl("s-pin-c", toJsonl(tree)))
    runSync(checkInvariants(rebuilt))
    runSync(verifyPins(rebuilt, reg))

    // rebuild the prompt from scratch: protected ids first, then the tail —
    // the pinned bytes are present byte-identically in the reassembled prompt
    const index = new Map(rebuilt.entries.map((e) => [e.id, e]))
    const prompt = [...protectedIds(reg)]
      .map((id) => JSON.stringify((index.get(id) as SessionEntry).payload))
      .join("\n")
    for (const p of activePins(reg)) {
      const original = index.get(p.entryId) as SessionEntry
      expect(prompt).toContain(JSON.stringify(original.payload))
      expect(contentHash(original)).toBe(p.contentHash)
    }
  })

  it("corrupted pinned bytes → PinViolation names the pin", () => {
    const { tree, ids } = buildTree("s-pin-corr", 6)
    let reg = emptyRegistry("s-pin-corr")
    reg = runSync(pin(reg, tree, ids[2] as string, "system prompt"))
    reg = runSync(pin(reg, tree, ids[4] as string, "policy doc"))

    // flip one byte of the second pinned entry's payload
    const tampered: SessionTree = {
      ...tree,
      entries: tree.entries.map((e) =>
        e.id === ids[4] ? { ...e, payload: { ...e.payload, text: "entry 4 — TAMPERED" } } : e,
      ),
    }
    const err = runErr(verifyPins(tampered, reg))
    expect(err).toBeInstanceOf(PinViolation)
    const violation = err as PinViolation
    expect(violation.pin.entryId).toBe(ids[4])
    expect(violation.pin.reason).toBe("policy doc")
    expect(violation.reason).toMatch(/bytes changed since pin time/)
  })

  it("dropped pinned entry → PinViolation names the missing pin", () => {
    const { tree, ids } = buildTree("s-pin-drop", 6)
    let reg = emptyRegistry("s-pin-drop")
    reg = runSync(pin(reg, tree, ids[3] as string, "system prompt"))
    // a tree that never carried the pinned entry (dropped across the transform)
    const partial = buildTree("s-pin-drop", 3)
    const err = runErr(verifyPins(partial.tree, reg))
    expect(err).toBeInstanceOf(PinViolation)
    expect((err as PinViolation).pin.entryId).toBe(ids[3])
    expect((err as PinViolation).reason).toMatch(/missing/)
  })
})

describe("unpin is explicit and audited", () => {
  it("unpin removes protection and appends a tombstone", () => {
    const { tree, ids } = buildTree("s-pin-u", 4)
    let reg = emptyRegistry("s-pin-u")
    reg = runSync(pin(reg, tree, ids[0] as string, "system prompt"))
    reg = runSync(pin(reg, tree, ids[1] as string, "user pin"))
    reg = runSync(unpin(reg, ids[0] as string, "user revoked the prompt override", 5000))

    expect(protectedIds(reg)).toEqual(new Set([ids[1]]))
    expect(reg.tombstones).toHaveLength(1)
    expect(reg.tombstones[0]).toMatchObject({
      entryId: ids[0],
      reason: "user revoked the prompt override",
      unpinnedAt: 5000,
    })
    // the released pin is no longer integrity-checked; the rest still is
    runSync(verifyPins(tree, reg))
  })

  it("unpin of a non-pinned entry fails; double pin fails", () => {
    const { tree, ids } = buildTree("s-pin-u2", 4)
    const reg = emptyRegistry("s-pin-u2")
    expect(runErr(unpin(reg, ids[0] as string, "nope"))._tag).toBe("PinError")
    const pinned = runSync(pin(reg, tree, ids[0] as string, "system prompt"))
    expect(runErr(pin(pinned, tree, ids[0] as string, "again"))._tag).toBe("PinError")
    expect(runErr(pin(pinned, tree, "missing-id", "x"))).toBeInstanceOf(PinError)
  })
})

describe("fitCheck fails loud (architecture §3.2)", () => {
  const blocks = (ids: string[], tokens: number) => ids.map((entryId) => ({ entryId, tokens }))

  it("fits → returns the plan, pins first", () => {
    const plan = runSync(
      fitCheck({ pins: blocks(["p1"], 100), tail: blocks(["t1", "t2"], 200), budget: 1000 }),
    )
    expect(plan.totalTokens).toBe(500)
    expect(plan.pins.map((b) => b.entryId)).toEqual(["p1"])
  })

  it("pins + tail over budget → typed BudgetExceeded, never a degraded context", () => {
    const err = runErr(fitCheck({ pins: blocks(["p1"], 600), tail: blocks(["t1"], 500), budget: 1000 }))
    expect(err).toBeInstanceOf(BudgetExceeded)
    const exceeded = err as BudgetExceeded
    expect(exceeded.needed).toBe(1100)
    expect(exceeded.budget).toBe(1000)
    expect(exceeded.pinnedTokens).toBe(600)
    expect(exceeded.tailTokens).toBe(500)
  })

  it("pins alone over budget → BudgetExceeded (no unpinned turn)", () => {
    const err = runErr(fitCheck({ pins: blocks(["p1"], 1200), tail: [], budget: 1000 }))
    expect(err).toBeInstanceOf(BudgetExceeded)
    expect((err as BudgetExceeded).needed).toBe(1200)
  })
})
