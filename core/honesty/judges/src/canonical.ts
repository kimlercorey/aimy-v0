/**
 * honesty/judges/canonical.ts
 *
 * Deterministic serialization, hashing, and deep-freezing primitives.
 *
 * - `canonicalJson`: stable JSON with recursively sorted object keys, so
 *   equal values always serialize to byte-identical strings regardless of
 *   key insertion order. Cycle-safe: returns a failure instead of throwing.
 * - `sha256Hex`: the hash used for verdictIds and evidence ids.
 * - `deepFreeze`: recursive `Object.freeze`, cycle-safe. The runner freezes
 *   the judge's input before invocation and the verdict before returning it.
 */
import { sha256Hex as sha256HexSub } from "../../../substrate/hash.js"

export interface CanonicalResult {
  readonly ok: boolean
  readonly json: string
  readonly reason: string
}

const escapeKey = (key: string): string => JSON.stringify(key)

const writeCanonical = (value: unknown, seen: Set<object>, out: Array<string>): boolean => {
  if (value === null || value === undefined) {
    out.push("null")
    return true
  }
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value))
      return true
    case "number":
      out.push(Number.isFinite(value) ? String(value) : "null")
      return true
    case "boolean":
      out.push(value ? "true" : "false")
      return true
    case "bigint":
      out.push(JSON.stringify(value.toString()))
      return true
    default:
      break
  }
  if (typeof value !== "object") return false // function, symbol → not JSON-serializable
  if (seen.has(value)) return false // cycle → not serializable
  seen.add(value)
  if (Array.isArray(value)) {
    out.push("[")
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",")
      if (!writeCanonical(value[i], seen, out)) return false
    }
    out.push("]")
  } else {
    const keys = Object.keys(value).sort()
    out.push("{")
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string
      if (i > 0) out.push(",")
      out.push(escapeKey(key))
      out.push(":")
      if (!writeCanonical((value as Record<string, unknown>)[key], seen, out)) return false
    }
    out.push("}")
  }
  seen.delete(value)
  return true
}

/** Stable, cycle-safe JSON serialization. Never throws. */
export const canonicalJson = (value: unknown): CanonicalResult => {
  const out: Array<string> = []
  const ok = writeCanonical(value, new Set(), out)
  return ok
    ? { ok: true, json: out.join(""), reason: "" }
    : { ok: false, json: "", reason: "value is not JSON-serializable (cycle, function, or symbol)" }
}

export const sha256Hex = (text: string): string => sha256HexSub(text)

/**
 * Recursively `Object.freeze` a value. Cycle-safe. Returns the same reference.
 * Primitives pass through unchanged.
 */
export const deepFreeze = <T>(value: T): T => {
  const seen = new Set<object>()
  const freeze = (node: unknown): unknown => {
    if (node === null || (typeof node !== "object" && typeof node !== "function")) return node
    const obj = node as object
    if (seen.has(obj)) return node
    seen.add(obj)
    if (Array.isArray(obj)) {
      for (const item of obj) freeze(item)
    } else {
      for (const key of Object.keys(obj)) freeze((obj as Record<string, unknown>)[key])
    }
    return Object.freeze(obj)
  }
  return freeze(value) as T
}

/**
 * The deterministic verdict id: sha256 over
 *   judgeId + "@" + judgeVersion + "\n" + canonical({taskId, claim, sideEffects, finalState})
 * Same inputs → same verdictId, always, on any machine. The dialogue is
 * intentionally EXCLUDED (per the shared contract): the verdict id binds the
 * evidence the verdict is *about*, not the transcript that was shown.
 */
export const verdictIdFor = (
  judgeId: string,
  judgeVersion: string,
  input: { readonly taskId: string; readonly claim: string; readonly sideEffects: unknown; readonly finalState: unknown },
): string => {
  const body = canonicalJson({
    taskId: input.taskId,
    claim: input.claim,
    sideEffects: input.sideEffects,
    finalState: input.finalState,
  })
  // `verdictIdFor` is only called on already-validated (serializable) inputs.
  if (!body.ok) throw new Error(`verdictIdFor: input not serializable: ${body.reason}`)
  return sha256Hex(`${judgeId}@${judgeVersion}\n${body.json}`)
}
