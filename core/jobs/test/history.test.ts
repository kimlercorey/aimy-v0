/**
 * history.test.ts — the append-only run-history store.
 *
 * Covers: in-memory append/list isolation per job, file layout under the XDG
 * state dir namespaced by instance UUID, JSONL append-only shape, missing job
 * lists as empty, and corrupt lines failing loudly.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  InMemoryRunHistory,
  makeFileRunHistory,
  makeTempStateDir,
  runHistoryDir,
  RunHistory
} from "../src/history.js"
import type { RunHistoryService } from "../src/history.js"
import type { RunRecord } from "../src/types.js"

const record = (jobId: string, n: number, status: RunRecord["status"]): RunRecord => ({
  jobId,
  runId: `${jobId}#${n}`,
  attempt: n,
  tier: "T1",
  isRetry: false,
  status,
  startedAtMs: 1_000_000 + n * 1000
})

/** File-backed history in a fresh temp state dir; dir removed afterwards. */
const withFileHistory = <A, E>(
  instanceId: string,
  test: (history: RunHistoryService, stateDir: string) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const stateDir = yield* makeTempStateDir()
    const history = makeFileRunHistory(stateDir, instanceId)
    return yield* Effect.ensuring(
      test(history, stateDir),
      Effect.promise(() => fs.rm(stateDir, { recursive: true, force: true }))
    )
  })

describe("InMemoryRunHistory", () => {
  it.effect("appends per job and lists in order; unknown job is empty", () =>
    Effect.gen(function* () {
      const history = yield* RunHistory
      yield* history.append(record("job-a", 1, "started"))
      yield* history.append(record("job-a", 1, "succeeded"))
      yield* history.append(record("job-b", 1, "started"))
      const a = yield* history.list("job-a")
      expect(a.map((r) => r.status)).toEqual(["started", "succeeded"])
      expect(a.map((r) => r.runId)).toEqual(["job-a#1", "job-a#1"])
      expect(yield* history.list("job-b")).toHaveLength(1)
      expect(yield* history.list("nope")).toEqual([])
    }).pipe(Effect.provide(InMemoryRunHistory))
  )
})

describe("makeFileRunHistory", () => {
  it.effect("persists JSONL under <state>/jobs/<instanceId>/<jobId>/runs.jsonl", () =>
    withFileHistory("inst-1", (history, stateDir) =>
      Effect.gen(function* () {
        yield* history.append(record("job-a", 1, "started"))
        yield* history.append({
          ...record("job-a", 1, "succeeded"),
          endedAtMs: 1_001_000,
          durationMs: 1000
        })

        const file = path.join(runHistoryDir(stateDir, "inst-1", "job-a"), "runs.jsonl")
        expect(file).toBe(path.join(stateDir, "jobs", "inst-1", "job-a", "runs.jsonl"))
        const text = yield* Effect.promise(() => fs.readFile(file, "utf-8"))
        const lines = text.trim().split("\n")
        expect(lines).toHaveLength(2)
        expect(JSON.parse(lines[0]!).status).toBe("started")
        expect(JSON.parse(lines[1]!).durationMs).toBe(1000)

        const listed = yield* history.list("job-a")
        expect(listed).toHaveLength(2)
        expect(listed[1]!.status).toBe("succeeded")
      })
    )
  )

  it.effect("missing job lists as empty; corrupt lines fail loudly", () =>
    withFileHistory("inst-9", (history, stateDir) =>
      Effect.gen(function* () {
        expect(yield* history.list("ghost")).toEqual([])
        yield* history.append(record("job-c", 1, "started"))
        const file = path.join(runHistoryDir(stateDir, "inst-9", "job-c"), "runs.jsonl")
        yield* Effect.promise(() => fs.appendFile(file, "not-json{\n", "utf-8"))
        const exit = yield* Effect.exit(history.list("job-c"))
        expect(exit._tag).toBe("Failure")
        expect(JSON.stringify(exit)).toContain("JobStoreError")
      })
    )
  )

  it.effect("instance UUID namespaces state: two instances do not see each other", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeTempStateDir()
      const h1 = makeFileRunHistory(stateDir, "aaa")
      const h2 = makeFileRunHistory(stateDir, "bbb")
      yield* h1.append(record("job-a", 1, "started"))
      expect(yield* h1.list("job-a")).toHaveLength(1)
      expect(yield* h2.list("job-a")).toEqual([])
      yield* Effect.promise(() => fs.rm(stateDir, { recursive: true, force: true }))
    })
  )
})
