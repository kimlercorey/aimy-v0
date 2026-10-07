/**
 * substrate/types.ts
 *
 * Shared branded types and the secret wrapper every library builds on.
 *
 * `Redacted<A>` is the one hard rule here: secrets (API keys, tokens,
 * keychain handles) are `Redacted` values in Effect and must NEVER appear in
 * logs, traces, tool args, or memory entries. The wrapper stores the value in
 * a module-private WeakMap — not as an own property — so even object spread
 * cannot smuggle it out, and its toString/toJSON/inspect renderings never
 * leak it. The only way to read a secret is the explicit, auditable `reveal()`.
 */

declare const instanceIdBrand: unique symbol
/** Install-instance identifier. Opaque by construction: build with `InstanceId(...)`. */
export type InstanceId = string & { readonly [instanceIdBrand]: "InstanceId" }
export const InstanceId = (raw: string): InstanceId => raw as InstanceId

declare const toolNameBrand: unique symbol
/** Canonical tool name as registered in the tool registry. */
export type ToolName = string & { readonly [toolNameBrand]: "ToolName" }
export const ToolName = (raw: string): ToolName => raw as ToolName

declare const timestampBrand: unique symbol
/** Milliseconds since the Unix epoch. Opaque by construction. */
export type Timestamp = number & { readonly [timestampBrand]: "Timestamp" }
export const Timestamp = {
  now: (): Timestamp => Date.now() as Timestamp,
  fromEpochMs: (ms: number): Timestamp => ms as Timestamp,
  toDate: (t: Timestamp): Date => new Date(t),
} as const

/** Plain JSON values (config files, memory payloads, module manifests). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

/**
 * A secret wrapper. String coercion, JSON serialization, and console/node
 * inspection all render as "Redacted" — the value itself lives only in a
 * module-private WeakMap, so spreading or property enumeration cannot leak it.
 *
 * Use `Redacted.make(value)` to wrap and `reveal()` at the single point of
 * use (a call site that must exist and be reviewable). Never log the result.
 */
const vault = new WeakMap<object, unknown>()

export class Redacted<A> {
  private constructor(value: A) {
    vault.set(this, value)
  }

  static make<A>(value: A): Redacted<A> {
    return new Redacted(value)
  }

  /** Explicit, auditable access to the wrapped value. Call sites must be reviewable. */
  reveal(): A {
    return vault.get(this) as A
  }

  toString(): string {
    return "Redacted"
  }

  toJSON(): string {
    return "Redacted"
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "Redacted"
  }
}
