/**
 * honesty/judges/registry.ts
 *
 * `JudgeRegistry`: maps judge-id → versioned `JudgeDefinition`s.
 * `resolve(id, versionRange?)` pins an EXACT version — a task's verdict
 * always names its judge version, so verdicts are reproducible.
 *
 * The registry is persistent: `register` returns a NEW registry, the old one
 * is unchanged. Re-registering the same id+version replaces the definition
 * (last wins; documented, not an error — registration is a build-time act).
 */
import { Effect } from "effect"

import type { JudgeDefinition } from "./contracts.js"
import { JudgeNotFound } from "./errors.js"

type Semver = { readonly major: number; readonly minor: number; readonly patch: number }

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const parseSemver = (version: string): Semver | undefined => {
  const m = SEMVER_RE.exec(version.trim())
  if (!m) return undefined
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

const compareSemver = (a: Semver, b: Semver): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch

interface RangeClause {
  readonly op: "exact" | "caret" | "tilde" | "gte" | "lte" | "gt" | "lt"
  readonly version: Semver
}

const parseClause = (clause: string): RangeClause | undefined => {
  const trimmed = clause.trim()
  if (trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "latest") return undefined // wildcard handled by caller
  const match = /^(>=|<=|>|<|\^|~|=)?\s*(\S+)$/.exec(trimmed)
  if (!match) return undefined
  const version = parseSemver(match[2] as string)
  if (!version) return undefined
  const op = match[1]
  if (op === "^") return { op: "caret", version }
  if (op === "~") return { op: "tilde", version }
  if (op === ">=") return { op: "gte", version }
  if (op === "<=") return { op: "lte", version }
  if (op === ">") return { op: "gt", version }
  if (op === "<") return { op: "lt", version }
  return { op: "exact", version } // bare "1.2.3" or "=1.2.3"
}

const satisfiesClause = (candidate: Semver, clause: RangeClause): boolean => {
  const cmp = compareSemver(candidate, clause.version)
  switch (clause.op) {
    case "exact":
      return cmp === 0
    case "caret":
      // ^1.2.3 := >=1.2.3 <2.0.0 ; ^0.2.3 := >=0.2.3 <0.3.0 ; ^0.0.3 := =0.0.3
      if (cmp < 0) return false
      if (clause.version.major > 0) return candidate.major === clause.version.major
      if (clause.version.minor > 0) return candidate.major === 0 && candidate.minor === clause.version.minor
      return cmp === 0
    case "tilde":
      // ~1.2.3 := >=1.2.3 <1.3.0
      return cmp >= 0 && candidate.major === clause.version.major && candidate.minor === clause.version.minor
    case "gte":
      return cmp >= 0
    case "lte":
      return cmp <= 0
    case "gt":
      return cmp > 0
    case "lt":
      return cmp < 0
  }
}

/** Minimal semver range matcher. All clauses (space-separated) must hold. */
export const satisfiesRange = (version: string, range: string): boolean => {
  const candidate = parseSemver(version)
  if (!candidate) return false
  const trimmed = range.trim()
  if (trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "latest") return true
  const clauses: Array<RangeClause> = []
  for (const part of trimmed.split(/\s+/)) {
    const clause = parseClause(part)
    if (!clause) return false // unparseable range → matches nothing (fail closed)
    clauses.push(clause)
  }
  return clauses.every((c) => satisfiesClause(candidate, c))
}

const sortVersionsDesc = (versions: ReadonlyArray<string>): Array<string> =>
  [...versions].sort((a, b) => {
    const pa = parseSemver(a)
    const pb = parseSemver(b)
    if (!pa || !pb) return a < b ? 1 : -1
    return -compareSemver(pa, pb)
  })

export class JudgeRegistry {
  private constructor(
    private readonly defs: ReadonlyMap<string, ReadonlyMap<string, JudgeDefinition>>,
  ) {}

  static empty(): JudgeRegistry {
    return new JudgeRegistry(new Map())
  }

  /** Register one versioned definition. Returns a NEW registry. */
  register(def: JudgeDefinition): JudgeRegistry {
    const next = new Map<string, Map<string, JudgeDefinition>>()
    for (const [id, versions] of this.defs) next.set(id, new Map(versions))
    const versions = next.get(def.id) ?? new Map<string, JudgeDefinition>()
    versions.set(def.version, def)
    next.set(def.id, versions)
    return new JudgeRegistry(next)
  }

  /** Convenience: build a registry from a list of definitions. */
  static from(defs: ReadonlyArray<JudgeDefinition>): JudgeRegistry {
    let registry = JudgeRegistry.empty()
    for (const def of defs) registry = registry.register(def)
    return registry
  }

  readonly ids = (): ReadonlyArray<string> => [...this.defs.keys()].sort()

  readonly versions = (id: string): ReadonlyArray<string> => {
    const versions = this.defs.get(id)
    return versions ? sortVersionsDesc([...versions.keys()]) : []
  }

  /**
   * Pin an exact version. `versionRange` may be an exact version ("1.0.0"),
   * a range ("^1.0.0", ">=1.2.0 <2.0.0"), or omitted/"*"/"latest" for the
   * highest registered version. Unknown id or unsatisfiable range →
   * typed `JudgeNotFound`.
   */
  readonly resolve = (
    id: string,
    versionRange?: string,
  ): Effect.Effect<JudgeDefinition, JudgeNotFound> => {
    const versions = this.defs.get(id)
    if (!versions) {
      return Effect.fail(
        new JudgeNotFound({ judgeId: id, reason: `unknown judge id "${id}"` }),
      )
    }
    const range = versionRange?.trim() || "*"
    const candidates = sortVersionsDesc([...versions.keys()]).filter((v) => satisfiesRange(v, range))
    const pinned = candidates[0]
    if (!pinned) {
      return Effect.fail(
        new JudgeNotFound({
          judgeId: id,
          requestedVersion: range,
          reason: `judge "${id}" has no version satisfying "${range}" (registered: ${sortVersionsDesc([...versions.keys()]).join(", ") || "none"})`,
        }),
      )
    }
    return Effect.succeed(versions.get(pinned) as JudgeDefinition)
  }
}
