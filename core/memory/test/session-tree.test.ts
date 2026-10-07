/**
 * session-tree.test.ts — property-style tests over randomized operation sequences.
 *
 * Pi #9930: parentId chains acyclic, exactly one leaf per branch, every parent
 * exists. After EVERY random op we assert the full invariant set.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  SessionEntry,
  SessionTree,
  appendEntry,
  branch,
  checkInvariants,
  emptyTree,
  fork,
  fromJsonl,
  getBranch,
  leaves,
  makeEntryId,
  toJsonl,
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

describe("content-fingerprinted ids", () => {
  it("same content -> same id", () => {
    const a = makeEntryId("p1", { text: "hello" }, 1000)
    const b = makeEntryId("p1", { text: "hello" }, 1000)
    expect(a).toBe(b)
  })

  it("tampered parent -> different id", () => {
    const a = makeEntryId("p1", { text: "hello" }, 1000)
    const b = makeEntryId("p2", { text: "hello" }, 1000)
    expect(a).not.toBe(b)
  })

  it("tampered payload/ts -> different id", () => {
    const a = makeEntryId("p1", { text: "hello" }, 1000)
    expect(makeEntryId("p1", { text: "HELLO" }, 1000)).not.toBe(a)
    expect(makeEntryId("p1", { text: "hello" }, 1001)).not.toBe(a)
  })

  it("duplicate content append is rejected", () => {
    let tree = emptyTree("s")
    const input = { parentId: null, kind: "message" as const, payload: { t: 1 }, ts: 42 }
    const r1 = runSync(appendEntry(tree, input))
    tree = r1.tree
    const r2 = Effect.runSync(Effect.flip(appendEntry(tree, input)))
    expect(r2._tag).toBe("SessionTreeError")
  })

  it("append to missing parent is rejected", () => {
    const tree = emptyTree("s")
    const err = Effect.runSync(
      Effect.flip(appendEntry(tree, { parentId: "nope", kind: "message", payload: {}, ts: 1 })),
    )
    expect(err._tag).toBe("SessionTreeError")
  })
})

describe("generative: invariants hold over random op sequences", () => {
  const SEEDS = 40
  const OPS = 120

  for (let seed = 0; seed < SEEDS; seed++) {
    it(`seed ${seed}: acyclic + parent-exists + single-leaf after every op`, () => {
      const rand = mulberry32(seed)
      let tree: SessionTree = emptyTree(`gen-${seed}`)
      let counter = 0

      for (let op = 0; op < OPS; op++) {
        // 15% new root, else attach to a random existing entry (branching is implicit)
        const existing = tree.entries
        const parentId =
          existing.length === 0 || rand() < 0.15
            ? null
            : (existing[Math.floor(rand() * existing.length)] as SessionEntry).id
        const kinds = ["message", "tool-call", "tool-result", "checkpoint", "metadata"] as const
        const kind = kinds[Math.floor(rand() * kinds.length)] as SessionEntry["kind"]
        const res = runSync(
          appendEntry(tree, { parentId, kind, payload: { n: counter, r: rand() }, ts: counter }),
        )
        tree = res.tree
        counter++

        // full invariant check after EVERY op
        runSync(checkInvariants(tree))

        // exactly one leaf per branch: every entry lies on some root->leaf
        // branch (no orphaned subtrees), and every leaf's path reaches a root
        const leafIds = new Set(leaves(tree).map((l) => l.id))
        expect(leafIds.size).toBeGreaterThan(0)
        const branchPaths = [...leafIds].map((id) => runSync(getBranch(tree, id)))
        for (const bp of branchPaths) {
          expect(bp.length).toBeGreaterThan(0)
          expect(bp[0]?.parentId).toBeNull() // leaf path reaches a root
          const tip = bp[bp.length - 1] as SessionEntry
          expect(leafIds.has(tip.id)).toBe(true) // branch ends in exactly one leaf
        }
        const covered = new Set(branchPaths.flatMap((bp) => bp.map((e) => e.id)))
        for (const e of tree.entries) {
          expect(covered.has(e.id), `entry ${e.id} orphaned from every branch`).toBe(true)
        }
      }
    })
  }
})

describe("branch / fork / serialization", () => {
  const buildTree = (): { tree: SessionTree; ids: string[] } => {
    let tree = emptyTree("s")
    const ids: string[] = []
    const step = (parentId: string | null): string => {
      const r = runSync(appendEntry(tree, { parentId, kind: "message", payload: { x: ids.length }, ts: ids.length }))
      tree = r.tree
      ids.push(r.entry.id)
      return r.entry.id
    }
    const a = step(null)
    const b = step(a)
    step(b) // main line
    step(a) // implicit branch off a
    return { tree, ids }
  }

  it("branch() returns the root-to-anchor path", () => {
    const { tree, ids } = buildTree()
    const anchor = ids[1] as string
    const p = runSync(branch(tree, anchor))
    expect(p.map((e) => e.id)).toEqual([ids[0], ids[1]])
  })

  it("fork() clones history under a new session id", () => {
    const { tree } = buildTree()
    const clone = fork(tree, "s2")
    expect(clone.sessionId).toBe("s2")
    expect(clone.entries.map((e) => e.id)).toEqual(tree.entries.map((e) => e.id))
    runSync(checkInvariants(clone))
  })

  it("toJsonl/fromJsonl round-trips and validates", () => {
    const { tree } = buildTree()
    const back = runSync(fromJsonl("s", toJsonl(tree)))
    expect(back.entries.map((e) => e.id)).toEqual(tree.entries.map((e) => e.id))
  })

  it("fromJsonl rejects a tampered payload (fingerprint mismatch)", () => {
    const { tree } = buildTree()
    const lines = toJsonl(tree).split("\n")
    const entryLine = JSON.parse(lines[1] as string) as Record<string, unknown>
    entryLine["payload"] = { tampered: true }
    lines[1] = JSON.stringify(entryLine)
    const err = Effect.runSync(Effect.flip(fromJsonl("s", lines.join("\n"))))
    expect(err._tag).toBe("SessionTreeError")
  })
})
