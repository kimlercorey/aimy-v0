/**
 * ui/src/timeline/model.ts — the learning-timeline Schema Model slice.
 *
 * Architecture §3.7 ("learning made visible"): the timeline is the trust UX
 * for the Continuity pillar. This slice is a pure projection of the M6
 * `LearningTimeline` store (learning/src/timeline.ts) — Schema-defined,
 * content-fingerprinted node ids, archive-on-delete (never hard delete).
 *
 * The slice is deliberately store-fed: `nodes` is a snapshot of the real
 * store, refreshed by the `RefreshTimeline` Command (commands.ts). Views are
 * pure functions of this state.
 */
import { Schema } from "effect"

/** Every M6 `LearningEventType` — the closed union from learning/src/timeline.ts. */
export const LearningEventTypeSchema = Schema.Literals([
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
])
export type LearningEventType = typeof LearningEventTypeSchema.Type

/** `Provenance.origin` — every write carries provenance (architecture §3.7). */
export const ProvenanceOriginSchema = Schema.Literals([
  "review-fork",
  "verification-arm",
  "curator",
  "fossilization-guard",
  "user",
  "system",
])

export const ProvenanceSchema = Schema.Struct({
  origin: ProvenanceOriginSchema,
  sessionId: Schema.String,
  profileId: Schema.String,
  runId: Schema.optional(Schema.String),
})
export type TimelineProvenance = typeof ProvenanceSchema.Type

/** A timeline node as the UI sees it: the persisted `LearningNode`, frozen into the Model. */
export const TimelineNodeSchema = Schema.Struct({
  nodeId: Schema.String,
  type: LearningEventTypeSchema,
  recordedAt: Schema.String,
  provenance: ProvenanceSchema,
  subject: Schema.optional(Schema.String),
  evidenceIds: Schema.Array(Schema.String),
  payload: Schema.Unknown,
  archivedAt: Schema.optional(Schema.String),
  archiveReason: Schema.optional(Schema.String),
  supersedes: Schema.optional(Schema.String),
  supersededBy: Schema.optional(Schema.String),
})
export type TimelineNode = typeof TimelineNodeSchema.Type

export const TimelineFiltersSchema = Schema.Struct({
  /** "" = all types. Otherwise a `LearningEventType`. */
  nodeType: Schema.String,
  /** "" = all sessions. */
  sessionId: Schema.String,
  /** "" = no lower bound. ISO date prefix, e.g. "2026-10-07". */
  fromDate: Schema.String,
  /** "" = no upper bound. ISO date prefix. */
  toDate: Schema.String,
})
export type TimelineFilters = typeof TimelineFiltersSchema.Type

export const TimelineStatusSchema = Schema.Literals(["loading", "ready", "error"])
export type TimelineStatus = typeof TimelineStatusSchema.Type

/**
 * Memory-bloat budgets, per store (architecture §3.7: "each store has an
 * explicit budget shown in the timeline header (entries used / budget)").
 *
 * These are UI-declared defaults. The M6 services do not yet expose a budget
 * API, so the budgets live here, inspectable in the Model, until the services
 * grow one. Stores mirror the learning pipeline's `ProposedAddPayload.store`.
 */
export const DEFAULT_STORE_BUDGETS: Readonly<Record<string, number>> = {
  profile: 500,
  environment: 500,
  skills: 200,
  session: 200,
}

/** The timeline slice Model. */
export const Model = Schema.Struct({
  /** Snapshot of the store, newest first. Fed by `RefreshTimeline`. */
  nodes: Schema.Array(TimelineNodeSchema),
  filters: TimelineFiltersSchema,
  /** When true, archived (tombstoned) nodes are shown dimmed. */
  showArchived: Schema.Boolean,
  /** Node ids with their provenance expanded. */
  expandedNodeIds: Schema.Array(Schema.String),
  status: TimelineStatusSchema,
  lastError: Schema.optional(Schema.String),
  /** Entries used per store (derived on refresh); budgets are explicit. */
  entriesUsed: Schema.Record(Schema.String, Schema.Number),
  budgets: Schema.Record(Schema.String, Schema.Number),
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  nodes: [],
  filters: { nodeType: "", sessionId: "", fromDate: "", toDate: "" },
  showArchived: false,
  expandedNodeIds: [],
  status: "loading",
  lastError: undefined,
  entriesUsed: {},
  budgets: { ...DEFAULT_STORE_BUDGETS },
}

/** §3.7 human labels for each M6 event type. */
export const labelFor = (type: LearningEventType): string => {
  switch (type) {
    case "review-fork.proposed-add":
      return "memory entry learned"
    case "review-fork.staged":
      return "staged change (awaiting approval)"
    case "verification.started":
      return "skill verification started"
    case "verification.passed":
      return "skill verification passed"
    case "verification.failed":
      return "skill verification failed"
    case "skill.trusted":
      return "skill verified ✓"
    case "skill.rejected":
      return "skill rejected"
    case "avoidance.learned":
      return "avoidance learned"
    case "fossilization.intervention":
      return "fossilization intervention"
    case "curator.transitioned":
      return "curator transition"
    case "curator.consolidation.proposed":
      return "consolidation proposed"
    case "curator.consolidation.adopted":
      return "consolidation adopted"
    case "curator.consolidation.rejected":
      return "consolidation rejected"
    case "timeline.node.archived":
      return "node archived"
    case "timeline.node.restored":
      return "node restored"
  }
}

/**
 * A skill's verification status across the timeline, keyed by `subject`:
 * Hermes #25833 — a skill node shows *unverified → verified* as it passes the
 * independent arm. Derived from node types, never stored.
 */
export const skillVerificationStatus = (
  subject: string,
  nodes: ReadonlyArray<TimelineNode>,
): "unverified" | "verified" | "rejected" | "unknown" => {
  const related = nodes.filter((n) => n.subject === subject)
  if (related.some((n) => n.type === "skill.trusted")) return "verified"
  if (related.some((n) => n.type === "skill.rejected")) return "rejected"
  if (
    related.some(
      (n) =>
        n.type === "verification.started" ||
        n.type === "verification.passed" ||
        n.type === "review-fork.proposed-add",
    )
  )
    return "unverified"
  return "unknown"
}

/** Truncated content-fingerprint display (full id stays in the Model / store). */
export const shortNodeId = (nodeId: string): string => nodeId.slice(0, 12)

/** Pure filter: mirrors `TimelineQuery` semantics over the snapshot. */
export const applyFilters = (
  nodes: ReadonlyArray<TimelineNode>,
  filters: TimelineFilters,
  showArchived: boolean,
): ReadonlyArray<TimelineNode> =>
  nodes.filter((node) => {
    if (!showArchived && node.archivedAt !== undefined) return false
    if (filters.nodeType !== "" && node.type !== filters.nodeType) return false
    if (filters.sessionId !== "" && node.provenance.sessionId !== filters.sessionId) return false
    if (filters.fromDate !== "" && node.recordedAt < filters.fromDate) return false
    if (filters.toDate !== "" && node.recordedAt > filters.toDate) return false
    return true
  })

/**
 * Entries-used per store, derived from the node snapshot. `proposed-add`
 * nodes carry their store in the payload; everything else counts under
 * "pipeline" (the verification/arm/curator machinery).
 */
export const deriveEntriesUsed = (
  nodes: ReadonlyArray<TimelineNode>,
): Record<string, number> => {
  const used: Record<string, number> = {}
  for (const node of nodes) {
    if (node.archivedAt !== undefined) continue
    const store =
      node.type === "review-fork.proposed-add" &&
      typeof (node.payload as { store?: unknown })?.store === "string"
        ? (node.payload as { store: string }).store
        : "pipeline"
    used[store] = (used[store] ?? 0) + 1
  }
  return used
}
