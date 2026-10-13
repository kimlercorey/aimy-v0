/**
 * learning/file-store.ts — the durable TimelineStore (2026-10-13).
 *
 * The desktop app backed LearningTimeline with InMemoryTimelineStore:
 * the timeline page read a store that started empty at every launch
 * and was never written by anything — a trust surface showing zero
 * forever. This store keeps the same contract (getNode / putNode
 * upsert / listNodes in insertion order) over a JSON file, so the
 * learning record survives restarts.
 *
 * Shape: the whole node set as one JSON array, rewritten atomically
 * (tmp + rename) on every put. Budgets cap the timeline at ~1400
 * entries, so a full rewrite is a few hundred KB worst case — simple
 * and crash-safe beats clever here. The append-only doctrine lives
 * in the service layer (archive = tombstone, edit = supersede);
 * this store just persists what it is given, upserts included.
 *
 * Failure honesty:
 * - An unreadable/corrupt file at boot is NEVER silently discarded:
 *   it is moved aside to `<file>.corrupt-<ts>` and the store starts
 *   empty with a loud log line.
 * - A persist failure after a put is logged loudly and the node is
 *   kept in memory for the session — a disk hiccup must not crash a
 *   chat turn (the house pattern: log, never crash).
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Layer } from "effect"

import {
  TimelineStore,
  nodeIdFor,
  type LearningEvent,
  type LearningNode,
  type TimelineStoreShape,
} from "./timeline.js"

/** Same deep-copy + freeze the in-memory store applies: the store
 * never aliases caller-owned objects. */
const freezeCopy = <T>(value: T): T => Object.freeze(structuredClone(value)) as T

export const fileTimelineStore = (filePath: string): Layer.Layer<TimelineStore> =>
  Layer.sync(TimelineStore, () => {
    const nodes = new Map<string, LearningNode>()
    const order: Array<string> = []

    try {
      const raw = fs.readFileSync(filePath, "utf-8")
      const parsed = JSON.parse(raw) as Array<LearningNode>
      for (const n of parsed) {
        if (n === null || typeof n !== "object" || typeof n.nodeId !== "string") continue
        if (!nodes.has(n.nodeId)) order.push(n.nodeId)
        nodes.set(n.nodeId, freezeCopy(n))
      }
      console.log(`[aimy] learning timeline: loaded ${order.length} node(s) from ${filePath}`)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code
      if (code !== "ENOENT") {
        const aside = `${filePath}.corrupt-${Date.now()}`
        try {
          fs.renameSync(filePath, aside)
        } catch {
          // The rename can only fail if the file vanished mid-boot;
          // the log below still names the original path.
        }
        console.error(
          `[aimy] learning timeline: store at ${filePath} unreadable (${e instanceof Error ? e.message : String(e)}); moved aside to ${aside}, starting empty`,
        )
      }
    }

    const persist = (): void => {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const tmp = `${filePath}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(order.map((id) => nodes.get(id))), "utf-8")
        fs.renameSync(tmp, filePath)
      } catch (e) {
        console.error(
          `[aimy] learning timeline: persist to ${filePath} failed (${e instanceof Error ? e.message : String(e)}); node kept in memory only`,
        )
      }
    }

    // Producer drop file (2026-10-13): the agent loop's ledgers
    // append learning events as JSON lines to timeline-events.jsonl
    // beside the nodes file (learning-events.ts in agent-loop).
    // This store is their only importer, so the nodes file keeps a
    // single writer. The drop file is renamed aside BEFORE reading,
    // so a producer appending mid-import starts a fresh file
    // instead of racing the read; import is idempotent (the node id
    // fingerprints the content), so a crash between persist and
    // cleanup can only ever re-import, never duplicate.
    const dropPath = path.join(path.dirname(filePath), "timeline-events.jsonl")
    const importDropped = (): void => {
      const processing = `${dropPath}.importing`
      let raw: string
      try {
        fs.renameSync(dropPath, processing)
        raw = fs.readFileSync(processing, "utf-8")
      } catch {
        return // No drop file — the common case.
      }
      let added = 0
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue
        try {
          const ev = JSON.parse(line) as {
            type?: unknown
            provenance?: LearningEvent["provenance"]
            subject?: unknown
            evidenceIds?: unknown
            payload?: unknown
            recordedAt?: unknown
          }
          if (typeof ev.type !== "string" || ev.provenance === undefined || ev.payload === undefined) continue
          const recordedAt = typeof ev.recordedAt === "string" ? ev.recordedAt : new Date().toISOString()
          // The line's shape was checked above and nodeIdFor
          // re-validates serializability below; the union itself
          // is asserted through unknown (a JSON line is not typed).
          const event = {
            type: ev.type,
            provenance: ev.provenance,
            ...(typeof ev.subject === "string" ? { subject: ev.subject } : {}),
            evidenceIds: Array.isArray(ev.evidenceIds) ? (ev.evidenceIds as Array<string>) : [],
            payload: ev.payload,
          } as unknown as LearningEvent
          const nodeId = nodeIdFor(event, recordedAt)
          if (!nodes.has(nodeId)) {
            const node: LearningNode = {
              nodeId,
              type: event.type,
              recordedAt,
              provenance: event.provenance,
              evidenceIds: event.evidenceIds,
              payload: event.payload,
              ...(typeof ev.subject === "string" ? { subject: ev.subject } : {}),
            }
            order.push(nodeId)
            nodes.set(nodeId, freezeCopy(node))
            added++
          }
        } catch {
          console.error("[aimy] learning timeline: skipped an unreadable dropped event line")
        }
      }
      try {
        fs.unlinkSync(processing)
      } catch {
        // Already gone — nothing to clean.
      }
      if (added > 0) {
        persist()
        console.log(`[aimy] learning timeline: imported ${added} dropped event(s); ${order.length} node(s) total`)
      }
    }
    importDropped()

    const store: TimelineStoreShape = {
      getNode: (nodeId) =>
        Effect.sync(() => {
          importDropped()
          return nodes.get(nodeId)
        }),
      putNode: (node) =>
        Effect.sync(() => {
          if (!nodes.has(node.nodeId)) order.push(node.nodeId)
          nodes.set(node.nodeId, freezeCopy(node))
          persist()
        }),
      listNodes: () =>
        Effect.sync(() => {
          importDropped()
          return order.map((id) => nodes.get(id)) as ReadonlyArray<LearningNode>
        }),
    }
    return store
  })
