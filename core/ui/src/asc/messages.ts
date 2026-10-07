/**
 * ASC panel messages — the Schema-defined tagged union for the `asc` slice.
 *
 * The MVP vocabulary (architecture §3.2), plus three slice-internal variants
 * the slice needs to stay honest (each documented below):
 *
 * - `DialComputationArchived` — READ-ONLY WRITE: dispatched ONLY by the ASC
 *   pipeline when it archives a per-turn DialComputation (AscSelfMonitor
 *   preTurn → applyPipelineDials → archive). Per §3.9, dial mutations
 *   dispatched from anywhere else — DevTools, MCP, a module — are rejected
 *   by the update function and logged; this message carries a computation the
 *   pipeline already wrote, never a new dial value. Note what is absent: there
 *   is NO `DialsSetDirectly` variant, from any source (seam S7).
 * - `OtherModelGuardFired` — the guard classified a turn (fired or quiet).
 * - `ErrorTermFired` — claim vs. track record diverged; correction applied.
 * - `AffectTuningChanged` — the user moved a tuning control. The update
 *   function answers with the `RecordTuningChange` command; it never touches
 *   ASC state itself.
 * - `DiagnosticRunCompleted` — the monthly JobRunner diagnostic landed.
 * - `TuningChangeRecorded` — result message of the `RecordTuningChange`
 *   command: the frozen boundary accepted the change (`recordEvidence`
 *   kind "tuningChange" → L1 affect-tuning record + L3 note). A Command must
 *   declare its result messages, and reusing `AffectTuningChanged` as the
 *   result would re-dispatch the command in a loop — so the confirmation
 *   gets its own fact.
 * - `TuningChangeFailed` — the command's effect rejected the change.
 *   Foldkit commands are infallible in the error channel, so failures become
 *   messages, never silent drops (architecture §3.3).
 * - `PreviewRendererChanged` — the renderer selection (avatar/abstract) lives
 *   in this slice (§3.1); this is its only writer. MVP ships abstract.
 */
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

import { ArchivedComputation, ErrorTermEntry, GuardFlagEntry } from "./model.js"

export const Message = defineMessageUnion({
  DialComputationArchived: {
    computation: ArchivedComputation,
  },
  OtherModelGuardFired: {
    classification: GuardFlagEntry,
  },
  ErrorTermFired: {
    firing: ErrorTermEntry,
  },
  AffectTuningChanged: {
    parameter: Schema.String,
    to: Schema.Number,
  },
  DiagnosticRunCompleted: {
    at: Schema.String,
    passed: Schema.Number,
    total: Schema.Number,
    regressedDomains: Schema.Array(Schema.String),
  },
  TuningChangeRecorded: {
    parameter: Schema.String,
    from: Schema.Number,
    to: Schema.Number,
    at: Schema.String,
  },
  TuningChangeFailed: {
    parameter: Schema.String,
    reason: Schema.String,
    at: Schema.String,
  },
  PreviewRendererChanged: {
    renderer: Schema.Literals(["abstract", "avatar"]),
  },
})

export type AscMessage = typeof Message.Type
