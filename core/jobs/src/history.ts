/**
 * jobs/history.ts — append-only per-job run history.
 *
 * Layout (XDG state dir, namespaced by instance UUID):
 *
 *   <state>/jobs/<instanceId>/<jobId>/runs.jsonl
 *
 * One JSON object per line: `started`, then exactly one terminal record
 * (`succeeded` | `failed` | `cancelled`), plus a `parked` record when the
 * restart budget is exhausted. Append-only: records are never rewritten or
 * deleted by the runner. `jobId` is restricted to `[a-z0-9][a-z0-9_-]{0,63}`
 * at schedule time, so it is safe as a path segment.
 */
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Context, Effect, Layer, Ref } from "effect"

import { resolvePaths } from "../../substrate/config.js"
import { JobStoreError } from "./errors.js"
import type { JobId, RunRecord } from "./types.js"

export interface JobRunnerConfig {
  /**
   * Instance UUID — namespaces run history on disk. Production wires
   * `IdentityService`'s install UUID here; the jobs library never imports
   * the identity track (parallel M7 work).
   */
  readonly instanceId: string
  /** Override for the XDG state dir (tests). Defaults to `resolvePaths().state`. */
  readonly stateDir?: string | undefined
}

export const JobRunnerConfig = Context.Reference<JobRunnerConfig>("aimy/jobs/JobRunnerConfig", {
  defaultValue: () => ({
    instanceId: process.env.AIMY_INSTANCE_ID ?? "local-dev-instance"
  })
})

export interface RunHistoryService {
  readonly append: (record: RunRecord) => Effect.Effect<void, JobStoreError>
  readonly list: (jobId: JobId) => Effect.Effect<ReadonlyArray<RunRecord>, JobStoreError>
}

export class RunHistory extends Context.Service<RunHistory, RunHistoryService>()(
  "aimy/jobs/RunHistory"
) {}

/** Directory holding one job's `runs.jsonl`. Exported for tests and export tooling. */
export const runHistoryDir = (stateDir: string, instanceId: string, jobId: JobId): string =>
  path.join(stateDir, "jobs", instanceId, jobId)

const RUNS_FILE = "runs.jsonl"

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

/**
 * Pure constructor for the file-backed store. `FileRunHistoryLive` is the
 * layered form; tests and tooling can build the service directly.
 */
export const makeFileRunHistory = (stateDir: string, instanceId: string): RunHistoryService => {
  const fileFor = (jobId: JobId): string =>
    path.join(runHistoryDir(stateDir, instanceId, jobId), RUNS_FILE)

  const append = (record: RunRecord): Effect.Effect<void, JobStoreError> =>
    Effect.tryPromise({
      try: async () => {
        const file = fileFor(record.jobId)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.appendFile(file, JSON.stringify(record) + "\n", "utf-8")
      },
      catch: (cause) =>
        new JobStoreError({ reason: `append run record for ${record.jobId}: ${describeCause(cause)}` })
    })

  const list = (jobId: JobId): Effect.Effect<ReadonlyArray<RunRecord>, JobStoreError> =>
    Effect.tryPromise({
      try: async () => {
        const file = fileFor(jobId)
        let text: string
        try {
          text = await fs.readFile(file, "utf-8")
        } catch (cause) {
          if ((cause as { code?: string }).code === "ENOENT") return []
          throw cause
        }
        return text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line, index) => {
            try {
              return JSON.parse(line) as RunRecord
            } catch (cause) {
              throw new Error(
                `corrupt run-history line ${index + 1} for job ${jobId}: ${describeCause(cause)}`
              )
            }
          })
      },
      catch: (cause) =>
        new JobStoreError({ reason: `list run records for ${jobId}: ${describeCause(cause)}` })
    })

  return { append, list }
}

/** In-memory store. Tests; no filesystem touch. */
export const InMemoryRunHistory: Layer.Layer<RunHistory> = Layer.effect(
  RunHistory,
  Effect.gen(function* () {
    const records = yield* Ref.make<ReadonlyArray<RunRecord>>([])
    return RunHistory.of({
      append: (record) => Ref.update(records, (rs) => [...rs, record]),
      list: (jobId) =>
        Effect.map(Ref.get(records), (rs) => rs.filter((r) => r.jobId === jobId))
    })
  })
)

/**
 * File-backed store. `runs.jsonl` is append-only; a missing file lists as
 * empty; a corrupt line fails the list LOUDLY (evidence logs must not
 * silently skip).
 */
export const FileRunHistoryLive: Layer.Layer<RunHistory, never, JobRunnerConfig> =
  Layer.effect(
    RunHistory,
    Effect.gen(function* () {
      const config = yield* JobRunnerConfig
      return RunHistory.of(
        makeFileRunHistory(config.stateDir ?? resolvePaths().state, config.instanceId)
      )
    })
  )

/** Test helper: a fresh temporary state dir (caller cleans up). */
export const makeTempStateDir = (): Effect.Effect<string> =>
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "aimy-jobs-test-")))
