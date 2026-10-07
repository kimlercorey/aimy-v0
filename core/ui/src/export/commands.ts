/**
 * export/commands.ts — the ExportBundle command.
 *
 * The update emits this on ExportRequested. The shell's interpreter runs the
 * real DataExport program and dispatches ExportProgressed per file, then
 * ExportCompleted (bundle written) and ExportVerified (verifyBundle re-read
 * the bundle from disk and the hashes matched) — or ExportFailed, fail-closed.
 * The slice's own execute collapses to the terminal message; the default
 * interpreter is unwired and fails closed.
 */
import { Effect, Schema } from "effect"
import * as Command from "foldkit/command"

import type { ExportReceipt } from "../../../export/bundle.js"
import { Message } from "./messages.js"
import { type ExportReceiptModel } from "./model.js"
import { ExportInterpreter } from "./seam.js"

const toReceiptModel = (receipt: ExportReceipt): ExportReceiptModel => ({
  version: 1,
  exportedAt: receipt.exportedAt,
  instanceId: receipt.instanceId,
  exporterVersion: receipt.exporterVersion,
  files: receipt.files,
  bundleHash: receipt.bundleHash
})

export const ExportBundle = Command.define("ExportBundle", {
  args: { destination: Schema.String },
  messages: [
    Message.ExportProgressed,
    Message.ExportCompleted,
    Message.ExportVerified,
    Message.ExportFailed
  ],
  execute: ({ destination }) =>
    Effect.match(Effect.flatMap(ExportInterpreter, (interpreter) => interpreter.run(destination)), {
      onFailure: (error) => Message.ExportFailed({ reason: error.reason }),
      onSuccess: (receipt) => Message.ExportVerified({ receipt: toReceiptModel(receipt) })
    })
})
