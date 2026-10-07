# M9 acceptance — the 10k-turn session

Runnable: `memory/test/m9-demo.test.ts` (deterministic: mulberry32 seed 20261007,
fixed timestamps; no network, no wall-clock dependence).

## What it does

Builds a 10,000-turn session (2 pinned entries — system prompt, identity
policy — then 10,000 message turns) and runs it through the full production
path: per-turn `recordTurn` accounting, `shouldCompact` trigger checks, and —
when the trigger fires — the complete quarantine pipeline
(`snapshotPrefix` → `stageCompactionProtected` → `verifyStaged` →
`verifyPrefixStable` → real `commitCompaction` through the service →
`verifyPins` → `applyRelief` → lifecycle-record collection).

Provider shapes alternate per turn (even turns report reasoning tokens, odd
turns use the labeled 2× conservative estimate) — the cross-provider case.

## Run output (2026-10-07)

```
M9 DEMO — 10k-turn session
turns: 10000 | compactions: 13 at turns 761,1523,2285,3046,3808,4570,5331,6094,6856,7619,8381,9145,9906
cache-hit rates: 1.00,1.00,1.00,1.00,1.00,1.00,1.00,1.00,1.00,1.00,1.00,1.00,1.00
max effective pressure: 70.1% (ceiling 100% — never wedged)
threshold tightening (Pi #9409): ACTIVE
pins verified byte-identical: 2 (across every compaction)
lifecycle/outcome audit: PASS (3 checks)
final entries: 10015 (originals preserved, summaries appended)
```

## What the demo proves

- **Repeated compaction**: 13 quarantine-gated compactions across the session.
- **Pins byte-identical**: both pins verified after every compaction and at
  the end (payload bytes equal to pin time).
- **Cache-hit rate 1.00 every cycle**: the frozen prefix never diverges —
  the Hermes #130909 silent-cost-multiplier is measured, not assumed.
- **Never wedges**: max effective pressure 70.1% against a 100% ceiling; the
  per-turn assertion (`ratio < 1.0`) held for all 10,000 turns.
- **Pi #9409 answered**: threshold tightening was active (estimated reasoning
  present from turn 1, trigger at 70% instead of 80%).
- **Lifecycle ≠ outcome**: the audit over all 13 lifecycle records passed —
  no field leakage, no orphan records, no dangling references.

## Incidental finding (fixed)

Building this demo exposed a real scalability bug in the safety-critical
path: `checkInvariants` was O(n²) with a large constant (43s on a 10k-entry
session), which made the quarantine gate unusable at production scale.
Rewrote as a single memoized pass — O(n), 105ms on the same session, same
checks, same error messages. The demo doing its job: adversarial means
adversarial.
