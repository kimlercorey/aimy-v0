/**
 * export/update.ts — pure update for the export wizard.
 *
 * destination → progress → verification receipt. The receipt staged by
 * ExportCompleted is not shown until ExportVerified; ExportFailed clears it —
 * a failed verification ships no partial bundle and shows no receipt.
 */
import type { Return as UpdateReturn } from "foldkit/update"

import { ExportBundle } from "./commands.js"
import { ExportInterpreter } from "./seam.js"
import { Message } from "./messages.js"
import { initialModel, type Model } from "./model.js"

type Return = UpdateReturn<Model, Message, ExportInterpreter>

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ExportDestinationChanged: ({ destination }) => ({
      model: { ...model, destination, phase: "destination" }
    }),
    ExportRequested: ({ destination }) => ({
      model: {
        ...initialModel(),
        phase: "running",
        destination,
        lockerManifest: model.lockerManifest
      },
      commands: [ExportBundle({ destination })]
    }),
    ExportProgressed: ({ currentFile, filesDone, filesTotal }) => ({
      model: { ...model, phase: "running", currentFile, filesDone, filesTotal }
    }),
    ExportCompleted: ({ receipt }) => ({
      // Staged, not shown: the receipt is only displayed after verification.
      model: { ...model, phase: "verifying", receipt, error: undefined }
    }),
    ExportVerified: ({ receipt }) => ({
      model: { ...model, phase: "complete", receipt, error: undefined }
    }),
    ExportFailed: ({ reason }) => ({
      // Fail-closed: no receipt, no bundle path — nothing partial survives.
      model: { ...model, phase: "failed", receipt: undefined, error: reason }
    }),
    LockerManifestLoaded: ({ entries }) => ({
      model: { ...model, lockerManifest: entries }
    }),
    ExportDismissed: () => ({
      model: { ...initialModel(), lockerManifest: model.lockerManifest }
    })
  })
