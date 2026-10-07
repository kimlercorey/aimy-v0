# @aimy/learning — M6 learning loop library (Tracks 1 + 2 + 3)

TypeScript + Effect 4.0.1. No network. No UI (that's M8).

## What this is

Three pieces of the M6 learning loop v1 (architecture §3.5–§3.8):

- **Track 1 (`snapshot.ts`, `provenance.ts`, `prompts.ts`, `review-types.ts`,
  `writes.ts`, `forks.ts`, `scheduling.ts`)** — background-review forks +
  unattended-write safety: fork-after-turn with immutable snapshots,
  dispatch-whitelisted toolsets, aux-model routing, foreground-priority
  cancel with a bounded handshake, idle-gated scheduling, and the
  add-only-unattended write gate with fail-closed staging. Documented in
  full below.
- **`timeline.ts`** — the learning timeline data model. Every learning event is
  a node: content-fingerprinted id, timestamp, event type, provenance, links to
  honesty-ledger evidence, payload. Append-only; "delete" archives (tombstone
  with restore) — NEVER destroys. Queryable by time range, type, and subject.
- **`fossilization.ts`** — the fossilization guard (Hermes #6051, "learned
  helplessness"). Avoidance rules learned from failures carry their failure
  context, are time-bounded and versioned, and are re-tested against current
  environment state on expiry or on demand. Works → lifted; still fails →
  renewed with fresh context as a new version. Every intervention is itself a
  timeline event.

## Layout

```
src/
  errors.ts          typed error taxonomy (Data.TaggedError, never thrown)
  timeline.ts        LearningEvent union, LearningNode, TimelineStore seam,
                     LearningTimeline service + InMemoryTimelineStore
  fossilization.ts   AvoidanceRule, classifyFailure, environmentFingerprint,
                     AvoidanceStore seam, FossilizationGuard service
  index.ts           re-exports
  timeline.test.ts
  fossilization.test.ts
```

## Key design decisions

**Own store seam, not MemoryService (yet).** The timeline owns a
`TimelineStore` Effect seam with an in-memory default, mirroring the honesty
ledger's `LedgerStore` pattern. Rationale: the timeline has its own query
semantics (time range / type / subject / archive visibility) that don't map
onto MemoryService's KV/session-tree API today. When a durable learning-graph
backing lands under MemoryService, `InMemoryTimelineStore` is replaced by a
MemoryService-backed adapter implementing `TimelineStoreShape` — no service
code changes. Per architecture §1.1, the M8 Foldkit shell will read the
timeline through `LearningTimeline.query` (or MemoryService read APIs once
the backing is unified); either way, through the same gates.

**Content-fingerprinted ids.** `nodeId = sha256("type\n" + canonicalJson({type,
recordedAt, provenance, subject, evidenceIds, payload}))` — reusing the
judges' `canonicalJson`/`sha256Hex` (`honesty/judges/src/canonical.ts`).
Tombstoning does NOT change the id: the id fingerprints the event content,
not the archive state. Re-recording the same event (same content AND same
`recordedAt`) is idempotent and returns the existing node, like the honesty
ledger's `recordClaim`.

**Delete = archive, edit = new node.** `archiveNode` tombstones the node and
records a `timeline.node.archived` meta event; `getNode` still returns the
node and `query({ includeArchived: true })` still lists it. `editNode`
records a new node (`supersedes` set) and archives the old one (`"edited"`,
`supersededBy` set) — history is never rewritten. This keeps lifecycle state
(archived/active) separate from outcome records (the nodes), per Hermes
#68499.

**Expired avoidances are unenforced.** `isAvoided` returns true only for
active, unexpired rules. This is the anti-#6051 rule: an avoidance whose
evidence has expired must be re-tested before it can keep constraining
behavior. A rule that cannot be re-tested (no probe registered) is renewed
conservatively with prior context — fail-closed, never silently dropped —
and the renewal is a timeline event either way.

**Classification is structural, not LLM.** `classifyFailure` uses failure
kind, prior successes, consecutive failures, and environment diversity.
Timeouts/network/resource-exhaustion are transient; policy denials are
persistent; assertion failures are persistent only with ≥3 consecutive
failures across ≥2 distinct environments, else unknown. TTLs: transient 6h,
persistent 7d, unknown 24h (overridable per rule).

## The event wire contract (Track 2)

`LearningEvent` is the union Track 2's pipeline (forks → verification arm →
evidence gate → curator) emits; `LearningTimeline.recordEvent` turns each
emission into a node automatically. Event types:

| Type | Emitted by |
|---|---|
| `review-fork.proposed-add` | review fork proposes a memory/skill add |
| `review-fork.staged` | destructive op staged, awaiting approval (§3.7) |
| `verification.started` / `.passed` / `.failed` | verification arm |
| `skill.trusted` / `skill.rejected` | evidence gate |
| `avoidance.learned` | fossilization guard |
| `fossilization.intervention` | fossilization guard (lifted / renewed) |
| `curator.transitioned` | curator (active→stale→archived) |
| `curator.consolidation.{proposed,adopted,rejected}` | curator |
| `timeline.node.archived` / `.restored` | timeline itself (meta events) |

Every event carries `provenance` (origin, session, profile), optional
`subject` (skill/memory/behavior id), `evidenceIds` (honesty-ledger claim
ids), and an optional `recordedAt` override (for idempotent re-record).

Track 2 wiring example — the arm records each transition as it happens:

```ts
import { Effect } from "effect"
import { LearningTimeline, type LearningEvent } from "../learning/src/index.js"

const emit = (event: LearningEvent) =>
  Effect.gen(function* () {
    const timeline = yield* LearningTimeline
    yield* timeline.recordEvent(event)
  })

// in the arm, after judges run:
yield* emit({
  type: "verification.passed",
  provenance: { origin: "verification-arm", sessionId, profileId },
  subject: skillId,
  evidenceIds: [claimId],
  payload: { verdictIds },
})
// in the evidence gate:
yield* emit({
  type: "skill.trusted",
  provenance: { origin: "verification-arm", sessionId, profileId },
  subject: skillId,
  evidenceIds: [claimId],
  payload: { judgeVersions },
})
```

## Fossilization guard usage

```ts
import { Effect } from "effect"
import { FossilizationGuard, environmentFingerprint } from "../learning/src/index.js"

yield* Effect.gen(function* () {
  const guard = yield* FossilizationGuard

  // A probe re-tests the avoided behavior against CURRENT environment state.
  // Supplied by the caller — Track 2's verification arm will supply real ones.
  yield* guard.registerProbe("tool.exec(playwright)", () =>
    Effect.succeed({
      outcome: "works", // or "still-fails" with freshContext
      observedAt: new Date().toISOString(),
      summary: "playwright launched cleanly",
    }),
  )

  const rule = yield* guard.learnAvoidance({
    behavior: "tool.exec(playwright)",
    reason: "launch timed out twice",
    context: {
      whatFailed: "playwright launch",
      failureKind: "timeout",
      environmentFingerprint: environmentFingerprint({ platform: "linux-x86_64", toolVersions: { playwright: "1.49.1" } }),
      recordedAt: new Date().toISOString(),
      attempts: 2,
    },
    provenance: { origin: "review-fork", sessionId, profileId },
  })

  if (yield* guard.isAvoided("tool.exec(playwright)")) { /* steer around it */ }

  yield* guard.retest(rule.ruleId) // on demand, or…
  yield* guard.sweepExpired()      // …retest every expired rule
})
```

## Error taxonomy

`LearningError` = `NodeNotFound` | `NodeAlreadyArchived` | `NodeNotArchived`
| `UnserializablePayload` | `LearningStoreError` | `AvoidanceNotFound`.
All are `Data.TaggedError`s, never thrown.

## Future seams

- Durable `TimelineStore` / `AvoidanceStore` backends (SQLite under
  MemoryService) — implement the store shapes; services are unchanged.
- M8 timeline UI reads `LearningTimeline.query`.
- Track 2 supplies real `AvoidanceProbe`s from the verification arm and calls
  `recordEvent` on every pipeline transition (see table above).
- Environment snapshots can grow (`extra` field) without breaking stored
  rules; fingerprints are recomputed, never stored as the source of truth.

---

# Track 2: verification arm + quarantine → evidence gate → trusted + curator

The load-bearing track: **the learning loop must not ship on prompt-only
verification.** "LLM proposes, evidence disposes."

## The pipeline

```
new/modified skill
      │
      ▼
┌─────────────┐   T0-observed sandboxed runs only. Never live,
│ QUARANTINE  │   never auto-invoked. Structural state — the skill
│quarantine.ts│   cannot clear it; only the store transitions states.
└──────┬──────┘
       ▼
┌─────────────┐   Three sub-mechanisms, ALL EXECUTABLE:
│VERIFICATION │   1. generated tests — synthesized from the candidate's
│ ARM (arm.ts)│      declared behavior contract, run through the honesty
│             │      judges framework (runJudge: frozen inputs, pinned
│             │      judge versions, recomputed verdictIds)
│             │   2. evals — arm-owned held-out cases; outcomes MEASURED
│             │      (pass rate; Hermes #96704)
│             │   3. second-model critic — a DIFFERENT lane (author ≠
│             │      inspector, structural; Hermes #25833). Its verdict is
│             │      RECORDED in the honesty ledger as evidence, never
│             │      taken on assertion.
│             │   Produces a VerificationReport (pass/fail per mechanism +
│             │   evidence refs). Only a passing report with executable
│             │   evidence per mechanism mints the VerifiedReport brand.
└──────┬──────┘
       ▼
┌─────────────┐   Promotes quarantined → trusted ONLY on a VerifiedReport.
│EVIDENCE GATE│   The brand is unforgeable outside arm.ts (module-private
│  (gate.ts)  │   symbol), so prompt-only promotion is a TYPE ERROR, not a
│             │   policy. The gate re-validates at runtime anyway
│             │   (defense in depth). Rejections are recorded in the ledger.
└──────┬──────┘
       ▼
    trusted → resolvable for live tasks
```

## The hard rule

A candidate whose "evidence" is prompt-claimed only (LLM assertion, no
executable check) can **never** clear the gate:

- **Type level.** `EvidenceGate.promote` accepts only `VerifiedReport`.
  The brand is minted solely by `VerificationArm.finalize`, which requires
  overall pass **and** ≥1 judge verdict behind generated-tests, ≥1 behind
  evals, ≥1 recorded critic evidence. A prompt-only candidate fails all
  three mechanisms, so no brand exists for it. There is no other
  constructor — the skill cannot promote itself.
- **Tested invariant.** `arm.test.ts` → *"PROMPT-ONLY REJECTION PROOF"*:
  a candidate with no behavior contract and a passing critic assertion
  gets an overall-fail report; `finalize` refuses with `UnverifiedReport`;
  `gate.test.ts` proves a forged pass-shaped report is rejected and the
  record stays quarantined, never live.

## Curator (`curator.ts`)

Two halves, strictly separate (architecture §3.8):

- **Deterministic transitions** — pure functions, no LLM:
  `active → stale` (N days unused) `→ archived` (M days). **Never delete,
  only archive** (the planner cannot express deletion). Pinned and
  cron-referenced skills bypass. Every transition carries its evidence:
  the rule evaluation (timestamps + thresholds). Dry-run report mode.
- **LLM consolidation (proposes only).** An opt-in fork proposes umbrella
  skills absorbing overlapping ones. `adoptConsolidation` requires the
  umbrella's `VerifiedReport` — proof the arm demonstrated the absorbed
  skills' covered cases against the umbrella (Hermes #29912: never archive
  on model assertion alone). Cron refs are rewritten to follow verified
  consolidations. Rejections are recorded in the honesty ledger.

## Track 2 files

| File | Contents |
|---|---|
| `src/types.ts` | `CandidateSkill`, `BehaviorCase`, `EvalCase` — the executable contract a candidate carries |
| `src/quarantine.ts` | `QuarantineStore` service (in-memory live layer): land, markVerifying, promote/reject (gate-only), T0-observed sandboxed runs, live resolution |
| `src/arm.ts` | `VerificationArm` service + `ArmConfig`; `aimy/skill-check@1.0.0` judge; `VerifiedReport` brand + `finalize`; `isVerifiedReport` |
| `src/gate.ts` | `EvidenceGate` service: `promote(VerifiedReport)`, `reject` (recorded) |
| `src/curator.ts` | `Curator` service + pure `planTransitions`/`applyTransitions`; `adoptConsolidation` |
| `test/fixtures.ts` | Deterministic executor/critic/eval fixtures; one composed layer tree; `verifyPassing` (mints real brands — tests never forge) |
| `test/quarantine.test.ts`, `test/arm.test.ts`, `test/gate.test.ts`, `test/curator.test.ts` | 36 tests |

## Track 2 dependencies (all reused, nothing rebuilt)

- `honesty/` — `HonestyService` evidence ledger (claims, evidence, verdicts, badges)
- `honesty/judges/` — `JudgeRegistry`, `runJudge`, `defineJudge`, `canonicalJson`/`sha256Hex`
- `substrate/` — `Tier` type for the T0 sandbox rule

The `SkillExecutor` and `CriticLane` seams are injected via `ArmConfig` —
deterministic stubs in tests, real sandboxed backends in production.

---

# Track 1: background-review forks + unattended-write safety

The mechanism (architecture §3.5, §3.7): after a turn completes, a
supervised review fiber may spawn holding an **immutable snapshot** of the
conversation. It asks "should any skill or memory be saved/updated?" with a
**dispatch-whitelisted toolset** (propose writes + read context only), routes
through the **aux model lane**, and is **cancelled with a bounded handshake**
when a new live turn starts. Unattended forks may **add**; `replace`/`remove`
**stage for human approval**, fail-closed.

```
turn completes (agent-loop finishTurn)
      │
      ▼
┌──────────────┐  immutable ConversationSnapshot (deep-frozen, by value —
│ REVIEW FORK  │  never a live reference; main conversation + prompt cache
│  (forks.ts)  │  untouched by construction)
└──────┬───────┘
       │  ReviewWorker(snapshot, toolset) — pure function of the two args;
       │  the worker cannot reach MemoryService/InferencePool (never given them)
       ▼
┌──────────────┐  dispatch whitelist: proposeWrite + readContext ONLY.
│   TOOLSET    │  Provenance attaches here from the request — never
│              │  model-supplied, never worker-supplied.
└──────┬───────┘
       ▼
┌──────────────────┐  add → applied (provenance-checked, atomic via
│ UNATTENDED-WRITE │  Effect.uninterruptible)
│  GATE (writes.ts)│  replace/remove → STAGED into PendingStore (content-
│                   │  fingerprinted ids), surfaced for human approval
│                   │  staging failure → DENIED (fail-closed, never silent apply)
│                   │  missing provenance → UnattributedWrite (typed rejection)
└──────────────────┘
```

## Public interface

```ts
import { Effect, Layer } from "effect"
import {
  ReviewForks, layerReviewForks,          // spawnReview / noteLiveTurn / inFlight / lastOutcome
  ReviewScheduler, layerReviewScheduler,  // enqueue / refineNow / drain / pending
  IdleSignal,                             // injectable idle signal (Context.Tag)
  FakeIdleSignalLive,                     // test seam: manually-driven idle
  UnattendedWriteGate, UnattendedWriteGateLive,
  PendingStore, InMemoryPendingStore,
  snapshotFromTurn, makeDigest, deepFreeze,
  requireProvenance, REVIEW_SYSTEM_PROMPT, parseProposals,
  DEFAULT_LEARNING_CONFIG,
} from "../learning/src/index.js"
```

### `ReviewForks` (forks.ts)

| Method | Description |
|---|---|
| `spawnReview(req)` | Spawn a supervised review fiber for a finished turn. Newest-wins: an in-flight review for the same session is retired (bounded handshake, not blocking the spawn) and replaced. |
| `noteLiveTurn(sessionId)` | A live turn started: cancel any in-flight review with the bounded handshake. Returns `NoReview` \| `Acked` \| `Timeout` — on `Timeout` the live turn proceeds anyway; the fork never blocks the user. |
| `inFlight(sessionId)` | The in-flight handle, if any (completed forks drop their own handle). |
| `lastOutcome(sessionId)` | Last recorded `ForkOutcome` (`Completed` \| `WorkerFailed`). Cancelled forks record nothing. |

`layerReviewForks(opts?: { worker?, ackDeadlineMs?, digestCharBudget? })` —
requires `UnattendedWriteGate | InferencePool | MemoryService`. Review fibers
are supervised in a **layer-lifetime scope** (acquireRelease'd `Scope`):
tearing down the layer cancels every in-flight review. The default worker
(`makeAuxDigestWorker`) replays a **compact digest** (char-capped, default
4000) through `InferencePool.generateAux` — never the full snapshot, never
the foreground provider. Pass `opts.worker` for a custom worker (tests).

**Post-cancel side effects are impossible by construction.** A cancelled
fiber's body is abandoned at the next interruptible boundary: the outcome
record is written only when the worker was *not* cancelled, and each applied
write is atomic (`Effect.uninterruptible`), so a cancel sees the whole write
or none of it — never a torn write, never a post-cancel application.
Tested: a worker blocked on a latch, cancelled, then released applies
nothing and records nothing.

**Bounded-cancel handshake.** `noteLiveTurn` marks the handle cancelled,
sends the interrupt, and races fiber termination against the deadline
(default 2000ms, architecture §3.5): `Acked` if the fork terminates in
time, `Timeout` if not. On timeout the interrupt was already sent — the fork
still dies as soon as it can. Tested with an uninterruptible worker and the
TestClock: the live turn proceeds on `Timeout` while the stuck fork is still
being interrupted.

### `UnattendedWriteGate` + `PendingStore` (writes.ts)

`applyUnattended({ kind, namespace, key, value?, reason, provenance })`:

1. `requireProvenance` first — unattributed writes fail typed
   (`UnattributedWrite`), before anything else.
2. `add` → applied atomically via `MemoryService.set`.
3. `replace`/`remove` → staged into the `PendingStore` (never applied);
   the `Staged` disposition carries the content-fingerprinted `pendingId`.
4. Staging failure → `Denied` (fail-closed). Denial is terminal for the
   operation; nothing is silently applied.

`UnattendedWriteGateLive` requires `MemoryService | PendingStore`;
`InMemoryPendingStore` is the in-memory staging area (production swaps the
layer for SQLite). Staged entries are surfaced for human approval on the
learning timeline (`review-fork.staged` events, Track 3) — approval/denial
decisions remove the entry from the pending store.

### `ReviewScheduler` + `IdleSignal` (scheduling.ts)

| Method | Description |
|---|---|
| `enqueue(req)` | Queue a background review. One slot per session: re-enqueueing replaces the older snapshot (**newest-snapshot-wins** coalescing). |
| `refineNow(req)` | Explicit user-invoked refinement: spawns **immediately** — never queued, never idle-gated, never deferred. |
| `drain()` | Process the queue: drop entries older than `maxAgeMs` (default 30min — never run a stale review), otherwise `waitForIdle(settleWindowMs)` (default 15s continuous idle) then spawn. Returns `{ processed, droppedStale, remaining }`. |
| `pending()` | Currently queued entries. |

`IdleSignal` is a `Context.Tag` (`waitForIdle(settle)`, `isIdleNow`) —
production provides the GPU-lease-backed implementation; tests use
`FakeIdleSignalLive(initialIdle)` / `makeFakeIdleSignal` (manually driven).
`layerReviewScheduler(opts?: { settleWindowMs?, maxAgeMs? })` requires
`ReviewForks | IdleSignal`.

### Snapshots, digests, provenance, prompts

- `snapshotFromTurn(sessionId, input, report, now?)` — builds the immutable
  snapshot from the agent-loop's `TurnReport` (user input + assistant text +
  tool-call outcomes, summarized). Deep-copied by value, deep-frozen
  (cycle-safe). Mutating the report afterwards cannot leak in (tested).
- `makeDigest(snapshot, charBudget)` — role-labeled, per-turn-truncated,
  hard-capped rendering with an explicit `[digest truncated]` marker.
- `requireProvenance(unknown)` — Schema-validated provenance
  (`origin`, `executionContext`, `sessionId`, `profileId`, all required);
  fails `UnattributedWrite` otherwise (tested: missing, partial, bad origin).
- `REVIEW_SYSTEM_PROMPT` — our own words, written from the failure
  taxonomy: do-not-capture (transient failures, negative capability claims,
  unresolved failures, verbatim logs, unscoped time-bound facts), lesson
  shape (procedure-first, rule + one clause of why, read-before-write, fix
  in place), one-fact-one-store routing, protected scopes (propose-only),
  budget awareness. Never copied from another project's prompts.
- `parseProposals(text)` — the reviewer's JSON-lines output →
  `RawProposal[]`; `NO-OP`/blank → `[]`; malformed lines → typed
  `ReviewParseError` (the fork records the failure, never crashes, never
  applies a half-proposal).

### Wiring example

```ts
import { Effect, Layer } from "effect"
import { InferencePoolLive } from "../inference-pool/index.js"
import { AllowAllGate, MemoryPathsLive, MemoryServiceLive } from "../memory/index.js" // real gate in prod
import {
  layerReviewForks, layerReviewScheduler,
  InMemoryPendingStore, UnattendedWriteGateLive,
  snapshotFromTurn, type ReviewRequest,
} from "../learning/src/index.js"
import { GpuIdleSignalLive } from "./gpu-idle.js" // production IdleSignal (not shipped here)

const LearningLive = Layer.provide(
  Layer.mergeAll(
    layerReviewForks(),
    layerReviewScheduler(),
  ),
  Layer.mergeAll(
    Layer.provide(UnattendedWriteGateLive, Layer.mergeAll(MemoryServiceLive, InMemoryPendingStore)),
    InferencePoolLive,
    GpuIdleSignalLive,
  )
)

// after a turn completes (agent-loop finishTurn):
const onTurnDone = (sessionId: string, input: string, report: TurnReport) =>
  Effect.gen(function* () {
    const forks = yield* ReviewForks
    const sched = yield* ReviewScheduler
    const snapshot = snapshotFromTurn(sessionId, input, report)
    yield* sched.enqueue({
      sessionId, snapshot, mode: "background",
      provenance: { origin: "review-fork", executionContext: "unattended", sessionId, profileId },
    })
  })

// when a new live turn starts:
const onLiveTurn = (sessionId: string) =>
  Effect.flatMap(ReviewForks, (forks) => forks.noteLiveTurn(sessionId))
// Acked | Timeout | NoReview — on Timeout the turn proceeds anyway.
```

### Config defaults (`DEFAULT_LEARNING_CONFIG`)

| Key | Default | Architecture ref |
|---|---|---|
| `ackDeadlineMs` | 2000 | §3.5 bounded handshake (2s) |
| `digestCharBudget` | 4000 | §4.5 compact digest |
| `settleWindowMs` | 15_000 | §3.5 idle settle |
| `maxAgeMs` | 30 * 60 * 1000 | §3.5 idle-queue max age |

### Track 1 files

| File | Contents |
|---|---|
| `src/snapshot.ts` | `ConversationSnapshot`, `snapshotFromTurn`, `makeDigest`, `deepFreeze` |
| `src/provenance.ts` | `WriteProvenance` schema, `UnattributedWrite`, `requireProvenance` |
| `src/prompts.ts` | `REVIEW_SYSTEM_PROMPT` (our taxonomy, our words), `parseProposals`, `ReviewParseError` |
| `src/review-types.ts` | `RawProposal`, `ReviewProposal`, `WriteDisposition`, `ForkOutcome`, `ReviewRequest`, `CancelAck`, `LearningConfig` |
| `src/writes.ts` | `UnattendedWriteGate` + `UnattendedWriteGateLive`, `PendingStore` + `InMemoryPendingStore`, `fingerprintPending` |
| `src/forks.ts` | `ReviewForks` + `layerReviewForks`, `ReviewToolset` (dispatch whitelist), `ReviewWorker`, `makeAuxDigestWorker` |
| `src/scheduling.ts` | `ReviewScheduler` + `layerReviewScheduler`, `IdleSignal`, `FakeIdleSignalLive` |
| `test/track1-fixtures.ts` | Provenance/snapshot/worker fixtures, tmp-dir memory + gate + forks layers |
| `test/track1-snapshot-prompts.test.ts`, `test/track1-writes.test.ts`, `test/track1-forks.test.ts`, `test/track1-scheduling.test.ts` | 32 tests, incl. all failure paths |

## Effect 4.0.1 lessons (hard-won, recorded for the next track)

- `Effect.catchAll` / `Effect.zipRight` / `Effect.fork` do not exist —
  use `Effect.catch` (single handler), `andThen`, `forkScoped`/`forkIn`.
- `declare const x: unique symbol` is **type-only** — using it as a value
  throws `ReferenceError` at runtime. The brand needs a real
  module-private `const x: unique symbol = Symbol(...)`.
- `Layer.merge` does **not** wire one side's outputs into the other side's
  requirements at runtime (empirically verified). Use nested
  `Layer.provide` for wiring; layers are memoized by identity within a
  build (verified), so a shared base object builds once.
- `it.effect` provides `TestClock` — `Clock.currentTimeMillis` in tests
  reads test time; derive relative timestamps from it instead of assuming
  wall-clock.
- `claimsForTurn` returns `{ claim, badge }` pairs — claim fields live
  under `.claim`.

### Track 1 additions

- `Option.fromNullable` does not exist — use `Option.fromUndefinedOr` (or
  `Option.fromNullOr`).
- `Schema.decodeUnknown` does not exist — the Effect-returning decoder is
  `Schema.decodeUnknownEffect(schema)(input)` (curried).
- `Duration.DurationInput` does not exist — it is `Duration.Input`.
- `Effect.forkIn` takes `(effect, scope)` — effect first.
- `Cause.pretty` does not render a `Data.TaggedError`'s fields usefully;
  extract typed failures with `Cause.findErrorOption(cause)` and format the
  fields yourself for outcome records.
- There is no `Layer.scoped`. For a layer-lifetime supervision scope, use
  `Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit))`
  inside `Layer.effect`, then `Effect.forkIn(childEffect, scope)`.
- `Layer.provide(effect, layer)` **rebuilds the layer on every call** — each
  `Effect.runPromise(Effect.provide(...))` gets fresh Refs. Tests asserting
  on stateful layers (in-memory stores) must run ONE program per build, not
  one `runPromise` per step.
- `it.effect` freezes time: `Effect.sleep` never advances on its own, so any
  test whose worker does **real I/O** must poll on the live clock
  (`Date.now()` + real sleeps in plain `it`), never a fixed `yieldNow`
  count — 200 yields can spin through in under a millisecond while file I/O
  needs milliseconds under load. Reserve `it.effect` + `TestClock.adjust`
  for genuinely virtual-time logic (deadlines, settle windows, max age).
