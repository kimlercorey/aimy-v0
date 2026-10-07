/**
 * export/seam.ts — the shell-provided interpreter for the export command.
 *
 * The slice owns the wizard state machine; the shell owns the five sovereign
 * services the real `exportData` program (core/export/export.ts) requires.
 * The seam is an Effect service: the shell provides the real program at the
 * runtime boundary, tests provide fakes, and the unwired default is
 * fail-closed — an unwired interpreter can never report a phantom success.
 */
import { Context, Effect } from "effect"

import type { ExportReceipt } from "../../../export/bundle.js"
import { ExportError } from "../../../substrate/errors.js"

export interface ExportInterpreterShape {
  /**
   * Run the composed one-click export program against the destination.
   * The shell's implementation runs the real `exportData`, dispatches
   * ExportProgressed per file, then ExportCompleted / ExportVerified.
   */
  readonly run: (destination: string) => Effect.Effect<ExportReceipt, ExportError>
}

export class ExportInterpreter extends Context.Service<ExportInterpreter, ExportInterpreterShape>()(
  "aimy/ui/ExportInterpreter"
) {}

/** Fail-closed default service value: no interpreter wired, no export claimed. */
export const ExportInterpreterUnwired: ExportInterpreterShape = {
  run: (_destination: string): Effect.Effect<ExportReceipt, ExportError> =>
    Effect.fail(new ExportError({ reason: "export:interpreter-not-wired" }))
}
