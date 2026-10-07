/**
 * compaction.ts — honest basic compaction with quarantine discipline.
 *
 * Architecture §3.1 / §3.9: summaries are first-class entries; compaction
 * PRESERVES the originals it summarizes (the tree is append-only, never
 * rewritten in place). Compaction is treated as adversarial (the buggiest
 * subsystem in both reference repos) — this module ships the honest basic
 * version plus the hooks the M9 hardening will use:
 *
 *   - stageCompaction(): build + verify a summary entry WITHOUT applying it.
 *   - verifyStaged(): the quarantine gate — entry count + tree-invariant
 *     check on the hypothetical post-compaction tree.
 *   - commitCompaction(): applies only a verified staged compaction.
 *
 * Token accounting is reasoning-token-aware from day one (Pi #9409): the
 * budget counts reasoning tokens, and when the runtime does not expose them
 * the estimator says so explicitly (estimatedReasoning: true) instead of
 * silently under-counting.
 */
import { Data, Effect } from "effect"
import { MemoryStoreError, PermissionDenied } from "./errors-shim.js"
import { MemoryService } from "./service.js"
import {
  SessionEntry,
  SessionTree,
  SessionTreeError,
  appendEntry,
  checkInvariants,
  getBranch,
} from "./session-tree.js"

/** Typed error for compaction failures. */
export class CompactionError extends Data.TaggedError("CompactionError")<{
  readonly sessionId: string
  readonly reason: string
}> {}

/** Reasoning-token-aware usage accounting (Pi #9409). */
export interface TokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  /** Reasoning tokens the provider reported. 0 when unreported. */
  readonly reasoningTokens: number
  /** True when reasoningTokens is a conservative estimate, not a measurement. */
  readonly estimatedReasoning: boolean
}

/** ~4 chars per token; reasoning estimate is 2x output when unmeasured (documented guess). */
const CHARS_PER_TOKEN = 4
const REASONING_ESTIMATE_RATIO = 2

/**
 * Summary text cap (Pi #9512 — the summary-caps corner of the compaction bug
 * farm). The quarantine gate rejects staged summaries exceeding this; the
 * summarizer must restage with a tighter window instead of emitting an
 * unbounded summary.
 */
export const MAX_SUMMARY_CHARS = 4096

/** Conservative token estimate for text. Never pretends to be a measurement. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

/**
 * Build a TokenUsage for a summarization pass. When the runtime does not
 * expose reasoning tokens, accounting falls back to a conservative estimator
 * AND says so via estimatedReasoning — sessions must never wedge silently at
 * the ceiling with compaction never firing.
 */
export const accountUsage = (args: {
  readonly promptText: string
  readonly completionText: string
  readonly reportedReasoningTokens?: number
}): TokenUsage => {
  const completionTokens = estimateTokens(args.completionText)
  const reported = args.reportedReasoningTokens
  return {
    promptTokens: estimateTokens(args.promptText),
    completionTokens,
    reasoningTokens: reported ?? completionTokens * REASONING_ESTIMATE_RATIO,
    estimatedReasoning: reported === undefined,
  }
}

export interface CompactionWindow {
  /** First summarized entry id (inclusive). */
  readonly fromId: string
  /** Last summarized entry id (inclusive) — the anchor the summary hangs from. */
  readonly toId: string
}

export interface SummaryPayload {
  readonly summary: string
  /** Ids of the original entries this summary covers. Never deleted. */
  readonly references: ReadonlyArray<string>
  readonly window: CompactionWindow
  readonly usage: TokenUsage
}

/** A summary entry staged for quarantine verification — not yet applied. */
export interface StagedCompaction {
  readonly sessionId: string
  readonly summaryInput: {
    readonly parentId: string
    readonly kind: "summary"
    readonly payload: SummaryPayload
  }
  /** What the tree would look like after applying the summary. */
  readonly candidateTree: SessionTree
  readonly summaryEntry: SessionEntry
  readonly verified: boolean
}

export type CompactionOpError = CompactionError | MemoryStoreError | PermissionDenied

/**
 * Stage a compaction: summarize the branch window [fromId..toId] into a
 * first-class summary entry that REFERENCES the originals. Nothing is written;
 * the result must pass verifyStaged before commitCompaction will apply it.
 *
 * `summarize` is the summarizer (today: caller-provided text; the M-later
 * InferencePool summarizer plugs in here). Originals are untouched — the
 * candidate tree is the old tree plus exactly one appended entry.
 */
export const stageCompaction = (
  tree: SessionTree,
  window: CompactionWindow,
  summarize: (entries: ReadonlyArray<SessionEntry>) => string,
  usage: TokenUsage,
): Effect.Effect<StagedCompaction, SessionTreeError> =>
  Effect.gen(function* () {
    const branchPath = yield* getBranch(tree, window.toId)
    const fromIdx = branchPath.findIndex((e) => e.id === window.fromId)
    if (fromIdx === -1) {
      return yield* Effect.fail(
        new SessionTreeError({ reason: "compaction window start not on the anchor branch", entryId: window.fromId }),
      )
    }
    const windowEntries = branchPath.slice(fromIdx)
    if (windowEntries.length === 0) {
      return yield* Effect.fail(new SessionTreeError({ reason: "compaction window is empty" }))
    }
    const summaryInput = {
      parentId: window.toId,
      kind: "summary" as const,
      payload: {
        summary: summarize(windowEntries),
        references: windowEntries.map((e) => e.id),
        window,
        usage,
      } satisfies SummaryPayload,
    }
    const { tree: candidateTree, entry } = yield* appendEntry(tree, summaryInput)
    return {
      sessionId: tree.sessionId,
      summaryInput,
      candidateTree,
      summaryEntry: entry,
      verified: false,
    }
  })

/**
 * The quarantine gate (arch §3.9). Verifies a staged compaction BEFORE the
 * session pointer advances:
 *   1. entry count: candidate tree has exactly one more entry than the original
 *   2. tree invariants hold on the candidate (acyclic, parents exist,
 *      content fingerprints intact)
 *   3. every referenced original exists in the candidate tree (preserved)
 *   4. the summary entry is the leaf of its branch (no metadata entry can
 *      become a non-leaf silently truncating history — Pi #9930)
 */
export const verifyStaged = (
  original: SessionTree,
  staged: StagedCompaction,
): Effect.Effect<StagedCompaction, SessionTreeError> =>
  Effect.gen(function* () {
    if (staged.candidateTree.entries.length !== original.entries.length + 1) {
      return yield* Effect.fail(
        new SessionTreeError({
          reason: `quarantine: candidate entry count ${String(staged.candidateTree.entries.length)} != original ${String(original.entries.length)} + 1`,
        }),
      )
    }
    yield* checkInvariants(staged.candidateTree)
    const ids = new Set(staged.candidateTree.entries.map((e) => e.id))
    for (const ref of staged.summaryEntry.payload["references"] as ReadonlyArray<string>) {
      if (!ids.has(ref)) {
        return yield* Effect.fail(
          new SessionTreeError({ reason: "quarantine: summary references a missing original", entryId: ref }),
        )
      }
    }
    // summary must be the leaf of its own branch
    const path = yield* getBranch(staged.candidateTree, staged.summaryEntry.id)
    const last = path[path.length - 1]
    if (last?.id !== staged.summaryEntry.id) {
      return yield* Effect.fail(
        new SessionTreeError({ reason: "quarantine: summary entry is not the branch leaf" }),
      )
    }
    // 5. summary text is bounded (Pi #9512): unbounded summaries fail quarantine
    const summaryText = staged.summaryEntry.payload["summary"] as unknown
    if (typeof summaryText !== "string" || summaryText.length > MAX_SUMMARY_CHARS) {
      return yield* Effect.fail(
        new SessionTreeError({
          reason: `quarantine: summary exceeds ${String(MAX_SUMMARY_CHARS)} chars (restage with a tighter window)`,
          entryId: staged.summaryEntry.id,
        }),
      )
    }
    return { ...staged, verified: true }
  })

/**
 * Commit a VERIFIED staged compaction through the MemoryService. Refuses to
 * apply unverified output — fail-closed. The session pointer advances only
 * here, by appending the summary entry (the tree stays append-only).
 */
export const commitCompaction = (
  staged: StagedCompaction,
): Effect.Effect<SessionEntry, CompactionOpError, MemoryService> =>
  Effect.gen(function* () {
    if (!staged.verified) {
      return yield* Effect.fail(
        new CompactionError({ sessionId: staged.sessionId, reason: "refusing to commit unverified compaction output" }),
      )
    }
    const svc = yield* MemoryService
    const tree = yield* svc.read(staged.sessionId)
    // re-verify against the CURRENT tree: someone may have appended meanwhile
    const currentIds = new Set(tree.entries.map((e) => e.id))
    for (const ref of staged.summaryInput.payload.references) {
      if (!currentIds.has(ref)) {
        return yield* Effect.fail(
          new CompactionError({ sessionId: staged.sessionId, reason: "originals changed since staging; restage" }),
        )
      }
    }
    const anchor = currentIds.has(staged.summaryInput.parentId)
      ? staged.summaryInput.parentId
      : null
    if (anchor === null) {
      return yield* Effect.fail(
        new CompactionError({ sessionId: staged.sessionId, reason: "compaction anchor missing from current tree; restage" }),
      )
    }
    return yield* svc.append(staged.sessionId, {
      parentId: staged.summaryInput.parentId,
      kind: "summary",
      payload: staged.summaryInput.payload as unknown as Readonly<Record<string, unknown>>,
      // the committed entry is byte-identical to the verified candidate:
      // same ts -> same content-fingerprinted id, so a lifecycle record links
      // to its outcome by exact id (the audit in audit.ts depends on this).
      ts: staged.summaryEntry.ts,
    })
  })

/**
 * One-shot convenience: stage → verify → commit. The summarizer and usage
 * accounting are caller-provided so tests and the future InferencePool
 * summarizer share the same quarantine path.
 */
export const compactBranch = (
  sessionId: string,
  window: CompactionWindow,
  summarize: (entries: ReadonlyArray<SessionEntry>) => string,
  usage: TokenUsage,
): Effect.Effect<SessionEntry, CompactionOpError | SessionTreeError, MemoryService> =>
  Effect.gen(function* () {
    const svc = yield* MemoryService
    const tree = yield* svc.read(sessionId)
    const staged = yield* stageCompaction(tree, window, summarize, usage)
    const verified = yield* verifyStaged(tree, staged)
    return yield* commitCompaction(verified)
  })

/**
 * Compaction lifecycle state machine (Pi #9340 — teardown ordering).
 *
 * Cancellation must never trigger post-cancel side effects: abort() during
 * compaction moves staged → aborted, and from aborted neither commit nor a
 * new stage is legal. The ONLY way out of aborted/committed is an explicit
 * reset, which starts a fresh cycle — it never replays the cancelled one.
 *
 * Transition table:
 *   idle      + stage  → staged        idle      + abort → aborted
 *   staged    + commit → committed     staged    + abort → aborted
 *   committed + abort  → committed (no-op: abort after commit changes nothing)
 *   committed + reset  → idle          aborted   + reset → idle
 *   everything else → CompactionTransitionError (fail loud, no silent transition)
 */
export type CompactionPhase = "idle" | "staged" | "committed" | "aborted"
export type CompactionEvent = "stage" | "commit" | "abort" | "reset"

export class CompactionTransitionError extends Data.TaggedError("CompactionTransitionError")<{
  readonly from: CompactionPhase
  readonly event: CompactionEvent
  readonly reason: string
}> {}

const COMPACTION_TRANSITIONS: Readonly<
  Record<CompactionPhase, Readonly<Partial<Record<CompactionEvent, CompactionPhase>>>>
> = {
  idle: { stage: "staged", abort: "aborted" },
  staged: { commit: "committed", abort: "aborted" },
  committed: { abort: "committed", reset: "idle" },
  aborted: { reset: "idle" },
}

export const transitionCompaction = (
  phase: CompactionPhase,
  event: CompactionEvent,
): Effect.Effect<CompactionPhase, CompactionTransitionError> => {
  const next = COMPACTION_TRANSITIONS[phase][event]
  if (next === undefined) {
    return Effect.fail(
      new CompactionTransitionError({
        from: phase,
        event,
        reason: `illegal compaction transition: ${event} from ${phase} (no post-cancel side effects allowed)`,
      }),
    )
  }
  return Effect.succeed(next)
}
