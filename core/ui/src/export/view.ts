/**
 * export/view.ts — the export wizard view.
 *
 * One click, a destination, progress, then the integrity receipt. The locker
 * section renders the manifest ONLY — ids and metadata, never values. If a
 * secret value ever reached this state there would be no field to render it
 * into; the test asserts the serialized state cannot contain one.
 */
import type { Html, HtmlBuilder } from "foldkit/html"

import { Message } from "./messages.js"
import { type Model } from "./model.js"

type H = HtmlBuilder<Message>

const phaseView = (model: Model, h: H): Html => {
  switch (model.phase) {
    case "idle":
      return h.section([h.Class("export-idle")], [
        h.h3([], ["Take everything with you"]),
        h.p([], ["One click. Your memory, skills, identity, modules, and learning — verified, then packaged."]),
        h.button(
          [h.OnClick(Message.ExportDestinationChanged({ destination: "" })), h.Class("primary")],
          ["Choose destination"]
        )
      ])
    case "destination":
      return h.section([h.Class("export-destination")], [
        h.h3([], ["Where should the bundle go?"]),
        h.input([
          h.Type("text"),
          h.Placeholder("/path/to/aimy-export"),
          h.Value(model.destination ?? ""),
          h.OnInput((destination) => Message.ExportDestinationChanged({ destination }))
        ]),
        h.div([h.Class("row")], [
          h.button(
            [
              h.OnClick(
                Message.ExportRequested({ destination: (model.destination ?? "").trim() })
              ),
              h.Disabled((model.destination ?? "").trim().length === 0)
            ],
            ["Export"]
          ),
          h.button([h.OnClick(Message.ExportDismissed())], ["Cancel"])
        ])
      ])
    case "running":
      return h.section([h.Class("export-progress")], [
        h.h3([], ["Exporting…"]),
        h.p(
          [],
          [
            model.filesTotal > 0
              ? `${model.filesDone} / ${model.filesTotal} files`
              : "Starting…"
          ]
        ),
        ...(model.currentFile !== undefined ? [h.p([h.Class("current-file")], [model.currentFile])] : [])
      ])
    case "verifying":
      return h.section([h.Class("export-verifying")], [
        h.h3([], ["Verifying integrity…"]),
        h.p([], ["Hashes are checked before the bundle is trusted. The receipt appears only if verification passes."])
      ])
    case "complete": {
      const receipt = model.receipt
      if (receipt === undefined) {
        return h.section([h.Class("export-error")], [h.p([], ["Export completed without a receipt — this should not happen."])])
      }
      const fileCount = Object.keys(receipt.files).length
      return h.section([h.Class("export-receipt")], [
        h.h3([], ["Export verified"]),
        h.p([h.Class("verified-badge")], ["integrity receipt"]),
        h.ul([], [
          h.li([], [`Exported at: ${receipt.exportedAt}`]),
          h.li([], [`Instance: ${receipt.instanceId}`]),
          h.li([], [`Exporter: ${receipt.exporterVersion}`]),
          h.li([], [`Files: ${fileCount}`]),
          h.li([], [`Bundle hash: ${receipt.bundleHash}`])
        ]),
        h.button([h.OnClick(Message.ExportDismissed())], ["Done"])
      ])
    }
    case "failed":
      return h.section([h.Class("export-failed")], [
        h.h3([], ["Export failed — nothing was kept"]),
        h.p([], ["Verification did not pass, so no partial bundle ships. Fail-closed."]),
        ...(model.error !== undefined ? [h.p([h.Class("error-reason")], [model.error])] : []),
        h.button([h.OnClick(Message.ExportDismissed())], ["Dismiss"])
      ])
  }
}

export const view = (model: Model, h: H): Html =>
  h.main([h.Class("export-wizard")], [
    h.header([], [
      h.h2([], ["Export"]),
      h.p([h.Class("lede")], ["Sovereignty = control + exit. Your data, out, in one piece."])
    ]),
    phaseView(model, h),
    h.section([h.Class("locker-manifest")], [
      h.h3([], ["Secret locker"]),
      h.p([h.Class("lede")], ["Manifest only — which secrets exist, never their values. Re-import asks you to re-enter them."]),
      ...(model.lockerManifest.length === 0
        ? [h.p([h.Class("empty-note")], ["No secrets stored."])]
        : [
            h.ul(
              [],
              model.lockerManifest.map((entry) =>
                h.li(
                  [],
                  [`${entry.name} — scope: ${entry.scope}, stored: ${new Date(entry.createdAt).toISOString()}`]
                )
              )
            )
          ])
    ])
  ])
