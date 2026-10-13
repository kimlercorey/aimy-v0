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

    const store: TimelineStoreShape = {
      getNode: (nodeId) => Effect.sync(() => nodes.get(nodeId)),
      putNode: (node) =>
        Effect.sync(() => {
          if (!nodes.has(node.nodeId)) order.push(node.nodeId)
          nodes.set(node.nodeId, freezeCopy(node))
          persist()
        }),
      listNodes: () =>
        Effect.sync(() => order.map((id) => nodes.get(id)) as ReadonlyArray<LearningNode>),
    }
    return store
  })
