/**
 * learning/timeline.ts — the learning timeline data model and its store seam.
 *
 * Architecture §3.6 ("learning made visible"): every learning event is a node
 * with a content-fingerprinted id. Nodes are append-only; "delete" archives
 * (tombstone with restore) — NEVER destroys. Destructive learning operations
 * proposed by forks appear here as *staged*, awaiting approval.
 *
 * This file is the data model + store seam only — NO UI (that's M8). The
 * Foldkit shell will read through `LearningTimeline.query` (or through
 * `MemoryService` read APIs once the durable backing lands — see README).
 *
 * Design notes:
 * - `nodeId` is SHA-256 over canonical content (type + recordedAt +
 *   provenance + subject + evidenceIds + payload), following the judges'
 *   `verdictIdFor` pattern (honesty/judges/src/canonical.ts). Tombstoning a
 *   node does NOT change its id: the id fingerprints the event content, not
 *   the archive state.
 * - Re-recording the same event (same content AND same `recordedAt`) returns
 *   the existing node — idempotent re-record, same as the honesty ledger's
 *   `recordClaim`. Callers that want two distinct nodes for two occurrences
 *   use distinct timestamps (the default).
 * - Edit = append a new node with `supersedes` + archive the old one as
 *   "edited" with `supersededBy`. History is never rewritten (Hermes #68499:
 *   lifecycle state machines and outcome records stay separate — the edit
 *   outcome is a new outcome record; the old node's archive state is the
 *   lifecycle record).
 */
import { Context, Effect, Layer } from "effect"
import { canonicalJson, sha256Hex } from "../../honesty/judges/src/canonical.js"
import {
  NodeAlreadyArchived,
  NodeNotArchived,
  NodeNotFound,
  UnserializablePayload,
  type LearningError,
} from "./errors.js"

/** Where a learning event came from. Architecture §3.7: every write carries provenance. */
export interface Provenance {
  readonly origin: "review-fork" | "verification-arm" | "curator" | "fossilization-guard" | "user" | "system"
  readonly sessionId: string
  readonly profileId: string
  readonly runId?: string
}

/** The envelope every `LearningEvent` carries; the payload is type-specific. */
export interface EventEnvelope {
  readonly provenance: Provenance
  /** The skill/memory/behavior id this event is about — the queryable subject. */
  readonly subject?: string
  /** Honesty-ledger claim ids backing this event (empty when none). */
  readonly evidenceIds: ReadonlyArray<string>
  /** ISO timestamp. Defaults to "now" in `recordEvent`; override for idempotent re-record. */
  readonly recordedAt?: string
}

// ─── Event payloads ──────────────────────────────────────────────────────────
// One payload per event type. These are the wire contract Track 2's pipeline
// (forks → verification arm → evidence gate → curator) emits; `recordEvent`
// turns each emission into a timeline node automatically.

export interface ProposedAddPayload {
  readonly store: "profile" | "environment" | "skills" | "session"
  readonly summary: string
}

export interface StagedPayload {
  readonly operation: "replace" | "remove"
  readonly summary: string
  readonly requiresApproval: true
}

export interface VerificationStartedPayload {
  readonly judgeIds: ReadonlyArray<string>
}

export interface VerificationPassedPayload {
  readonly verdictIds: ReadonlyArray<string>
}

export interface VerificationFailedPayload {
  readonly verdictIds: ReadonlyArray<string>
  readonly reasons: ReadonlyArray<string>
}

export interface SkillTrustedPayload {
  readonly judgeVersions: ReadonlyArray<string>
}

export interface SkillRejectedPayload {
  readonly reasons: ReadonlyArray<string>
}

export interface AvoidanceLearnedPayload {
  readonly ruleId: string
  readonly behavior: string
  readonly classification: "transient" | "persistent" | "unknown"
  readonly expiresAt: string
  readonly reason: string
}

export interface FossilizationInterventionPayload {
  readonly ruleId: string
  readonly behavior: string
  readonly decision: "lifted" | "renewed"
  readonly previousVersion: number
  readonly newVersion?: number
  readonly probeSummary: string
}

export interface CuratorTransitionedPayload {
  readonly from: "active" | "stale" | "archived"
  readonly to: "active" | "stale" | "archived"
  readonly reason: string
}

export interface CuratorConsolidationPayload {
  readonly umbrellaSkill: string
  readonly absorbedSkills: ReadonlyArray<string>
  readonly evidenceGateReportId?: string
}

export interface NodeArchivedPayload {
  readonly targetNodeId: string
  readonly reason: string
}

export interface NodeRestoredPayload {
  readonly targetNodeId: string
  readonly reason: string
}

/**
 * The event union Track 2's pipeline emits. Every pipeline transition —
 * fork proposal, arm verification start/pass/fail, gate trust/reject,
 * curator transition/consolidation — is one of these, and `recordEvent`
 * turns it into a node automatically.
 */
export type LearningEvent =
  | (EventEnvelope & { readonly type: "review-fork.proposed-add"; readonly payload: ProposedAddPayload })
  | (EventEnvelope & { readonly type: "review-fork.staged"; readonly payload: StagedPayload })
  | (EventEnvelope & { readonly type: "verification.started"; readonly payload: VerificationStartedPayload })
  | (EventEnvelope & { readonly type: "verification.passed"; readonly payload: VerificationPassedPayload })
  | (EventEnvelope & { readonly type: "verification.failed"; readonly payload: VerificationFailedPayload })
  | (EventEnvelope & { readonly type: "skill.trusted"; readonly payload: SkillTrustedPayload })
  | (EventEnvelope & { readonly type: "skill.rejected"; readonly payload: SkillRejectedPayload })
  | (EventEnvelope & { readonly type: "avoidance.learned"; readonly payload: AvoidanceLearnedPayload })
  | (EventEnvelope & { readonly type: "fossilization.intervention"; readonly payload: FossilizationInterventionPayload })
  | (EventEnvelope & { readonly type: "curator.transitioned"; readonly payload: CuratorTransitionedPayload })
  | (EventEnvelope & { readonly type: "curator.consolidation.proposed"; readonly payload: CuratorConsolidationPayload })
  | (EventEnvelope & { readonly type: "curator.consolidation.adopted"; readonly payload: CuratorConsolidationPayload })
  | (EventEnvelope & { readonly type: "curator.consolidation.rejected"; readonly payload: CuratorConsolidationPayload })
  | (EventEnvelope & { readonly type: "timeline.node.archived"; readonly payload: NodeArchivedPayload })
  | (EventEnvelope & { readonly type: "timeline.node.restored"; readonly payload: NodeRestoredPayload })

export type LearningEventType = LearningEvent["type"]

/** A timeline node: the persisted form of one `LearningEvent`. Fully JSON-serializable. */
export interface LearningNode {
  readonly nodeId: string
  readonly type: LearningEventType
  readonly recordedAt: string // ISO timestamp
  readonly provenance: Provenance
  readonly subject?: string
  readonly evidenceIds: ReadonlyArray<string>
  readonly payload: unknown
  /** Tombstone: set by `archiveNode`. The node is never removed from the store. */
  readonly archivedAt?: string
  readonly archiveReason?: string
  /** Edit chain: the node this one supersedes / the node that superseded this one. */
  readonly supersedes?: string
  readonly supersededBy?: string
}

/** The deterministic node id: sha256 over `type\n` + canonical content. */
export const nodeIdFor = (event: LearningEvent, recordedAt: string): string => {
  const body: Record<string, unknown> = {
    type: event.type,
    recordedAt,
    provenance: event.provenance,
    evidenceIds: event.evidenceIds,
    payload: event.payload,
  }
  if (event.subject !== undefined) body["subject"] = event.subject
  const canon = canonicalJson(body)
  // `nodeIdFor` is pure; unserializable input is a programming error, same as
  // the judges' `verdictIdFor`. `recordEvent` validates and fails typed instead.
  if (!canon.ok) throw new Error(`nodeIdFor: event not serializable: ${canon.reason}`)
  return sha256Hex(`${event.type}\n${canon.json}`)
}

export interface TimelineQuery {
  /** ISO lower bound (inclusive). */
  readonly from?: string
  /** ISO upper bound (inclusive). */
  readonly to?: string
  readonly types?: ReadonlyArray<LearningEventType>
  /** Skill / memory / behavior id. */
  readonly subject?: string
  /** Default false: archived nodes are hidden from queries but never gone. */
  readonly includeArchived?: boolean
}

export interface ArchiveRequest {
  readonly reason: string
  readonly provenance: Provenance
}

// ─── Store seam ──────────────────────────────────────────────────────────────

export interface TimelineStoreShape {
  readonly getNode: (nodeId: string) => Effect.Effect<LearningNode | undefined, LearningError>
  /** Upsert: insert or replace the stored copy (used for tombstoning). */
  readonly putNode: (node: LearningNode) => Effect.Effect<void, LearningError>
  /** All nodes in insertion order. */
  readonly listNodes: () => Effect.Effect<ReadonlyArray<LearningNode>, LearningError>
}

export class TimelineStore extends Context.Service<TimelineStore, TimelineStoreShape>()(
  "aimy/learning/TimelineStore",
) {}

/** Deep-copy + freeze: the store never aliases caller-owned objects. */
const freezeCopy = <T>(value: T): T => Object.freeze(structuredClone(value)) as T

/**
 * Default store: process-local memory. Each layer build gets its own isolated
 * state — tests that build the layer twice never share nodes. A durable
 * backend (SQLite under MemoryService) implements `TimelineStoreShape` later.
 */
export const InMemoryTimelineStore: Layer.Layer<TimelineStore> = Layer.sync(TimelineStore, () => {
  const nodes = new Map<string, LearningNode>()
  const order: Array<string> = []

  const store: TimelineStoreShape = {
    getNode: (nodeId) => Effect.sync(() => nodes.get(nodeId)),
    putNode: (node) =>
      Effect.sync(() => {
        if (!nodes.has(node.nodeId)) order.push(node.nodeId)
        nodes.set(node.nodeId, freezeCopy(node))
      }),
    listNodes: () =>
      Effect.sync(() => order.map((id) => nodes.get(id)) as ReadonlyArray<LearningNode>),
  }
  return store
})

// ─── Service ─────────────────────────────────────────────────────────────────

export interface LearningTimelineShape {
  /**
   * Persist a pipeline event as a node. Idempotent: re-recording the same
   * event (same content AND same `recordedAt`) returns the existing node.
   */
  readonly recordEvent: (event: LearningEvent) => Effect.Effect<LearningNode, LearningError>
  readonly getNode: (nodeId: string) => Effect.Effect<LearningNode | undefined, LearningError>
  readonly query: (q: TimelineQuery) => Effect.Effect<ReadonlyArray<LearningNode>, LearningError>
  /**
   * "Delete": archives the node (tombstone + `timeline.node.archived` meta
   * event). The node is NEVER removed — `getNode` still returns it and
   * `query({ includeArchived: true })` still lists it.
   */
  readonly archiveNode: (nodeId: string, request: ArchiveRequest) => Effect.Effect<LearningNode, LearningError>
  readonly restoreNode: (nodeId: string, request: ArchiveRequest) => Effect.Effect<LearningNode, LearningError>
  /**
   * "Edit": records a NEW node with `supersedes` set to the old id and
   * archives the old node ("edited", `supersededBy` set). History is never
   * rewritten.
   */
  readonly editNode: (
    nodeId: string,
    payload: unknown,
    provenance: Provenance,
  ) => Effect.Effect<LearningNode, LearningError>
}

export class LearningTimeline extends Context.Service<LearningTimeline, LearningTimelineShape>()(
  "aimy/learning/LearningTimeline",
) {}

const matchesQuery = (node: LearningNode, q: TimelineQuery): boolean => {
  if (q.includeArchived !== true && node.archivedAt !== undefined) return false
  if (q.from !== undefined && node.recordedAt < q.from) return false
  if (q.to !== undefined && node.recordedAt > q.to) return false
  if (q.types !== undefined && !q.types.includes(node.type)) return false
  if (q.subject !== undefined && node.subject !== q.subject) return false
  return true
}

export const LearningTimelineLive: Layer.Layer<LearningTimeline, never, TimelineStore> =
  Layer.effect(
    LearningTimeline,
    Effect.gen(function* () {
      const store = yield* TimelineStore

      const recordEvent: LearningTimelineShape["recordEvent"] = (event) =>
        Effect.gen(function* () {
          const recordedAt = event.recordedAt ?? new Date().toISOString()
          const body: Record<string, unknown> = {
            type: event.type,
            recordedAt,
            provenance: event.provenance,
            evidenceIds: event.evidenceIds,
            payload: event.payload,
          }
          if (event.subject !== undefined) body["subject"] = event.subject
          const canon = canonicalJson(body)
          if (!canon.ok) {
            return yield* Effect.fail(new UnserializablePayload({ reason: canon.reason }))
          }
          const nodeId = sha256Hex(`${event.type}\n${canon.json}`)
          const existing = yield* store.getNode(nodeId)
          if (existing !== undefined) return existing // idempotent re-record
          const node: LearningNode = {
            nodeId,
            type: event.type,
            recordedAt,
            provenance: event.provenance,
            evidenceIds: event.evidenceIds,
            payload: event.payload,
            ...(event.subject !== undefined ? { subject: event.subject } : {}),
          }
          yield* store.putNode(node)
          return (yield* store.getNode(nodeId)) as LearningNode
        })

      const getNode: LearningTimelineShape["getNode"] = (nodeId) => store.getNode(nodeId)

      const query: LearningTimelineShape["query"] = (q) =>
        Effect.gen(function* () {
          const nodes = yield* store.listNodes()
          return nodes.filter((n) => matchesQuery(n, q))
        })

      const archiveNode: LearningTimelineShape["archiveNode"] = (nodeId, request) =>
        Effect.gen(function* () {
          const node = yield* store.getNode(nodeId)
          if (node === undefined) return yield* Effect.fail(new NodeNotFound({ nodeId }))
          if (node.archivedAt !== undefined) {
            return yield* Effect.fail(new NodeAlreadyArchived({ nodeId }))
          }
          const tombstone: LearningNode = {
            ...node,
            archivedAt: new Date().toISOString(),
            archiveReason: request.reason,
          }
          yield* store.putNode(tombstone)
          yield* recordEvent({
            type: "timeline.node.archived",
            provenance: request.provenance,
            ...(node.subject !== undefined ? { subject: node.subject } : {}),
            evidenceIds: [],
            payload: { targetNodeId: nodeId, reason: request.reason } satisfies NodeArchivedPayload,
          })
          return tombstone
        })

      const restoreNode: LearningTimelineShape["restoreNode"] = (nodeId, request) =>
        Effect.gen(function* () {
          const node = yield* store.getNode(nodeId)
          if (node === undefined) return yield* Effect.fail(new NodeNotFound({ nodeId }))
          if (node.archivedAt === undefined) {
            return yield* Effect.fail(new NodeNotArchived({ nodeId }))
          }
          const { archivedAt: _archivedAt, archiveReason: _archiveReason, ...rest } = node
          const restored: LearningNode = { ...rest }
          yield* store.putNode(restored)
          yield* recordEvent({
            type: "timeline.node.restored",
            provenance: request.provenance,
            ...(node.subject !== undefined ? { subject: node.subject } : {}),
            evidenceIds: [],
            payload: { targetNodeId: nodeId, reason: request.reason } satisfies NodeRestoredPayload,
          })
          return restored
        })

      const editNode: LearningTimelineShape["editNode"] = (nodeId, payload, provenance) =>
        Effect.gen(function* () {
          const node = yield* store.getNode(nodeId)
          if (node === undefined) return yield* Effect.fail(new NodeNotFound({ nodeId }))
          // Validate the new payload first: failures leave the old node untouched.
          const canon = canonicalJson(payload)
          if (!canon.ok) {
            return yield* Effect.fail(new UnserializablePayload({ reason: canon.reason }))
          }
          const event = {
            type: node.type,
            provenance,
            ...(node.subject !== undefined ? { subject: node.subject } : {}),
            evidenceIds: node.evidenceIds,
            payload,
          } as LearningEvent // payload is serializable (validated above); type is preserved
          const revised = yield* recordEvent(event)
          const tombstone: LearningNode = {
            ...node,
            archivedAt: new Date().toISOString(),
            archiveReason: "edited",
            supersededBy: revised.nodeId,
          }
          yield* store.putNode(tombstone)
          const withLink: LearningNode = { ...revised, supersedes: nodeId }
          yield* store.putNode(withLink)
          return withLink
        })

      return LearningTimeline.of({
        recordEvent,
        getNode,
        query,
        archiveNode,
        restoreNode,
        editNode,
      })
    }),
  )
