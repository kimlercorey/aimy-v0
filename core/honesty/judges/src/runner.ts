/**
 * honesty/judges/runner.ts
 *
 * The out-of-process contract for running judges (M3: LOGICAL out-of-process —
 * see README §"Isolation boundary" for what this guarantees and what it does not).
 *
 * `runJudge(registry, judgeId, versionRange, input)`:
 *   1. resolves + pins the exact judge version (`JudgeNotFound` on miss),
 *   2. validates the input structurally (`JudgeInputInvalid`, never a throw),
 *   3. deep-clones + deep-freezes the input so the judge cannot mutate it
 *      even by accident,
 *   4. invokes the pure `run` — a throw becomes typed `JudgeThrew`,
 *   5. verifies the returned verdict's integrity (verdictId recomputed,
 *      judgeId/version/taskId match, well-formed payload) — mismatch →
 *      typed `JudgeVerdictInvalid`, verdict discarded,
 *   6. stamps `ranAt` (runner-owned clock; judges never see the clock) and
 *      deep-freezes the verdict before returning it, so the agent cannot
 *      mutate the verdict after the fact.
 *
 * `defineJudge` is the sanctioned way to write a judge: the author supplies
 * a pure `check` and the wrapper computes the deterministic `verdictId`,
 * copies `taskId` from the input, and leaves `ranAt` as the empty sentinel
 * the runner replaces. Hand-written `JudgeDefinition`s are also accepted —
 * the runner verifies them against the same contract.
 */
import { Effect } from "effect"

import { canonicalJson, deepFreeze, sha256Hex, verdictIdFor } from "./canonical.js"
import type { JudgeDefinition, JudgeInput, JudgeVerdict } from "./contracts.js"
import { JudgeInputInvalid, JudgeNotFound, JudgeThrew, JudgeVerdictInvalid } from "./errors.js"
import type { JudgeRegistry } from "./registry.js"

const OUTCOMES: ReadonlyArray<string> = ["ok", "io-error", "blocked", "denied"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

/**
 * Structural validation of a JudgeInput. Returns typed `JudgeInputInvalid`
 * for anything malformed — empty claim, empty sideEffects, non-serializable
 * finalState, wrong field types. NEVER throws.
 *
 * Deliberate strictness: a judge run requires at least one side-effect
 * record. Pure-dialogue turns are outside the M3 judge protocol (there is
 * nothing executable to verify against).
 */
export const validateJudgeInput = (input: unknown): Effect.Effect<JudgeInput, JudgeInputInvalid> => {
  const invalid = (path: string, reason: string) => Effect.fail(new JudgeInputInvalid({ path, reason }))
  if (!isRecord(input)) return invalid("", "JudgeInput must be an object")
  if (!nonEmptyString(input["taskId"])) return invalid("taskId", "taskId must be a non-empty string")
  if (typeof input["claim"] !== "string" || input["claim"].trim().length === 0) {
    return invalid("claim", "claim must be a non-empty string")
  }
  const sideEffects = input["sideEffects"]
  if (!Array.isArray(sideEffects)) return invalid("sideEffects", "sideEffects must be an array")
  if (sideEffects.length === 0) return invalid("sideEffects", "sideEffects must contain at least one record")
  for (let i = 0; i < sideEffects.length; i++) {
    const record = sideEffects[i]
    const path = `sideEffects[${i}]`
    if (!isRecord(record)) return invalid(path, "record must be an object")
    if (!nonEmptyString(record["toolCallId"])) return invalid(`${path}.toolCallId`, "toolCallId must be a non-empty string")
    if (!nonEmptyString(record["tool"])) return invalid(`${path}.tool`, "tool must be a non-empty string")
    if (!isRecord(record["args"])) return invalid(`${path}.args`, "args must be an object")
    if (typeof record["outcome"] !== "string" || !OUTCOMES.includes(record["outcome"])) {
      return invalid(`${path}.outcome`, `outcome must be one of ${OUTCOMES.join(", ")}`)
    }
    if (typeof record["resultSummary"] !== "string") {
      return invalid(`${path}.resultSummary`, "resultSummary must be a string")
    }
  }
  const dialogue = input["dialogue"]
  if (!Array.isArray(dialogue)) return invalid("dialogue", "dialogue must be an array")
  for (let i = 0; i < dialogue.length; i++) {
    const message = dialogue[i]
    const path = `dialogue[${i}]`
    if (!isRecord(message)) return invalid(path, "message must be an object")
    if (typeof message["role"] !== "string") return invalid(`${path}.role`, "role must be a string")
    if (typeof message["text"] !== "string") return invalid(`${path}.text`, "text must be a string")
  }
  const serializable = canonicalJson(input["finalState"])
  if (!serializable.ok) return invalid("finalState", `finalState must be JSON-serializable: ${serializable.reason}`)
  return Effect.succeed(input as unknown as JudgeInput)
}

/** The pure payload a judge author produces; `defineJudge` wraps it. */
export interface JudgeCheckResult {
  readonly verdict: "pass" | "fail"
  readonly reasons: ReadonlyArray<string>
  readonly evidenceIds: ReadonlyArray<string>
}

/** Deterministic evidence id: sha256(judgeId@version | label | canonical input). */
export const evidenceIdFor = (
  judgeId: string,
  judgeVersion: string,
  input: JudgeInput,
  label: string,
): string => {
  const body = canonicalJson({
    taskId: input.taskId,
    claim: input.claim,
    sideEffects: input.sideEffects,
    finalState: input.finalState,
  }).json
  return `ev:${judgeId}:${label}:${verdictIdFor(judgeId, judgeVersion, input).slice(0, 12)}:${sha256Hex(`${judgeId}@${judgeVersion}|${label}|${body}`).slice(0, 12)}`
}

/**
 * The sanctioned judge constructor. The author's `check` stays pure and
 * clock-free; the wrapper handles `verdictId` determinism and `taskId`
 * propagation. `ranAt` is left as the empty sentinel — the runner stamps it.
 */
export const defineJudge = (spec: {
  readonly id: string
  readonly version: string
  readonly description: string
  readonly check: (input: JudgeInput) => JudgeCheckResult
}): JudgeDefinition => ({
  id: spec.id,
  version: spec.version,
  description: spec.description,
  run: (input: JudgeInput): JudgeVerdict => {
    const result = spec.check(input)
    return {
      verdictId: verdictIdFor(spec.id, spec.version, input),
      judgeId: spec.id,
      judgeVersion: spec.version,
      taskId: input.taskId,
      verdict: result.verdict,
      reasons: [...result.reasons],
      evidenceIds: [...result.evidenceIds],
      ranAt: "",
    }
  },
})

const checkVerdictShape = (
  def: JudgeDefinition,
  input: JudgeInput,
  verdict: JudgeVerdict,
): Effect.Effect<void, JudgeVerdictInvalid> => {
  const bad = (reason: string) =>
    Effect.fail(new JudgeVerdictInvalid({ judgeId: def.id, judgeVersion: def.version, reason }))
  if (!isRecord(verdict)) return bad("judge returned a non-object verdict")
  if (verdict["verdictId"] !== verdictIdFor(def.id, def.version, input)) {
    return bad(
      `verdictId mismatch: expected ${verdictIdFor(def.id, def.version, input)}, got ${String(verdict["verdictId"])} — verdict discarded`,
    )
  }
  if (verdict["judgeId"] !== def.id || verdict["judgeVersion"] !== def.version) {
    return bad(`verdict names ${String(verdict["judgeId"])}@${String(verdict["judgeVersion"])}, expected ${def.id}@${def.version}`)
  }
  if (verdict["taskId"] !== input.taskId) {
    return bad(`verdict taskId ${String(verdict["taskId"])} does not match input taskId ${input.taskId}`)
  }
  if (verdict["verdict"] !== "pass" && verdict["verdict"] !== "fail") {
    return bad(`verdict must be "pass" or "fail", got ${String(verdict["verdict"])}`)
  }
  if (!Array.isArray(verdict["reasons"]) || !verdict["reasons"].every((r) => typeof r === "string")) {
    return bad("reasons must be an array of strings")
  }
  if (!Array.isArray(verdict["evidenceIds"]) || !verdict["evidenceIds"].every((e) => typeof e === "string")) {
    return bad("evidenceIds must be an array of strings")
  }
  return Effect.void
}

export interface RunJudgeOptions {
  /** Clock override for tests. Defaults to `new Date().toISOString()`. Judges never see this. */
  readonly now?: string
}

/**
 * Run an already-resolved judge definition against an input.
 * Freezes the input before invocation; freezes the verdict before returning.
 */
export const runJudgeDefinition = (
  def: JudgeDefinition,
  input: unknown,
  options?: RunJudgeOptions,
): Effect.Effect<JudgeVerdict, JudgeInputInvalid | JudgeThrew | JudgeVerdictInvalid> =>
  Effect.gen(function* () {
    const validated = yield* validateJudgeInput(input)
    // Clone first (caller's object stays theirs), then deep-freeze the clone.
    // structuredClone is safe here: validation proved JSON-serializability.
    const frozen = deepFreeze(structuredClone(validated))
    // A throwing judge violates the purity contract: convert the throw into
    // a typed JudgeThrew via Effect.try's catch option (never a defect).
    const raw = yield* Effect.try({
      try: () => def.run(frozen),
      catch: (thrown) =>
        new JudgeThrew({
          judgeId: def.id,
          judgeVersion: def.version,
          reason: `judge threw instead of returning a verdict: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        }),
    })
    yield* checkVerdictShape(def, frozen, raw)
    // Stamp the runner-owned clock and freeze the verdict: the agent receives
    // a frozen record it cannot mutate after the fact.
    const stamped: JudgeVerdict = { ...raw, ranAt: options?.now ?? new Date().toISOString() }
    return deepFreeze(stamped)
  })

/**
 * Resolve `judgeId` (+ optional version range) in the registry, pin the exact
 * version, and run it. The returned verdict always names its judge version.
 */
export const runJudge = (
  registry: JudgeRegistry,
  judgeId: string,
  versionRange: string | undefined,
  input: unknown,
  options?: RunJudgeOptions,
): Effect.Effect<JudgeVerdict, JudgeInputInvalid | JudgeThrew | JudgeVerdictInvalid | JudgeNotFound> =>
  Effect.gen(function* () {
    const def = yield* registry.resolve(judgeId, versionRange)
    return yield* runJudgeDefinition(def, input, options)
  })
