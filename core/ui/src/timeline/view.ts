/**
 * ui/src/timeline/view.ts — the learning-timeline view ("learning made visible").
 *
 * A pure function of the slice Model. Renders: the budget header (entries
 * used / budget per store), filters (node type / session / date), the node
 * list with content-fingerprinted ids (truncated), skill verification badges
 * (unverified → verified), expand-to-provenance, and one-click
 * archive/restore. Exported both as a plain `view` (tests, demo) and as a
 * `SubmodelView` via `defineView` (foldChild composition by the shell).
 */
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"

import { Message } from "./messages.js"
import {
  applyFilters,
  labelFor,
  shortNodeId,
  skillVerificationStatus,
  type Model,
  type TimelineNode,
} from "./model.js"

/** All event types, for the type filter dropdown. */
const EVENT_TYPES: ReadonlyArray<TimelineNode["type"]> = [
  "review-fork.proposed-add",
  "review-fork.staged",
  "verification.started",
  "verification.passed",
  "verification.failed",
  "skill.trusted",
  "skill.rejected",
  "avoidance.learned",
  "fossilization.intervention",
  "curator.transitioned",
  "curator.consolidation.proposed",
  "curator.consolidation.adopted",
  "curator.consolidation.rejected",
  "timeline.node.archived",
  "timeline.node.restored",
]

const statusBadge = (status: string): string =>
  status === "verified" ? "badge badge-verified" : status === "rejected" ? "badge badge-rejected" : "badge badge-unverified"

const viewBudgetHeader = (model: Model, h: HtmlBuilder<Message>): Html => {
  const stores = Object.keys(model.budgets).sort()
  const totalUsed = Object.values(model.entriesUsed).reduce((a, b) => a + b, 0)
  const totalBudget = Object.values(model.budgets).reduce((a, b) => a + b, 0)
  return h.section([h.Class("timeline-budgets")], [
    h.h3([], [`learning budget — ${totalUsed} / ${totalBudget} entries used`]),
    h.ul(
      [],
      stores.map((store) => {
        const used = model.entriesUsed[store] ?? 0
        const budget = model.budgets[store] ?? 0
        const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0
        return h.li(
          [h.Class("budget-row")],
          [
            h.span([h.Class("budget-store")], [store]),
            h.span([h.Class("budget-meter")], [
              h.span([h.Class("budget-fill"), h.Style({ width: `${pct}%` })], []),
            ]),
            h.span([h.Class("budget-count")], [`${used} / ${budget}`]),
          ],
        )
      }),
    ),
  ])
}

const viewFilters = (model: Model, h: HtmlBuilder<Message>): Html => {
  const sessions = [...new Set(model.nodes.map((n) => n.provenance.sessionId))].sort()
  return h.section([h.Class("timeline-filters")], [
    h.label([], [
      "type ",
      h.select(
        [
          h.Value(model.filters.nodeType),
          h.OnChange((nodeType) => Message.TimelineNodeTypeFilterChanged({ nodeType })),
        ],
        [
          h.option([h.Value("")], ["all types"]),
          ...EVENT_TYPES.map((t) => h.option([h.Value(t)], [`${labelFor(t)} (${t})`])),
        ],
      ),
    ]),
    h.label([], [
      "session ",
      h.select(
        [
          h.Value(model.filters.sessionId),
          h.OnChange((sessionId) => Message.TimelineSessionFilterChanged({ sessionId })),
        ],
        [
          h.option([h.Value("")], ["all sessions"]),
          ...sessions.map((s) => h.option([h.Value(s)], [s])),
        ],
      ),
    ]),
    h.label([], [
      "from ",
      h.input([
        h.Value(model.filters.fromDate),
        h.Placeholder("2026-10-01"),
        h.OnInput((fromDate) => Message.TimelineFromDateFilterChanged({ fromDate })),
      ]),
    ]),
    h.label([], [
      "to ",
      h.input([
        h.Value(model.filters.toDate),
        h.Placeholder("2026-10-07"),
        h.OnInput((toDate) => Message.TimelineToDateFilterChanged({ toDate })),
      ]),
    ]),
    h.label([], [
      h.input([
        h.Checked(model.showArchived),
        h.OnChange(() => Message.TimelineShowArchivedToggled()),
      ]),
      " show archived",
    ]),
  ])
}

const viewProvenance = (node: TimelineNode, h: HtmlBuilder<Message>): Html =>
  h.dl([h.Class("node-provenance")], [
    h.dt([], ["origin"]),
    h.dd([], [node.provenance.origin]),
    h.dt([], ["session"]),
    h.dd([], [node.provenance.sessionId]),
    h.dt([], ["profile"]),
    h.dd([], [node.provenance.profileId]),
    ...(node.provenance.runId !== undefined
      ? [h.dt([], ["run"]), h.dd([], [node.provenance.runId])] as Array<Html>
      : []),
    h.dt([], ["recorded at"]),
    h.dd([], [node.recordedAt]),
    h.dt([], ["node id (content fingerprint)"]),
    h.dd([], [h.code([], [node.nodeId])]),
    ...(node.subject !== undefined
      ? [h.dt([], ["subject"]), h.dd([], [node.subject])] as Array<Html>
      : []),
    h.dt([], ["evidence"]),
    h.dd([], [node.evidenceIds.length > 0 ? node.evidenceIds.join(", ") : "none"]),
    h.dt([], ["payload"]),
    h.dd([], [h.pre([], [JSON.stringify(node.payload, null, 2)])]),
    ...(node.archivedAt !== undefined
      ? [
          h.dt([], ["archived at"]),
          h.dd([], [`${node.archivedAt} — ${node.archiveReason ?? "no reason"}`]),
        ] as Array<Html>
      : []),
    ...(node.supersedes !== undefined
      ? [h.dt([], ["supersedes"]), h.dd([], [shortNodeId(node.supersedes)])] as Array<Html>
      : []),
    ...(node.supersededBy !== undefined
      ? [h.dt([], ["superseded by"]), h.dd([], [shortNodeId(node.supersededBy)])] as Array<Html>
      : []),
  ])

const viewNode = (
  model: Model,
  node: TimelineNode,
  h: HtmlBuilder<Message>,
): Html => {
  const expanded = model.expandedNodeIds.includes(node.nodeId)
  const archived = node.archivedAt !== undefined
  const verification =
    node.subject !== undefined && node.type !== "timeline.node.archived" && node.type !== "timeline.node.restored"
      ? skillVerificationStatus(node.subject, model.nodes)
      : null
  return h.li(
    [h.Class(`timeline-node${archived ? " archived" : ""}`), h.Key(node.nodeId)],
    [
      h.div([h.Class("node-head")], [
        h.span([h.Class("node-type")], [labelFor(node.type)]),
        ...(node.subject !== undefined
          ? [h.span([h.Class("node-subject")], [node.subject])]
          : []),
        ...(verification !== null && verification !== "unknown"
          ? [h.span([h.Class(statusBadge(verification))], [verification])]
          : []),
        h.span([h.Class("node-id"), h.Title(node.nodeId)], [`#${shortNodeId(node.nodeId)}`]),
        h.time([], [node.recordedAt]),
        h.button(
          [
            h.OnClick(
              expanded
                ? Message.TimelineNodeCollapsed({ nodeId: node.nodeId })
                : Message.TimelineNodeExpanded({ nodeId: node.nodeId }),
            ),
          ],
          [expanded ? "collapse" : "provenance"],
        ),
        archived
          ? h.button(
              [h.OnClick(Message.TimelineNodeRestoreRequested({ nodeId: node.nodeId }))],
              ["restore"],
            )
          : h.button(
              [
                h.OnClick(
                  Message.TimelineNodeArchiveRequested({
                    nodeId: node.nodeId,
                    reason: "archived from timeline view",
                  }),
                ),
              ],
              ["archive"],
            ),
      ]),
      ...(expanded ? [viewProvenance(node, h)] : []),
    ],
  )
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section([h.Class("timeline-panel")], [
    h.h2([], ["learning timeline"]),
    h.p([h.Class("timeline-sub")], [
      "every learning event, content-fingerprinted. Archive removes from view — never destroys.",
    ]),
    viewBudgetHeader(model, h),
    viewFilters(model, h),
    model.status === "loading" ? h.p([], ["loading timeline…"]) : null,
    model.status === "error"
      ? h.p([h.Class("error")], [`timeline failed to load: ${model.lastError ?? "unknown"}`])
      : null,
    h.p([], [
      h.button([h.OnClick(Message.TimelineRefreshRequested())], ["refresh"]),
    ]),
    h.ul(
      [h.Class("timeline-nodes")],
      applyFilters(model.nodes, model.filters, model.showArchived).map((node) =>
        viewNode(model, node, h),
      ),
    ),
  ])

/** The document wrapper for standalone render (demo / SSR). */
export const viewDocument = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "AImy — learning timeline",
  body: view(model, h),
})

/** Submodel view for foldChild composition by the shell (Track 1). */
export const timelineSubmodelView = defineView<Model, Message>((model, h) => view(model, h))
