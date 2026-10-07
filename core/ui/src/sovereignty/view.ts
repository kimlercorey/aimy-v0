/**
 * sovereignty/view.ts — the toggles panel view.
 *
 * Every §3.6 intent class rendered with its toggle and stated data flow.
 * The cloud-TTS row documents an absence (no toggle — honesty about what
 * isn't collected is part of the surface). The opt-in ledger shows what was
 * opted into, when, with what stated data flow. Offline mode is the one
 * gesture that denies all vendor-network classes.
 */
import type { Html, HtmlBuilder } from "foldkit/html"

import { Message } from "./messages.js"
import { INVENTORY, type InventoryRow, type Model } from "./model.js"

type H = HtmlBuilder<Message>

const toggleButton = (
  h: H,
  classId: string,
  targetId: string | undefined,
  enabled: boolean,
  label: string
): Html =>
  h.button(
    [
      h.OnClick(Message.ToggleFlipRequested({ classId, targetId, enabled: !enabled })),
      h.Class(enabled ? "toggle toggle-on" : "toggle toggle-off"),
      h.Title(enabled ? `Turn ${label} off` : `Turn ${label} on`)
    ],
    [enabled ? "On" : "Off"]
  )

const dataFlow = (h: H, text: string): Html =>
  h.p([h.Class("data-flow")], [text])

const flatRow = (h: H, model: Model, row: InventoryRow, enabled: boolean): Html =>
  h.section([h.Class("toggle-row")], [
    h.div([h.Class("toggle-label")], [
      h.h3([], [row.label]),
      dataFlow(h, row.statedDataFlow)
    ]),
    toggleButton(h, row.classId, undefined, enabled, row.label)
  ])

const perItemRow = (
  h: H,
  itemLabel: string,
  statedDataFlow: string,
  classId: string,
  targetId: string,
  enabled: boolean
): Html =>
  h.section([h.Class("toggle-row toggle-row-nested")], [
    h.div([h.Class("toggle-label")], [
      h.h3([], [itemLabel]),
      dataFlow(h, statedDataFlow)
    ]),
    toggleButton(h, classId, targetId, enabled, itemLabel)
  ])

const absentRow = (h: H, row: InventoryRow): Html =>
  h.section([h.Class("toggle-row toggle-row-absent")], [
    h.div([h.Class("toggle-label")], [
      h.h3([], [row.label]),
      dataFlow(h, row.statedDataFlow)
    ]),
    h.span([h.Class("absent-badge")], ["does not exist"])
  ])

export const view = (model: Model, h: H): Html =>
  h.main([h.Class("sovereignty-panel")], [
    h.header([], [
      h.h2([], ["Sovereignty"]),
      h.p([h.Class("lede")], [
        "Every network call this app wants, listed, with a toggle. Everything starts off except local inference."
      ])
    ]),

    h.section([h.Class("offline-row")], [
      h.div([], [
        h.h3([], ["Offline mode"]),
        h.p([h.Class("data-flow")], [
          "One gesture: denies all vendor-network classes. First-party LAN keeps its own toggles."
        ])
      ]),
      h.button(
        [
          h.OnClick(Message.OfflineModeRequested({ enabled: !model.offlineMode })),
          h.Class(model.offlineMode ? "toggle toggle-on" : "toggle toggle-off")
        ],
        [model.offlineMode ? "On" : "Off"]
      )
    ]),

    ...INVENTORY.flatMap((row): ReadonlyArray<Html> => {
      switch (row.kind) {
        case "toggle": {
          const enabled =
            row.classId === "localInference"
              ? model.localInference
              : row.classId === "updateChecks"
                ? model.updateChecks
                : row.classId === "trustedBroadcast"
                  ? model.trustedBroadcast
                  : row.classId === "telemetry"
                    ? model.telemetry
                    : model.lanDiscoverability
          return [flatRow(h, model, row, enabled)]
        }
        case "perEndpoint":
          return [
            h.section([h.Class("toggle-group")], [
              h.h3([], [row.label]),
              dataFlow(h, row.statedDataFlow),
              ...model.cloudEndpoints.map((e) =>
                perItemRow(h, e.label, "per-endpoint toggle", "cloudEndpoint", e.id, e.enabled)
              )
            ])
          ]
        case "perModule":
          return [
            h.section([h.Class("toggle-group")], [
              h.h3([], [row.label]),
              dataFlow(h, row.statedDataFlow),
              ...model.webResearch.map((m) =>
                perItemRow(h, m.moduleLabel, "per-module toggle", "webResearch", m.moduleId, m.enabled)
              )
            ])
          ]
        case "perPair":
          return [
            h.section([h.Class("toggle-group")], [
              h.h3([], [row.label]),
              dataFlow(h, row.statedDataFlow),
              ...(model.pairSyncScopes.length === 0
                ? [h.p([h.Class("empty-note")], ["No paired instances yet — sync scopes appear after mutual pairing."])]
                : model.pairSyncScopes.map((p) =>
                    perItemRow(
                      h,
                      `${p.pairLabel} — scopes: ${p.scopes.join(", ") || "none"}`,
                      "per-pair toggle",
                      "pairSync",
                      p.pairId,
                      p.enabled
                    )
                  ))
            ])
          ]
        case "absent":
          return [absentRow(h, row)]
      }
    }),

    ...(model.inflightCancelled.length > 0
      ? [
          h.section([h.Class("cancelled-note")], [
            h.p([], [`In-flight egress cancelled for: ${model.inflightCancelled.join(", ")}`])
          ])
        ]
      : []),

    h.section([h.Class("ledger")], [
      h.h3([], ["Opt-in ledger"]),
      ...(model.optInLedger.length === 0
        ? [h.p([h.Class("empty-note")], ["Nothing opted into yet."])]
        : model.optInLedger.map((entry) =>
            h.div([h.Class("ledger-entry")], [
              h.strong([], [entry.label]),
              h.p([h.Class("data-flow")], [entry.statedDataFlow]),
              h.p(
                [h.Class("ledger-times")],
                [
                  `granted ${entry.grantedAt}`,
                  ...(entry.revokedAt !== undefined ? [` — revoked ${entry.revokedAt}`] : [" — active"])
                ]
              )
            ])
          ))
    ])
  ])
