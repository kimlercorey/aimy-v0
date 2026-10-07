/**
 * pins.ts — PinRegistry: security-relevant prompt content that must survive
 * every session transform (Hermes #126167).
 *
 * Pins cover system prompts, identity docs, policies, and user pins. A pin
 * records the sha256 of the entry's canonical payload AT PIN TIME; verifyPins
 * demands every pin still resolves to an entry whose bytes are IDENTICAL to
 * pin time. Any divergence is a typed PinViolation naming the pin — never a
 * silent drop.
 *
 * `protectedIds` is the exact seam the context-assembly path (Track A) consumes
 * for cache-prefix protection: the set of entry ids that must not be moved,
 * dropped, or reordered by any transform.
 *
 * Budget interaction (architecture §3.2): if pins + tail cannot fit the token
 * budget, fitCheck fails LOUD with a typed BudgetExceeded — the turn never
 * proceeds with a degraded, unpinned context.
 */
import { createHash } from "node:crypto"
import { Data, Effect } from "effect"
import { SessionEntry, SessionTree } from "./session-tree.js"

/** Typed error for pin/unpin/fit misuse (not for integrity divergence — that's PinViolation). */
export class PinError extends Data.TaggedError("PinError")<{
  readonly reason: string
  readonly entryId?: string
}> {}

/**
 * Integrity divergence: a pin no longer resolves to byte-identical content.
 * Names the pin so the caller can say exactly which security-relevant content
 * was lost or altered.
 */
export class PinViolation extends Data.TaggedError("PinViolation")<{
  readonly pin: Pin
  readonly reason: string
}> {}

/** The turn fails loudly rather than proceeding with a degraded, unpinned context. */
export class BudgetExceeded extends Data.TaggedError("BudgetExceeded")<{
  readonly needed: number
  readonly budget: number
  readonly pinnedTokens: number
  readonly tailTokens: number
}> {}

/** A pin: security-relevant content frozen at pin time. */
export interface Pin {
  readonly entryId: string
  /** sha256 of the canonical payload, recorded at pin time. */
  readonly contentHash: string
  readonly reason: string
  readonly pinnedAt: number
}

/** Unpin is explicit and audited: the tombstone records who released what and why. */
export interface UnpinTombstone {
  readonly entryId: string
  readonly reason: string
  readonly unpinnedAt: number
}

/** Per-session pin registry. */
export interface PinRegistry {
  readonly sessionId: string
  readonly pins: ReadonlyArray<Pin>
  /** Audit trail — pins are never silently dropped. */
  readonly tombstones: ReadonlyArray<UnpinTombstone>
}

export const emptyRegistry = (sessionId: string): PinRegistry => ({
  sessionId,
  pins: [],
  tombstones: [],
})

/**
 * Canonical JSON: recursively sorted keys, no whitespace. The hash is
 * byte-stable across transforms (compaction, fork/clone, JSONL round-trip)
 * because it depends only on content, never on in-memory key order.
 */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>
    const keys = Object.keys(record).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** sha256 of the canonical { kind, payload } — the byte-identity fingerprint. */
export const contentHash = (entry: Pick<SessionEntry, "kind" | "payload">): string =>
  createHash("sha256")
    .update(canonical({ kind: entry.kind, payload: entry.payload }))
    .digest("hex")

const indexById = (tree: SessionTree): ReadonlyMap<string, SessionEntry> =>
  new Map(tree.entries.map((e) => [e.id, e]))

/**
 * Pin an entry. Records the content hash at pin time. Fails if the entry does
 * not exist, is already actively pinned, or was previously unpinned and the
 * caller did not supply a new reason (re-pinning after an explicit unpin is
 * allowed — it creates a fresh pin; the tombstone stays in the audit trail).
 */
export const pin = (
  registry: PinRegistry,
  tree: SessionTree,
  entryId: string,
  reason: string,
  now: number = Date.now(),
): Effect.Effect<PinRegistry, PinError> =>
  Effect.gen(function* () {
    const entry = indexById(tree).get(entryId)
    if (entry === undefined) {
      return yield* Effect.fail(new PinError({ reason: "cannot pin: entry does not exist", entryId }))
    }
    if (registry.pins.some((p) => p.entryId === entryId)) {
      return yield* Effect.fail(new PinError({ reason: "entry is already pinned (unpin explicitly first)", entryId }))
    }
    if (reason.trim().length === 0) {
      return yield* Effect.fail(new PinError({ reason: "pin reason is required (pins are audited)", entryId }))
    }
    const newPin: Pin = { entryId, contentHash: contentHash(entry), reason, pinnedAt: now }
    return { ...registry, pins: [...registry.pins, newPin] }
  })

/**
 * Explicit, audited unpin. The pin is removed AND a tombstone is appended —
 * the registry can always answer "what happened to this pin".
 */
export const unpin = (
  registry: PinRegistry,
  entryId: string,
  reason: string,
  now: number = Date.now(),
): Effect.Effect<PinRegistry, PinError> =>
  Effect.gen(function* () {
    if (!registry.pins.some((p) => p.entryId === entryId)) {
      return yield* Effect.fail(new PinError({ reason: "cannot unpin: entry is not actively pinned", entryId }))
    }
    if (reason.trim().length === 0) {
      return yield* Effect.fail(new PinError({ reason: "unpin reason is required (pins are audited)", entryId }))
    }
    return {
      ...registry,
      pins: registry.pins.filter((p) => p.entryId !== entryId),
      tombstones: [...registry.tombstones, { entryId, reason, unpinnedAt: now }],
    }
  })

/**
 * The Hermes #126167 answer: every active pin resolves to an entry whose
 * content hash is BYTE-IDENTICAL to pin time. Missing entries and altered
 * bytes both fail as typed PinViolation naming the pin.
 */
export const verifyPins = (tree: SessionTree, registry: PinRegistry): Effect.Effect<void, PinViolation> =>
  Effect.gen(function* () {
    const index = indexById(tree)
    for (const p of registry.pins) {
      const entry = index.get(p.entryId)
      if (entry === undefined) {
        return yield* Effect.fail(
          new PinViolation({ pin: p, reason: "pinned entry is missing from the tree (dropped or never carried across the transform)" }),
        )
      }
      const current = contentHash(entry)
      if (current !== p.contentHash) {
        return yield* Effect.fail(
          new PinViolation({
            pin: p,
            reason: `pinned entry bytes changed since pin time (hash ${current.slice(0, 12)}… != pinned ${p.contentHash.slice(0, 12)}…)`,
          }),
        )
      }
    }
  })

/**
 * The exact seam Track A consumes for prefix protection: the ids of all
 * actively pinned entries. Tombstoned (explicitly unpinned) entries are not
 * protected — their release is audited, not silent.
 */
export const protectedIds = (registry: PinRegistry): ReadonlySet<string> =>
  new Set(registry.pins.map((p) => p.entryId))

/** Actively pinned entries, in pin order (assembly order for the prompt prefix). */
export const activePins = (registry: PinRegistry): ReadonlyArray<Pin> => registry.pins

/** Carry the registry across a session fork/clone (synthetic continuation). */
export const cloneForSession = (registry: PinRegistry, newSessionId: string): PinRegistry => ({
  ...registry,
  sessionId: newSessionId,
})

/** One budget line item: an entry's id plus its token cost. */
export interface FitBlock {
  readonly entryId: string
  readonly tokens: number
}

/** A context-assembly plan that fits: pins first, then tail, nothing degraded. */
export interface FitPlan {
  readonly pins: ReadonlyArray<FitBlock>
  readonly tail: ReadonlyArray<FitBlock>
  readonly totalTokens: number
  readonly budget: number
}

/**
 * Budget interaction (architecture §3.2). Pins are never trimmed and the tail
 * is never silently degraded: if pins + tail cannot fit the budget, this fails
 * LOUD with a typed BudgetExceeded carrying the numbers. The caller must turn
 * this into a user-visible failure, never a quieter context.
 */
export const fitCheck = (args: {
  readonly pins: ReadonlyArray<FitBlock>
  readonly tail: ReadonlyArray<FitBlock>
  readonly budget: number
}): Effect.Effect<FitPlan, BudgetExceeded | PinError> =>
  Effect.gen(function* () {
    for (const block of [...args.pins, ...args.tail]) {
      if (!Number.isFinite(block.tokens) || block.tokens < 0) {
        return yield* Effect.fail(
          new PinError({ reason: `fit block has invalid token count: ${String(block.tokens)}`, entryId: block.entryId }),
        )
      }
    }
    const pinnedTokens = args.pins.reduce((sum, b) => sum + b.tokens, 0)
    const tailTokens = args.tail.reduce((sum, b) => sum + b.tokens, 0)
    const needed = pinnedTokens + tailTokens
    if (needed > args.budget) {
      return yield* Effect.fail(
        new BudgetExceeded({ needed, budget: args.budget, pinnedTokens, tailTokens }),
      )
    }
    return { pins: args.pins, tail: args.tail, totalTokens: needed, budget: args.budget }
  })
