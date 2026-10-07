/**
 * learning/types.ts — shared shapes for M6 Track 2:
 * quarantine → verification arm → evidence gate → trusted, plus curator.
 *
 * A `CandidateSkill` is a skill the learning loop wrote or modified and
 * submitted for verification. It carries an EXECUTABLE contract
 * (`behaviorCases`) — input/output assertions the arm runs through the
 * judges framework. A candidate with an empty contract has no executable
 * checks: the evidence gate rejects it as prompt-only by construction
 * (see gate.ts — "LLM proposes, evidence disposes").
 */

/** One executable input/output assertion from the skill's declared contract. */
export interface BehaviorCase {
  readonly caseId: string
  readonly description: string
  readonly input: unknown // JSON-serializable
  readonly expect: unknown // JSON-serializable
}

/**
 * One held-out eval case OWNED BY THE ARM (never by the candidate).
 * The candidate never sees these; they measure downstream outcome
 * (Hermes #96704 — the measurement is built with the loop, not after).
 */
export interface EvalCase {
  readonly evalId: string
  readonly description: string
  readonly input: unknown // JSON-serializable
  readonly expect: unknown // JSON-serializable
}

/** A skill submitted for verification. */
export interface CandidateSkill {
  readonly skillId: string
  readonly name: string
  readonly version: string
  /** SKILL.md package text (frontmatter + body). The arm reads the contract from this. */
  readonly skillMd: string
  /**
   * Inference lane that authored the skill, e.g. "foreground" or
   * "review-fork:<id>". The arm requires the critic lane to differ —
   * author ≠ inspector, structurally (Hermes #25833).
   */
  readonly authorLane: string
  readonly authorKind: "model" | "human"
  readonly proposedAt: string // ISO timestamp
  /**
   * Executable behavior contract declared by the package. The arm's
   * GENERATED TESTS mechanism executes these through the judges framework.
   */
  readonly behaviorCases: ReadonlyArray<BehaviorCase>
  /**
   * Task cases this skill covers. The curator uses the union of absorbed
   * skills' covered cases to prove absorption on consolidation
   * (Hermes #29912 — archive requires verified absorption).
   */
  readonly coveredCases: ReadonlyArray<EvalCase>
}
