/**
 * audit.ts — lifecycle/outcome separation audit (Hermes #68499).
 *
 * Compaction LIFECYCLE state (staging metadata: the StagedCompaction-shaped
 * records with `verified` flags and `candidateTree` refs) and compaction
 * OUTCOME records (the summary entries actually appended to the tree) are
 * separate types. This auditor verifies the separation holds:
 *
 *   1. no-lifecycle-leakage — no summary entry payload in the tree contains
 *      lifecycle fields (`verified`, `candidateTree`). Lifecycle metadata must
 *      never be persisted as if it were an outcome.
 *   2. references-resolve — every summary entry's `references` resolve to
 *      entries that exist in the tree (preserved originals, never dangling).
 *   3. lifecycle-outcome-linkage — every lifecycle record links to exactly one
 *      outcome or is explicitly terminal:
 *        - committed → its outcome id is in the tree (exactly one outcome),
 *          and it was verified before commit;
 *        - staged (in-flight) → its outcome id is NOT in the tree (an outcome
 *          appearing without a commit is lifecycle/outcome confusion);
 *        - superseded / abandoned → its outcome id is NOT in the tree (a
 *          retired record must not claim an outcome). Retries must mark the
 *          old record superseded/abandoned before restaging — an unresolved
 *          lifecycle record claiming an outcome is an orphan and fails here.
 *
 * Returns a typed audit report: pass/fail per check, violations named.
 */
import { SessionTree } from "./session-tree.js"
import { StagedCompaction } from "./compaction.js"

/** Lifecycle status of one staged compaction record. */
export type LifecycleStatus = "staged" | "committed" | "superseded" | "abandoned"

/** One compaction lifecycle record presented for audit. */
export interface LifecycleRecord {
  readonly staged: StagedCompaction
  readonly status: LifecycleStatus
}

/** One named check in the audit report. */
export interface AuditCheck {
  readonly name: string
  readonly passed: boolean
  readonly violations: ReadonlyArray<string>
}

/** Typed audit report: pass/fail per check, violations named. */
export interface LifecycleOutcomeAudit {
  readonly passed: boolean
  readonly checks: ReadonlyArray<AuditCheck>
}

/** Lifecycle fields that must never appear inside an outcome record's payload. */
const LIFECYCLE_FIELDS = ["verified", "candidateTree"] as const

export const auditLifecycleOutcome = (
  tree: SessionTree,
  records: ReadonlyArray<LifecycleRecord>,
): LifecycleOutcomeAudit => {
  const checks: AuditCheck[] = []
  const ids = new Set(tree.entries.map((e) => e.id))

  // 1. no lifecycle-field leakage into outcome payloads
  const leakViolations: string[] = []
  for (const entry of tree.entries) {
    if (entry.kind !== "summary") continue
    for (const field of LIFECYCLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(entry.payload, field)) {
        leakViolations.push(
          `summary entry ${entry.id} payload leaks lifecycle field "${field}" (lifecycle state persisted as outcome)`,
        )
      }
    }
  }
  checks.push({
    name: "no-lifecycle-leakage",
    passed: leakViolations.length === 0,
    violations: leakViolations,
  })

  // 2. every summary's references resolve to existing entries
  const refViolations: string[] = []
  for (const entry of tree.entries) {
    if (entry.kind !== "summary") continue
    const references: unknown = (entry.payload as { references?: unknown }).references
    if (!Array.isArray(references)) {
      refViolations.push(`summary entry ${entry.id} has no references array (outcome does not name its originals)`)
      continue
    }
    for (const ref of references) {
      if (typeof ref !== "string" || !ids.has(ref)) {
        refViolations.push(`summary entry ${entry.id} references missing entry ${String(ref)}`)
      }
    }
  }
  checks.push({
    name: "references-resolve",
    passed: refViolations.length === 0,
    violations: refViolations,
  })

  // 3. every lifecycle record links to exactly one outcome or is explicitly terminal
  const linkViolations: string[] = []
  for (const record of records) {
    const outcomeId = record.staged.summaryEntry.id
    const outcomePresent = ids.has(outcomeId)
    switch (record.status) {
      case "committed":
        if (!outcomePresent) {
          linkViolations.push(
            `committed lifecycle record claims outcome ${outcomeId} but the outcome is not in the tree (orphan lifecycle record)`,
          )
        }
        if (!record.staged.verified) {
          linkViolations.push(
            `lifecycle record ${outcomeId} is marked committed but was never verified (unverified output committed)`,
          )
        }
        break
      case "staged":
        if (outcomePresent) {
          linkViolations.push(
            `in-flight staged record's outcome ${outcomeId} is in the tree without a commit (lifecycle/outcome confusion)`,
          )
        }
        break
      case "superseded":
      case "abandoned":
        if (outcomePresent) {
          linkViolations.push(
            `${record.status} lifecycle record's outcome ${outcomeId} is in the tree (retired record claiming an outcome)`,
          )
        }
        break
    }
  }
  checks.push({
    name: "lifecycle-outcome-linkage",
    passed: linkViolations.length === 0,
    violations: linkViolations,
  })

  return { passed: checks.every((c) => c.passed), checks }
}
