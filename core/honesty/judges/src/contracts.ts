/**
 * honesty/judges/contracts.ts
 *
 * Shared type contracts for ThinkingBox executable judges (M3 honesty layer).
 *
 * These shapes are a cross-track contract shared with the HonestyService
 * evidence ledger (Track 1): Track 1 stores `JudgeVerdict` records produced
 * here. Implement the shapes below EXACTLY — do not rename fields, change
 * literal types, or add required fields.
 */

import type { Schema } from "effect"

/** Outcome of one tool call, normalized at the module-seam boundary. */
export type SideEffectOutcome = "ok" | "io-error" | "blocked" | "denied"

export interface SideEffectRecord {
  readonly toolCallId: string
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  readonly outcome: SideEffectOutcome
  readonly resultSummary: string // short, human-readable
}

/** The frozen evidence bundle a judge is allowed to see. Nothing else. */
export interface JudgeInput {
  readonly taskId: string
  readonly claim: string // the task's declared claim
  readonly finalState: unknown // JSON-serializable snapshot
  readonly sideEffects: ReadonlyArray<SideEffectRecord>
  readonly dialogue: ReadonlyArray<{ readonly role: string; readonly text: string }>
}

/**
 * Canonical `JudgeVerdict` lives with the HonestyService evidence ledger
 * (honesty/src/types.ts) — the ledger stores verdicts, so it owns the shape.
 * Re-exported here so judges-package consumers have a single import path.
 * Do NOT redefine it here; structural drift between two definitions is a
 * silent composition break.
 */
import type { JudgeVerdict } from "../../src/types.js"
export type { JudgeVerdict }

export interface JudgeDefinition {
  readonly id: string
  readonly version: string
  readonly description: string
  /**
   * PURE and DETERMINISTIC: no randomness, no clock, no I/O, no LLM.
   * Same JudgeInput → byte-identical JudgeVerdict (except ranAt).
   *
   * Concretely: `run` must never call Date.now(), Math.random(), fetch, or
   * read process state. `ranAt` is stamped by the runner AFTER `run`
   * returns (see runner.ts), so judges leave it as the empty sentinel.
   * `verdictId` must equal the deterministic hash documented on
   * JudgeVerdict — the runner recomputes it and rejects mismatches.
   */
  readonly run: (input: JudgeInput) => JudgeVerdict
}

import type {
  JudgeInputInvalid,
  JudgeNotFound,
  JudgeThrew,
  JudgeVerdictInvalid,
} from "./errors.js"

/** The typed error union for everything judges/registry/runner can fail with. */
export type JudgeError = JudgeNotFound | JudgeInputInvalid | JudgeThrew | JudgeVerdictInvalid
