/**
 * ui/src/timeline/update.ts — the pure update function for the timeline slice.
 *
 * `(Message, Model) → (Model, Command[])`. Archive/restore intents produce
 * Commands; everything else is a local Model transition. The update never
 * performs effects and never mutates: nodes are replaced, never rewritten
 * (Hermes #68499 — the edit outcome is a new node; the Model mirrors that).
 */
import { Update } from "foldkit"
import { modifyFields } from "foldkit/struct"

import { ArchiveTimelineNode, RefreshTimeline, RestoreTimelineNode } from "./commands.js"
import { Message } from "./messages.js"
import {
  deriveEntriesUsed,
  type Model,
} from "./model.js"
import type { LearningTimeline } from "../../../learning/src/timeline.js"

/** Services the slice's Commands need; the shell provides them as `resources`. */
export type TimelineResources = LearningTimeline

export type TimelineUpdateReturn = Update.Return<Model, Message, TimelineResources>

const withNodeReplaced = (model: Model, nodeId: string, node: Model["nodes"][number]): Model =>
  modifyFields(model, {
    nodes: (nodes) => nodes.map((n) => (n.nodeId === nodeId ? node : n)),
  })

export const update = (model: Model, message: Message): TimelineUpdateReturn =>
  Message.match<TimelineUpdateReturn>(message, {
    TimelineRefreshRequested: () => ({
      model: modifyFields(model, {
        status: () => "loading" as const,
        lastError: () => undefined,
      }),
      commands: [RefreshTimeline()],
    }),
    TimelineRefreshed: ({ nodes }) => ({
      model: modifyFields(model, {
        nodes: () => nodes,
        status: () => "ready" as const,
        lastError: () => undefined,
        entriesUsed: () => deriveEntriesUsed(nodes),
      }),
    }),
    TimelineRefreshFailed: ({ reason }) => ({
      model: modifyFields(model, {
        status: () => "error" as const,
        lastError: () => reason,
      }),
    }),
    TimelineNodeTypeFilterChanged: ({ nodeType }) => ({
      model: modifyFields(model, {
        filters: (filters) => ({ ...filters, nodeType }),
      }),
    }),
    TimelineSessionFilterChanged: ({ sessionId }) => ({
      model: modifyFields(model, {
        filters: (filters) => ({ ...filters, sessionId }),
      }),
    }),
    TimelineFromDateFilterChanged: ({ fromDate }) => ({
      model: modifyFields(model, {
        filters: (filters) => ({ ...filters, fromDate }),
      }),
    }),
    TimelineToDateFilterChanged: ({ toDate }) => ({
      model: modifyFields(model, {
        filters: (filters) => ({ ...filters, toDate }),
      }),
    }),
    TimelineShowArchivedToggled: () => ({
      model: modifyFields(model, { showArchived: (v) => !v }),
    }),
    TimelineNodeExpanded: ({ nodeId }) => ({
      model: modifyFields(model, {
        expandedNodeIds: (ids) => (ids.includes(nodeId) ? ids : [...ids, nodeId]),
      }),
    }),
    TimelineNodeCollapsed: ({ nodeId }) => ({
      model: modifyFields(model, {
        expandedNodeIds: (ids) => ids.filter((id) => id !== nodeId),
      }),
    }),
    TimelineNodeArchiveRequested: ({ nodeId, reason }) => ({
      model,
      commands: [ArchiveTimelineNode({ nodeId, reason })],
    }),
    TimelineNodeArchived: ({ node }) => {
      // Keep the local snapshot in sync; the full re-read arrives via the
      // service's own `timeline.node.archived` meta event on next refresh.
      const next = withNodeReplaced(model, node.nodeId, node)
      return {
        model: modifyFields(next, {
          entriesUsed: () => deriveEntriesUsed(next.nodes),
          lastError: () => undefined,
        }),
      }
    },
    TimelineNodeRestoreRequested: ({ nodeId }) => ({
      model,
      commands: [RestoreTimelineNode({ nodeId })],
    }),
    TimelineNodeRestored: ({ node }) => {
      const next = withNodeReplaced(model, node.nodeId, node)
      return {
        model: modifyFields(next, {
          entriesUsed: () => deriveEntriesUsed(next.nodes),
          lastError: () => undefined,
        }),
      }
    },
    TimelineOperationFailed: ({ reason }) => ({
      model: modifyFields(model, { lastError: () => reason }),
    }),
  })
