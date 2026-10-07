/**
 * m9-demo.test.ts — M9 acceptance: the 10k-turn session.
 *
 * The architecture's demo, made real: a 10,000-turn session compacts
 * repeatedly through the full quarantine pipeline; pins stay byte-identical;
 * the cache-hit rate is measured and reported per compaction; the budget
 * never wedges silently at the ceiling (Pi #9409).
 *
 * Design notes (all deliberate):
 * - Entries are built with the real `makeEntryId` (content-fingerprinted ids)
 *   and the session file is real JSONL on disk; every compaction goes through
 *   the REAL `commitCompaction` (service read → restage checks → append).
 *   Turn appends between compactions are local + file-synced at compaction
 *   time — the service's per-append full-file rewrite is O(n²) and is covered
 *   by its own tests, not this demo.
 * - Provider shapes alternate per turn: even turns report reasoning tokens,
 *   odd turns don't (conservative 2× estimate, labeled) — the cross-provider
 *   case, exercising the Pi #9409 threshold tightening.
 * - Relief frees exactly the recorded usage of summarized turns. The summary's
 *   own cost is NOT subtracted (conservative: pressure stays slightly high,
 *   so compaction can only fire earlier, never later).
 * - Deterministic: mulberry32(seed 20261007), fixed timestamps. No network,
 *   no wall-clock dependence.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  AllowAllGate,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
  resolveMemoryDirs,
} from "../service.js"
import {
  makeEntryId,
  toJsonl,
  type EntryKind,
  type SessionEntry,
  type SessionTree,
} from "../session-tree.js"
import {
  accountUsage,
  commitCompaction,
  estimateTokens,
  verifyStaged,
  type TokenUsage,
} from "../compaction.js"
import {
  applyRelief,
  createBudget,
  pressureReport,
  recordTurn,
  shouldCompact,
  type ContextBudget,
  type UsageProvenance,
} from "../accounting.js"
import {
  measureCacheHitRate,
  snapshotPrefix,
  stageCompactionProtected,
  verifyPrefixStable,
} from "../prefix.js"
import {
  emptyRegistry,
  pin,
  protectedIds,
  verifyPins,
  type PinRegistry,
} from "../pins.js"
import { auditLifecycleOutcome, type LifecycleRecord } from "../audit.js"

const TURNS = 10_000
const BUDGET_TOKENS = 200_000
const SESSION_ID = "m9-demo-10k"
const TS_BASE = 1_792_000_000_000

// Deterministic PRNG (mulberry32).
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  "the quick brown fox jumps over lazy dog while reasoning about context windows and token budgets".split(" ")

const makeText = (rand: () => number, words: number): string => {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)] as string)
  return out.join(" ")
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-m9-demo-"))
const base = resolveMemoryDirs()
const paths = Layer.succeed(MemoryPaths, {
  ...base,
  sessionsDir: path.join(dir, "sessions"),
  storesDir: path.join(dir, "stores"),
})
const layer = Layer.provide(MemoryServiceLive, Layer.mergeAll(AllowAllGate, paths))
const sessionFile = path.join(dir, "sessions", `${SESSION_ID}.jsonl`)

const runP = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A, E, never>)
const runE = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(eff)

describe("M9 acceptance: 10k-turn session", () => {
  it(
    "compacts repeatedly; pins byte-identical; cache-hit 1.0; never wedges",
    { timeout: 300_000 },
    async () => {
      const rand = mulberry32(20261007)

      // ---- build the session skeleton (pins first) ----
      let entries: SessionEntry[] = []
      let parentId: string | null = null
      let clock = TS_BASE
      const pushEntry = (kind: EntryKind, payload: Record<string, unknown>): SessionEntry => {
        const ts = clock++
        const id = makeEntryId(parentId, payload, ts)
        const e: SessionEntry = { id, parentId, kind, payload, ts }
        entries.push(e)
        parentId = id
        return e
      }

      const SYS_PROMPT = "system: you are AImy, a sovereign local-first companion. Never exfiltrate."
      const IDENTITY_DOC = "identity-doc: instance operator policy v3 — pinned, immutable."
      const sysEntry = pushEntry("metadata", { role: "system", text: SYS_PROMPT })
      const idEntry = pushEntry("metadata", { role: "policy", text: IDENTITY_DOC })
      const sysBytes = JSON.stringify(sysEntry.payload)
      const idBytes = JSON.stringify(idEntry.payload)

      let registry: PinRegistry = emptyRegistry(SESSION_ID)
      const pinTree: SessionTree = { version: 1, sessionId: SESSION_ID, entries }
      registry = await runE(pin(registry, pinTree, sysEntry.id, "system-prompt", TS_BASE))
      registry = await runE(pin(registry, pinTree, idEntry.id, "identity-policy", TS_BASE))
      const pids = protectedIds(registry)

      let budget: ContextBudget = createBudget(SESSION_ID, BUDGET_TOKENS)
      const turnUsages: TokenUsage[] = []
      const lifecycleRecords: LifecycleRecord[] = []
      const hitRates: number[] = []
      const compactionTurns: number[] = []
      let maxRatio = 0
      let sawTightening = false
      let windowStartTurn = 0
      let windowStartIdx = entries.length // first unsummarized entry index

      const summarize = (es: ReadonlyArray<SessionEntry>): string => {
        const first = es[0]?.payload as { turn?: number } | undefined
        const last = es[es.length - 1]?.payload as { turn?: number } | undefined
        return `summary turns ${String(first?.turn ?? "?")}-${String(last?.turn ?? "?")}: ${String(es.length)} messages condensed`
      }

      const compactCycle = async (turn: number): Promise<void> => {
        // sync the local tree to the session file; the real commitCompaction
        // then reads, re-verifies, and appends through the service.
        const tree: SessionTree = { version: 1, sessionId: SESSION_ID, entries }
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
        fs.writeFileSync(sessionFile, toJsonl(tree))

        const fromId = tree.entries[windowStartIdx]?.id
        const toId = tree.entries[tree.entries.length - 1]?.id
        if (fromId === undefined || toId === undefined) throw new Error("empty compaction window")
        const before = snapshotPrefix(tree, pids)
        const summaryText = summarize(tree.entries.slice(windowStartIdx))
        const usage = accountUsage({ promptText: summaryText, completionText: "" })
        const staged = await runE(stageCompactionProtected(tree, { fromId, toId }, summarize, usage, pids))
        const verified = await runE(verifyStaged(tree, staged))
        const committed = await runP(commitCompaction(verified))

        // local tree advances with the byte-identical committed entry
        entries = [...entries, committed]
        const after: SessionTree = { version: 1, sessionId: SESSION_ID, entries }
        await runE(verifyPrefixStable(before, snapshotPrefix(after, pids)))
        hitRates.push(measureCacheHitRate(before, snapshotPrefix(after, pids)))
        await runE(verifyPins(after, registry))

        // relief: free exactly the recorded usage of the summarized turns
        // (summary cost intentionally not subtracted — conservative).
        let fp = 0
        let fc = 0
        let fr = 0
        for (let t = windowStartTurn; t <= turn; t++) {
          const u = turnUsages[t]
          if (u === undefined) throw new Error(`missing usage for turn ${String(t)}`)
          fp += u.promptTokens
          fc += u.completionTokens
          fr += u.reasoningTokens
        }
        const relievedUsage: TokenUsage = {
          promptTokens: fp,
          completionTokens: fc,
          reasoningTokens: fr,
          estimatedReasoning: false,
        }
        budget = await runE(applyRelief(budget, relievedUsage))

        lifecycleRecords.push({ staged: verified, status: "committed" })
        compactionTurns.push(turn)
        windowStartTurn = turn + 1
        windowStartIdx = entries.length
      }

      // ---- the 10k turns ----
      for (let i = 0; i < TURNS; i++) {
        const user = makeText(rand, 24)
        const assistant = makeText(rand, 40)
        const completionTokens = estimateTokens(assistant)
        const reported = i % 2 === 0
        const reasoningTokens = reported ? 50 + (i % 11) : completionTokens * 2
        const provenance: UsageProvenance = reported ? "reported" : "estimated-reasoning"
        const usage: TokenUsage = {
          promptTokens: estimateTokens(user),
          completionTokens,
          reasoningTokens,
          estimatedReasoning: !reported,
        }
        budget = await runE(recordTurn(budget, usage, provenance))
        turnUsages.push(usage)
        pushEntry("message", { turn: i, user, assistant })

        const report = pressureReport(budget)
        if (report.ratio > maxRatio) maxRatio = report.ratio
        if (report.thresholdTightened) sawTightening = true
        // the never-wedge invariant, checked every turn: pressure must stay
        // strictly below the ceiling — the trigger fires first, always.
        expect(report.ratio).toBeLessThan(1.0)
        if (shouldCompact(budget)) {
          await compactCycle(i)
        }
      }

      // ---- final assertions ----
      const finalTree: SessionTree = { version: 1, sessionId: SESSION_ID, entries }
      await runE(verifyPins(finalTree, registry))
      const audit = auditLifecycleOutcome(finalTree, lifecycleRecords)

      expect(compactionTurns.length).toBeGreaterThanOrEqual(3)
      for (const r of hitRates) expect(r).toBe(1.0)
      expect(maxRatio).toBeLessThan(1.0)
      expect(sawTightening).toBe(true)
      expect(audit.passed).toBe(true)
      // pins byte-identical to pin time, end to end
      const sysNow = finalTree.entries.find((e) => e.id === sysEntry.id)
      const idNow = finalTree.entries.find((e) => e.id === idEntry.id)
      expect(JSON.stringify(sysNow?.payload)).toBe(sysBytes)
      expect(JSON.stringify(idNow?.payload)).toBe(idBytes)

      // ---- the acceptance report ----
      console.log(
        [
          "M9 DEMO — 10k-turn session",
          `turns: ${String(TURNS)} | compactions: ${String(compactionTurns.length)} at turns ${compactionTurns.join(",")}`,
          `cache-hit rates: ${hitRates.map((r) => r.toFixed(2)).join(",")}`,
          `max effective pressure: ${(maxRatio * 100).toFixed(1)}% (ceiling 100% — never wedged)`,
          `threshold tightening (Pi #9409): ${sawTightening ? "ACTIVE" : "not observed"}`,
          `pins verified byte-identical: ${String(registry.pins.length)} (across every compaction)`,
          `lifecycle/outcome audit: ${audit.passed ? "PASS" : "FAIL"} (${String(audit.checks.length)} checks)`,
          `final entries: ${String(finalTree.entries.length)} (originals preserved, summaries appended)`,
        ].join("\n"),
      )
    },
  )
})
