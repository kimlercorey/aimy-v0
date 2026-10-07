/**
 * export/messages.ts — ExportRequested → ExportProgressed → ExportCompleted →
 * ExportVerified, driven by the real DataExport program (§3.2, §3.8).
 */
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

import { ExportReceiptModel, LockerManifestEntry } from "./model.js"

export const Message = defineMessageUnion({
  ExportDestinationChanged: { destination: Schema.String },
  ExportRequested: { destination: Schema.String },
  ExportProgressed: {
    currentFile: Schema.String,
    filesDone: Schema.Number,
    filesTotal: Schema.Number
  },
  ExportCompleted: { receipt: ExportReceiptModel },
  ExportVerified: { receipt: ExportReceiptModel },
  ExportFailed: { reason: Schema.String },
  LockerManifestLoaded: { entries: Schema.Array(LockerManifestEntry) },
  ExportDismissed: {}
})
export type Message = typeof Message.Type
