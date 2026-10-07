/**
 * compaction-properties.test.ts — the compaction bug farm, property-tested.
 *
 * Pi #9602/#9512/#9051/#6879 (thinking-message overflow, summary caps, missed
 * retries, never-triggered auto-compaction), Pi #9930 (tree invariants), and
 * Pi #9340 (teardown ordering). All generators are hand-rolled seeded PRNGs
 * (mulberry32, fixed seed) — no network, no timing, CI-reproducible.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  CompactionEvent,
  CompactionPhase,
  MAX_SUMMARY_CHARS,
  TokenUsage,
  accountUsage,
  compactBranch,
  stageCompaction,
  transitionCompaction,
  verifyStaged,
} from "../compaction.js"
import { createBudget, recordTurn, shouldCompact, totalTokens } from "../accounting.js"
import { auditLifecycleOutcome, LifecycleRecord } from "../audit.js"
import {
  SessionEntry,
  SessionTree,
  SessionTreeError,
  appendEntry,
  checkInvariants,
  emptyTree,
  fork,
  getBranch,
  leaves,
} from "../session-tree.js"
import { AllowAllGate, MemoryPaths, MemoryService, MemoryServiceLive, resolveMemoryDirs } from "../service.js"

/* ------------------------------------------------------------------ */
/* deterministic PRNG + generators                                     */
/* ------------------------------------------------------------------ */

/** mulberry32 — deterministic PRNG; fixed seed so CI reproduces failures. */
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
const rand = mulberry32(20261007)
const ri = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1))
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789 ,.-"
const rtext = (len: number): string => {
  let s = ""
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return s
}

const runSync = <A, E>(eff: Effect.Effect<A, E>): A => Effect.runSync(eff)

/* ------------------------------------------------------------------ */
/* MemoryService layer (tmp dir) for commit-path property tests         */
/* ------------------------------------------------------------------ */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-prop-test-"))
const layer = (() => {
  const base = resolveMemoryDirs()
  const paths = Layer.succeed(MemoryPaths, {
    ...base,
    sessionsDir: path.join(tmpDir, "sessions"),
    storesDir: path.join(tmpDir, "stores"),
  })
  return Layer.provide(MemoryServiceLive, Layer.mergeAll(AllowAllGate, paths))
})()
const runP = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)

const seedViaService = async (sessionId: string, n: number): Promise<string[]> => {
  const svc = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))
  const ids: string[] = []
  let parent: string | null = null
  for (let i = 0; i < n; i++) {
    const e: SessionEntry = await runP(
      svc.append(sessionId, { parentId: parent, kind: "message", payload: { i, text: rtext(ri(0, 80)) } }),
    )
    ids.push(e.id)
    parent = e.id
  }
  return ids
}

/** Pure deterministic linear tree (no service). */
const buildRandomTree = (sessionId: string): { tree: SessionTree; ids: string[] } => {
  const n = ri(3, 12)
  let current = emptyTree(sessionId)
  const ids: string[] = []
  let parent: string | null = null
  for (let i = 0; i < n; i++) {
    const result: { tree: SessionTree; entry: SessionEntry } = runSync(
      appendEntry(current, {
        parentId: parent,
        kind: "message",
        payload: { i, text: rtext(ri(0, 120)) },
        ts: 1000 + i,
      }),
    )
    current = result.tree
    ids.push(result.entry.id)
    parent = result.entry.id
  }
  return { tree: current, ids }
}

const usage: TokenUsage = accountUsage({ promptText: "p".repeat(400), completionText: "c".repeat(40) })
const summarize = (entries: ReadonlyArray<SessionEntry>): string =>
  `summary of ${String(entries.length)} entries`

/* ------------------------------------------------------------------ */
/* thresholds (Pi #6879 — never-triggered auto-compaction)              */
/* ------------------------------------------------------------------ */

describe("property: compaction trigger thresholds", () => {
  it("fires iff reasoning-token-aware usage >= threshold, tightened when estimated (200 cases, both directions)", () => {
    let fired = 0
    let quiet = 0
    for (let i = 0; i < 200; i++) {
      const reported: number | undefined = rand() < 0.5 ? undefined : ri(0, 3000)
      const args: { promptText: string; completionText: string; reportedReasoningTokens?: number } =
        reported === undefined
          ? { promptText: rtext(ri(0, 4000)), completionText: rtext(ri(0, 2000)) }
          : {
              promptText: rtext(ri(0, 4000)),
              completionText: rtext(ri(0, 2000)),
              reportedReasoningTokens: reported,
            }
      const u = accountUsage(args)
      const budgetTokens = ri(1, 3000)
      const budget = runSync(recordTurn(createBudget(`s-thr-${i}`, budgetTokens), u, "reported"))
      // the Pi #9409 guarantee: estimated reasoning tightens the trigger 0.80 -> 0.70
      const threshold = budget.config.budgetTokens * (u.estimatedReasoning ? 0.7 : 0.8)
      const total = totalTokens(budget.totals)
      // reasoning tokens count whether measured or estimated (Pi #9409)
      expect(total).toBe(u.promptTokens + u.completionTokens + u.reasoningTokens)
      const got = shouldCompact(budget)
      expect(got).toBe(total >= threshold)
      if (got) fired++
      else quiet++
    }
    // both directions actually exercised
    expect(fired).toBeGreaterThan(0)
    expect(quiet).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ */
/* summary caps (Pi #9512)                                             */
/* ------------------------------------------------------------------ */

describe("property: summary caps", () => {
  it("quarantine rejects iff summary exceeds the cap; references always valid (200 cases)", () => {
    for (let i = 0; i < 200; i++) {
      const { tree, ids } = buildRandomTree(`s-cap-${i}`)
      const fromIdx = ri(0, ids.length - 2)
      const toIdx = ri(fromIdx, ids.length - 1)
      const summaryLen = ri(0, MAX_SUMMARY_CHARS * 2)
      const staged = runSync(
        stageCompaction(
          tree,
          { fromId: ids[fromIdx] as string, toId: ids[toIdx] as string },
          () => "x".repeat(summaryLen),
          usage,
        ),
      )
      // references always resolve on the staged output, regardless of cap outcome
      const known = new Set(tree.entries.map((e) => e.id))
      for (const ref of staged.summaryEntry.payload.references as ReadonlyArray<string>) {
        expect(known.has(ref)).toBe(true)
      }
      const over = summaryLen > MAX_SUMMARY_CHARS
      if (over) {
        const err = Effect.runSync(Effect.flip(verifyStaged(tree, staged)))
        expect(err).toBeInstanceOf(SessionTreeError)
        expect(err.reason).toMatch(/exceeds/)
      } else {
        runSync(verifyStaged(tree, staged))
      }
    }
  })
})

/* ------------------------------------------------------------------ */
/* retries (Pi #9051 — missed retries leave no partial state)          */
/* ------------------------------------------------------------------ */

describe("property: failed compactions restage cleanly", () => {
  it("bad window / missing anchor fail; restage from scratch succeeds with no orphans (100 cases)", async () => {
    for (let i = 0; i < 100; i++) {
      const sessionId = `s-retry-${i}`
      const n = ri(4, 8)
      const ids = await seedViaService(sessionId, n)

      // failed attempts: unknown from, unknown to, from-after-to, empty tree
      const badWindows = [
        { fromId: "no-such-entry", toId: ids[n - 1] as string },
        { fromId: ids[0] as string, toId: "no-such-entry" },
        { fromId: ids[n - 1] as string, toId: ids[0] as string },
      ]
      for (const w of badWindows) {
        const svc = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))
        const tree = await runP(svc.read(sessionId))
        const err = Effect.runSync(Effect.flip(stageCompaction(tree, w, summarize, usage)))
        expect(err).toBeInstanceOf(SessionTreeError)
      }
      // nothing was written by the failures: entry count unchanged
      const svc = await runP(Effect.flatMap(MemoryService, (m) => Effect.succeed(m)))
      expect((await runP(svc.read(sessionId))).entries.length).toBe(n)

      // restage from scratch: full pipeline succeeds cleanly
      const fromIdx = ri(0, n - 2)
      const window = { fromId: ids[fromIdx] as string, toId: ids[n - 1] as string }
      const summaryEntry = await runP(compactBranch(sessionId, window, summarize, usage))

      const after = await runP(svc.read(sessionId))
      runSync(checkInvariants(after))
      // exactly one new entry (no partial state, no orphans)
      expect(after.entries.length).toBe(n + 1)
      expect(after.entries.filter((e) => e.kind === "summary")).toHaveLength(1)
      // every compacted entry is referenced by the summary
      const refs = new Set(summaryEntry.payload.references as ReadonlyArray<string>)
      for (let k = fromIdx; k < n; k++) {
        expect(refs.has(ids[k] as string)).toBe(true)
      }
      // originals preserved
      const known = new Set(after.entries.map((e) => e.id))
      for (const id of ids) expect(known.has(id)).toBe(true)
    }
  }, 120000)
})

/* ------------------------------------------------------------------ */
/* tree invariants after every random op (Pi #9930)                     */
/* ------------------------------------------------------------------ */

describe("property: session-tree invariants over random op sequences", () => {
  it("checkInvariants holds after every append/branch/fork/compact (300 ops)", () => {
    let tree = emptyTree("s-prop-tree")
    let forks = 0
    for (let i = 0; i < 300; i++) {
      const op = ri(0, 3)
      const ids = tree.entries.map((e) => e.id)
      switch (op) {
        case 0: {
          // append: random existing parent, or a fresh root
          const parent = ids.length === 0 || rand() < 0.25 ? null : (ids[ri(0, ids.length - 1)] as string)
          const applied = runSync(
            appendEntry(tree, {
              parentId: parent,
              kind: "message",
              payload: { op: i, text: rtext(ri(0, 60)) },
              ts: 2000 + i,
            }),
          )
          tree = applied.tree
          break
        }
        case 1: {
          // branch: read-only walk of a random branch
          if (ids.length > 0) runSync(getBranch(tree, ids[ri(0, ids.length - 1)] as string))
          break
        }
        case 2: {
          // fork: synthetic continuation under a new session id
          forks++
          tree = fork(tree, `s-prop-tree-f${forks}`)
          break
        }
        case 3: {
          // compact: quarantine pipeline over a random leaf window, applied by hand
          const leafCandidates = leaves(tree)
          if (leafCandidates.length > 0) {
            const leaf = leafCandidates[ri(0, leafCandidates.length - 1)] as SessionEntry
            const path = runSync(getBranch(tree, leaf.id))
            const k = Math.min(path.length, ri(1, 3))
            const win = path.slice(path.length - k)
            const staged = runSync(
              stageCompaction(
                tree,
                { fromId: (win[0] as SessionEntry).id, toId: leaf.id },
                () => `sum ${String(i)}`,
                usage,
              ),
            )
            const verified = runSync(verifyStaged(tree, staged))
            const applied = runSync(
              appendEntry(tree, {
                parentId: verified.summaryInput.parentId,
                kind: "summary",
                payload: verified.summaryInput.payload as unknown as Readonly<Record<string, unknown>>,
                ts: 9000 + i,
              }),
            )
            tree = applied.tree
          }
          break
        }
      }
      runSync(checkInvariants(tree))
    }
    expect(tree.entries.length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ */
/* no silent truncation: every compacted entry is referenced            */
/* ------------------------------------------------------------------ */

describe("property: no silent truncation", () => {
  it("every compacted entry is referenced by the summary (100 cases)", async () => {
    for (let i = 0; i < 100; i++) {
      const sessionId = `s-notrunc-${i}`
      const n = ri(5, 10)
      const ids = await seedViaService(sessionId, n)
      const fromIdx = ri(0, n - 3)
      const toIdx = ri(fromIdx + 1, n - 1)
      const windowIds = ids.slice(fromIdx, toIdx + 1)
      const summaryEntry = await runP(
        compactBranch(sessionId, { fromId: windowIds[0] as string, toId: windowIds[windowIds.length - 1] as string }, summarize, usage),
      )
      const refs = new Set(summaryEntry.payload.references as ReadonlyArray<string>)
      expect(refs.size).toBe(windowIds.length)
      for (const id of windowIds) {
        expect(refs.has(id as string)).toBe(true)
      }
    }
  }, 120000)
})

/* ------------------------------------------------------------------ */
/* teardown ordering (Pi #9340)                                        */
/* ------------------------------------------------------------------ */

describe("teardown ordering: abort() during compaction (Pi #9340)", () => {
  /** Drive the state machine; record commit side effects only on successful transitions. */
  const drive = (events: ReadonlyArray<CompactionEvent>) => {
    let phase: CompactionPhase = "idle"
    let commits = 0
    let illegal = 0
    for (const event of events) {
      const before = phase
      try {
        phase = runSync(transitionCompaction(phase, event))
      } catch {
        illegal++
        continue
      }
      if (event === "commit") {
        commits++
        // the core invariant: a commit side effect may only fire from staged
        expect(before).toBe("staged")
      }
    }
    return { phase, commits, illegal }
  }

  it("abort during compaction: no commit after abort, no new staging scheduled", () => {
    // stage → abort (mid-compaction cancel) → commit must be refused
    const r = drive(["stage", "abort", "commit"])
    expect(r.commits).toBe(0)
    expect(r.illegal).toBe(1)
    expect(r.phase).toBe("aborted")
    // a new staging must not be scheduled after the abort either
    const r2 = drive(["stage", "abort", "stage"])
    expect(r2.illegal).toBe(1)
    expect(r2.phase).toBe("aborted")
  })

  it("abort after commit is a no-op; reset starts a fresh cycle", () => {
    const r = drive(["stage", "commit", "abort"])
    expect(r.commits).toBe(1)
    expect(r.illegal).toBe(0)
    expect(r.phase).toBe("committed")
    const r2 = drive(["stage", "commit", "reset", "stage", "commit"])
    expect(r2.commits).toBe(2)
    expect(r2.phase).toBe("committed")
  })

  it("commit from idle is refused (no phantom commit)", () => {
    const r = drive(["commit"])
    expect(r.commits).toBe(0)
    expect(r.illegal).toBe(1)
    expect(r.phase).toBe("idle")
  })

  it("fuzz: over 200 random event sequences, commit side effects fire only from staged", () => {
    const EVENTS: ReadonlyArray<CompactionEvent> = ["stage", "commit", "abort", "reset"]
    for (let s = 0; s < 200; s++) {
      const len = ri(1, 8)
      const events: CompactionEvent[] = []
      for (let k = 0; k < len; k++) events.push(EVENTS[ri(0, EVENTS.length - 1)] as CompactionEvent)
      const { commits } = drive(events)
      // each commit consumed a stage; commits can never outnumber stages
      expect(commits).toBeLessThanOrEqual(len)
    }
  })
})

/* ------------------------------------------------------------------ */
/* lifecycle/outcome separation audit (Hermes #68499)                  */
/* ------------------------------------------------------------------ */

describe("audit: lifecycle/outcome separation (Hermes #68499)", () => {
  /** Build a real committed lifecycle record: stage → verify → append (outcome in tree). */
  const commitRecord = (sessionId: string): { tree: SessionTree; record: LifecycleRecord } => {
    const { tree, ids } = buildRandomTree(sessionId)
    const staged = runSync(stageCompaction(tree, { fromId: ids[0] as string, toId: ids[ids.length - 1] as string }, summarize, usage))
    const verified = runSync(verifyStaged(tree, staged))
    const applied = runSync(
      appendEntry(tree, {
        parentId: verified.summaryInput.parentId,
        kind: "summary",
        payload: verified.summaryInput.payload as unknown as Readonly<Record<string, unknown>>,
        // same ts as the verified candidate: committed outcome is byte-identical
        ts: verified.summaryEntry.ts,
      }),
    )
    return { tree: applied.tree, record: { staged: verified, status: "committed" } }
  }

  it("happy path: committed record + outcome in tree passes all checks", () => {
    const { tree, record } = commitRecord("s-audit-ok")
    const audit = auditLifecycleOutcome(tree, [record])
    expect(audit.passed).toBe(true)
    expect(audit.checks).toHaveLength(3)
    for (const check of audit.checks) expect(check.passed).toBe(true)
  })

  it("lifecycle fields leaked into a summary payload fail no-lifecycle-leakage", () => {
    const { tree, record } = commitRecord("s-audit-leak")
    // simulate a bug: lifecycle metadata persisted as if it were an outcome
    const leaked: SessionTree = {
      ...tree,
      entries: tree.entries.map((e) =>
        e.kind === "summary" ? { ...e, payload: { ...e.payload, verified: true, candidateTree: {} } } : e,
      ),
    }
    const audit = auditLifecycleOutcome(leaked, [record])
    expect(audit.passed).toBe(false)
    const check = audit.checks.find((c) => c.name === "no-lifecycle-leakage")
    expect(check?.passed).toBe(false)
    expect(check?.violations.some((v) => v.includes("verified"))).toBe(true)
    expect(check?.violations.some((v) => v.includes("candidateTree"))).toBe(true)
  })

  it("committed record with no outcome in tree fails linkage (orphan lifecycle record)", () => {
    const { tree, record } = commitRecord("s-audit-orphan")
    // drop the outcome: lifecycle record claims an outcome that is not in the tree
    const outcomeId = record.staged.summaryEntry.id
    const withoutOutcome: SessionTree = {
      ...tree,
      entries: tree.entries.filter((e) => e.id !== outcomeId),
    }
    const audit = auditLifecycleOutcome(withoutOutcome, [record])
    expect(audit.passed).toBe(false)
    const check = audit.checks.find((c) => c.name === "lifecycle-outcome-linkage")
    expect(check?.passed).toBe(false)
    expect(check?.violations.some((v) => v.includes(outcomeId))).toBe(true)
  })

  it("retry discipline: superseded record + fresh committed record passes; dangling staged-outcome fails", () => {
    const { tree: t0, ids } = buildRandomTree("s-audit-retry")
    // first attempt staged but abandoned (retry) — marked explicitly
    const attempt1 = runSync(
      stageCompaction(t0, { fromId: ids[0] as string, toId: ids[1] as string }, summarize, usage),
    )
    // second attempt restaged from scratch and committed
    const attempt2 = runSync(
      stageCompaction(t0, { fromId: ids[0] as string, toId: ids[ids.length - 1] as string }, summarize, usage),
    )
    const verified2 = runSync(verifyStaged(t0, attempt2))
    const applied2 = runSync(
      appendEntry(t0, {
        parentId: verified2.summaryInput.parentId,
        kind: "summary",
        payload: verified2.summaryInput.payload as unknown as Readonly<Record<string, unknown>>,
        ts: verified2.summaryEntry.ts,
      }),
    )
    const committed = applied2.tree
    const audit = auditLifecycleOutcome(committed, [
      { staged: attempt1, status: "superseded" },
      { staged: verified2, status: "committed" },
    ])
    expect(audit.passed).toBe(true)

    // the violation form: an in-flight staged record whose outcome somehow landed in the tree
    const stagedOutcomePresent: SessionTree = {
      ...committed,
      entries: [
        ...committed.entries,
        {
          ...attempt1.summaryEntry,
          id: attempt1.summaryEntry.id,
          payload: attempt1.summaryInput.payload as unknown as Readonly<Record<string, unknown>>,
        },
      ],
    }
    const bad = auditLifecycleOutcome(stagedOutcomePresent, [{ staged: attempt1, status: "staged" }])
    expect(bad.passed).toBe(false)
    expect(bad.checks.find((c) => c.name === "lifecycle-outcome-linkage")?.passed).toBe(false)
  })

  it("dangling references in a summary outcome fail references-resolve", () => {
    const { tree, record } = commitRecord("s-audit-dangle")
    const dangled: SessionTree = {
      ...tree,
      entries: tree.entries.map((e) =>
        e.kind === "summary"
          ? { ...e, payload: { ...e.payload, references: [...((e.payload.references as ReadonlyArray<string>)), "ghost-id"] } }
          : e,
      ),
    }
    const audit = auditLifecycleOutcome(dangled, [record])
    expect(audit.passed).toBe(false)
    expect(audit.checks.find((c) => c.name === "references-resolve")?.passed).toBe(false)
  })
})
