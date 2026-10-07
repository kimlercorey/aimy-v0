/**
 * export/model.ts — Schema Model slice for the one-click export wizard.
 *
 * §3.8: one click, a destination picker, a progress indicator, a verification
 * receipt. Verify-before-package: the receipt is only shown once verification
 * passes; a failed verification is fail-closed (no partial bundle, no
 * receipt). The locker section shows the manifest ONLY — ids and metadata,
 * never values (the Schema has no value field to leak).
 */
import { Schema } from "effect"

/** Locker manifest entry: name + scope + created-at ONLY. No value field exists. */
export const LockerManifestEntry = Schema.Struct({
  name: Schema.String,
  scope: Schema.String,
  createdAt: Schema.Number
})
export type LockerManifestEntry = typeof LockerManifestEntry.Type

export const ExportPhase = Schema.Literals(["idle", "destination", "running", "verifying", "complete", "failed"])
export type ExportPhase = typeof ExportPhase.Type

/** Integrity receipt, mirroring the real `ExportReceipt` from core/export/bundle.ts. */
export const ExportReceiptModel = Schema.Struct({
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  instanceId: Schema.String,
  exporterVersion: Schema.String,
  files: Schema.Record(Schema.String, Schema.String),
  bundleHash: Schema.String
})
export type ExportReceiptModel = typeof ExportReceiptModel.Type

export const Model = Schema.Struct({
  phase: ExportPhase,
  destination: Schema.optional(Schema.String),
  filesDone: Schema.Number,
  filesTotal: Schema.Number,
  currentFile: Schema.optional(Schema.String),
  /** Set on completion, shown only once verification passes. */
  receipt: Schema.optional(ExportReceiptModel),
  error: Schema.optional(Schema.String),
  /** Locker manifest only — ids + metadata, never values. */
  lockerManifest: Schema.Array(LockerManifestEntry)
})
export type Model = typeof Model.Type

export const initialModel = (): Model => ({
  phase: "idle",
  filesDone: 0,
  filesTotal: 0,
  lockerManifest: []
})
