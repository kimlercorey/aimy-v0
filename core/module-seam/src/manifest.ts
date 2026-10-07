/**
 * SKILL.md frontmatter parsing + AImy capability manifest validation.
 *
 * Package shape (SKILL.md-compatible):
 *
 *   ---
 *   name: my-module
 *   version: 1.0.0
 *   description: One line.
 *   aimy:
 *     hooks: [beforeToolCall]
 *     tools: [web_fetch]
 *     filesystem: {read: [...], write: [...]}   # or block form
 *     network: none | first-party | {vendorHosts: [...]}
 *     memory: {stores: [...], write: false}
 *     subprocess: false
 *   ---
 *
 * Fail-closed: anything undeclared is denied. Unknown capability keys,
 * unknown hook names, non-absolute paths, and malformed hostnames are all
 * typed `ModuleError`s — an invalid manifest never loads.
 *
 * YAML support is a deliberately small subset (block maps, block sequences,
 * inline [lists], scalars, comments). Anything outside it fails loudly
 * rather than parsing surprisingly.
 */
import { Effect, Schema } from "effect"
import { ModuleError } from "./errors.js"
import { HOOK_NAMES } from "./hooks.js"

export interface FilesystemScope {
  readonly read: ReadonlyArray<string>
  readonly write: ReadonlyArray<string>
}

export type NetworkEgress = "none" | "first-party" | { readonly vendorHosts: ReadonlyArray<string> }

export interface MemoryScope {
  readonly stores: ReadonlyArray<string>
  readonly write: boolean
}

export interface CapabilityManifest {
  readonly hooks: ReadonlyArray<string>
  readonly tools: ReadonlyArray<string>
  readonly filesystem: FilesystemScope
  readonly network: NetworkEgress
  readonly memory: MemoryScope
  readonly subprocess: boolean
}

export interface ParsedModuleManifest {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly author: string | undefined
  readonly license: string | undefined
  readonly capability: CapabilityManifest
}

/* ------------------------------------------------------------------ */
/* YAML subset parser                                                  */
/* ------------------------------------------------------------------ */

type YamlScalar = string | number | boolean | null
type YamlValue = YamlScalar | Array<YamlValue> | { [key: string]: YamlValue }

interface SrcLine {
  readonly indent: number
  readonly text: string
  readonly num: number
}

class YamlParseError extends Error {
  constructor(readonly lineNum: number, message: string) {
    super(`line ${lineNum}: ${message}`)
  }
}

const tokenize = (src: string): Array<SrcLine> => {
  const out: Array<SrcLine> = []
  const raw = src.split("\n")
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] ?? ""
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    out.push({ indent: line.length - line.trimStart().length, text: trimmed, num: i + 1 })
  }
  return out
}

const parseScalar = (text: string, lineNum: number): YamlScalar => {
  const t = text.trim()
  if (t.length === 0) throw new YamlParseError(lineNum, "empty scalar")
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1)
    return t.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner
  }
  if (t === "true") return true
  if (t === "false") return false
  if (t === "null" || t === "~") return null
  if (/^-?\d+$/.test(t)) return parseInt(t, 10)
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t)
  return t
}

/** Split inline-list contents on top-level commas (quote-aware). */
const splitInline = (inner: string, lineNum: number): Array<string> => {
  const parts: Array<string> = []
  let cur = ""
  let quote: string | undefined
  for (const ch of inner) {
    if (quote !== undefined) {
      cur += ch
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ",") {
      parts.push(cur)
      cur = ""
    } else {
      cur += ch
    }
  }
  if (quote !== undefined) throw new YamlParseError(lineNum, "unterminated quote in inline list")
  parts.push(cur)
  return parts
}

const parseInlineList = (text: string, lineNum: number): Array<YamlValue> => {
  const inner = text.trim().slice(1, -1).trim()
  if (inner === "") return []
  return splitInline(inner, lineNum).map((p) => parseScalar(p, lineNum))
}

class YamlParser {
  constructor(private readonly lines: Array<SrcLine>) {}
  private pos = 0

  parse(): YamlValue {
    if (this.lines.length === 0) throw new YamlParseError(1, "empty frontmatter")
    const value = this.parseBlock(this.lines[0]!.indent)
    if (this.pos < this.lines.length) {
      const stray = this.lines[this.pos]!
      throw new YamlParseError(stray.num, `unexpected content '${stray.text}'`)
    }
    return value
  }

  private parseBlock(indent: number): YamlValue {
    const line = this.lines[this.pos]
    if (line === undefined || line.indent !== indent) {
      throw new YamlParseError(line?.num ?? 0, "expected a mapping or sequence here")
    }
    return line.text.startsWith("-") && (line.text === "-" || line.text.startsWith("- "))
      ? this.parseSequence(indent)
      : this.parseMapping(indent)
  }

  private parseMapping(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {}
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!
      if (line.indent !== indent || line.text === "-" || line.text.startsWith("- ")) break
      const colon = line.text.indexOf(":")
      if (colon < 0) throw new YamlParseError(line.num, `expected 'key: value', got '${line.text}'`)
      const rawKey = line.text.slice(0, colon).trim()
      const key = String(parseScalar(rawKey, line.num))
      if (key in out) throw new YamlParseError(line.num, `duplicate key '${key}'`)
      const rest = line.text.slice(colon + 1).trim()
      this.pos++
      if (rest === "") {
        const next = this.lines[this.pos]
        if (next === undefined || next.indent <= indent) {
          throw new YamlParseError(line.num, `key '${key}' needs a nested block`)
        }
        out[key] = this.parseBlock(next.indent)
      } else if (rest.startsWith("[")) {
        if (!rest.endsWith("]")) throw new YamlParseError(line.num, "unterminated inline list")
        out[key] = parseInlineList(rest, line.num)
      } else {
        out[key] = parseScalar(rest, line.num)
      }
    }
    return out
  }

  private parseSequence(indent: number): Array<YamlValue> {
    const out: Array<YamlValue> = []
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!
      if (line.indent !== indent || !(line.text === "-" || line.text.startsWith("- "))) break
      const item = line.text === "-" ? "" : line.text.slice(2).trim()
      this.pos++
      if (item === "") {
        const next = this.lines[this.pos]
        if (next === undefined || next.indent <= indent) {
          throw new YamlParseError(line.num, "sequence item needs a nested block")
        }
        out.push(this.parseBlock(next.indent))
      } else if (item.startsWith("[")) {
        if (!item.endsWith("]")) throw new YamlParseError(line.num, "unterminated inline list")
        out.push(parseInlineList(item, line.num))
      } else {
        out.push(parseScalar(item, line.num))
      }
    }
    return out
  }
}

/* ------------------------------------------------------------------ */
/* Frontmatter + schema validation                                     */
/* ------------------------------------------------------------------ */

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export interface SplitFrontmatter {
  readonly frontmatter: string
  readonly body: string
}

export const splitFrontmatter = (text: string, module: string): Effect.Effect<SplitFrontmatter, ModuleError> =>
  Effect.gen(function* () {
    const m = FRONTMATTER_RE.exec(text)
    if (m === null || m[1] === undefined) {
      return yield* Effect.fail(
        new ModuleError({ module, reason: "SKILL.md has no YAML frontmatter (expected '---' fences)" })
      )
    }
    return { frontmatter: m[1], body: text.slice(m[0].length) }
  })

const NetworkEgressSchema = Schema.Union([
  Schema.Literal("none"),
  Schema.Literal("first-party"),
  Schema.Struct({ vendorHosts: Schema.Array(Schema.String) })
])

const CapabilityManifestSchema = Schema.Struct({
  hooks: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  filesystem: Schema.Struct({
    read: Schema.Array(Schema.String),
    write: Schema.Array(Schema.String)
  }),
  network: NetworkEgressSchema,
  memory: Schema.Struct({
    stores: Schema.Array(Schema.String),
    write: Schema.Boolean
  }),
  subprocess: Schema.Boolean
})

const ModuleFrontmatterSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  author: Schema.optional(Schema.String),
  license: Schema.optional(Schema.String),
  aimy: Schema.Struct({
    hooks: Schema.Array(Schema.String),
    tools: Schema.Array(Schema.String),
    filesystem: Schema.Struct({
      read: Schema.Array(Schema.String),
      write: Schema.Array(Schema.String)
    }),
    network: NetworkEgressSchema,
    memory: Schema.Struct({
      stores: Schema.Array(Schema.String),
      write: Schema.Boolean
    }),
    subprocess: Schema.Boolean
  })
})

type ModuleFrontmatter = typeof ModuleFrontmatterSchema["Type"]

const TOP_LEVEL_KEYS = ["name", "version", "description", "author", "license", "aimy"] as const
const AIMY_KEYS = ["hooks", "tools", "filesystem", "network", "memory", "subprocess"] as const

const assertNoUnknownKeys = (raw: unknown, module: string): Effect.Effect<Record<string, unknown>, ModuleError> =>
  Effect.gen(function* () {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return yield* Effect.fail(new ModuleError({ module, reason: "frontmatter must be a YAML mapping" }))
    }
    const obj = raw as Record<string, unknown>
    for (const k of Object.keys(obj)) {
      if (!(TOP_LEVEL_KEYS as ReadonlyArray<string>).includes(k)) {
        return yield* Effect.fail(new ModuleError({ module, reason: `unknown frontmatter key '${k}' (fail-closed)` }))
      }
    }
    const aimy = obj["aimy"]
    if (typeof aimy !== "object" || aimy === null || Array.isArray(aimy)) {
      return yield* Effect.fail(new ModuleError({ module, reason: "frontmatter 'aimy' block must be a mapping" }))
    }
    for (const k of Object.keys(aimy as Record<string, unknown>)) {
      if (!(AIMY_KEYS as ReadonlyArray<string>).includes(k)) {
        return yield* Effect.fail(
          new ModuleError({ module, reason: `unknown capability key 'aimy.${k}' (fail-closed: undeclared = denied)` })
        )
      }
    }
    return obj
  })

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i

const validateSemantics = (fm: ModuleFrontmatter, module: string): Effect.Effect<void, ModuleError> =>
  Effect.gen(function* () {
    for (const h of fm.aimy.hooks) {
      if (!(HOOK_NAMES as ReadonlyArray<string>).includes(h)) {
        return yield* Effect.fail(new ModuleError({ module, reason: `declares unknown hook '${h}'` }))
      }
    }
    for (const t of fm.aimy.tools) {
      if (t.trim() === "") {
        return yield* Effect.fail(new ModuleError({ module, reason: "tool names must be non-empty" }))
      }
    }
    for (const p of [...fm.aimy.filesystem.read, ...fm.aimy.filesystem.write]) {
      if (!p.startsWith("/")) {
        return yield* Effect.fail(new ModuleError({ module, reason: `filesystem scope '${p}' must be an absolute path` }))
      }
    }
    const net = fm.aimy.network
    if (typeof net !== "string") {
      for (const h of net.vendorHosts) {
        if (!HOSTNAME_RE.test(h)) {
          return yield* Effect.fail(new ModuleError({ module, reason: `vendor host '${h}' is not a valid hostname` }))
        }
      }
    }
  })

const summarizeSchemaError = (e: unknown): string =>
  e instanceof Error ? e.message.split("\n")[0] ?? "schema validation failed" : "schema validation failed"

/**
 * Parse + validate a SKILL.md document. Invalid manifests are typed
 * ModuleErrors — they never load.
 */
export const parseModuleManifest = (skillMd: string, module: string): Effect.Effect<ParsedModuleManifest, ModuleError> =>
  Effect.gen(function* () {
    const { frontmatter } = yield* splitFrontmatter(skillMd, module)
    const raw = yield* Effect.try({
      try: () => new YamlParser(tokenize(frontmatter)).parse(),
      catch: (e) =>
        new ModuleError({
          module,
          reason: `frontmatter YAML error: ${e instanceof YamlParseError ? e.message : String(e)}`
        })
    })
    const checked = yield* assertNoUnknownKeys(raw, module)
    const fm = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ModuleFrontmatterSchema)(checked),
      catch: (e) => new ModuleError({ module, reason: `invalid manifest: ${summarizeSchemaError(e)}` })
    })
    yield* validateSemantics(fm, module)
    return {
      name: fm.name,
      version: fm.version,
      description: fm.description,
      author: fm.author,
      license: fm.license,
      capability: fm.aimy as CapabilityManifest
    } satisfies ParsedModuleManifest
  })

/* ------------------------------------------------------------------ */
/* Fail-closed capability predicates                                   */
/* ------------------------------------------------------------------ */

/** Anything not declared is denied. These are the enforcement predicates. */
export const declaresHook = (m: CapabilityManifest, hook: string): boolean => m.hooks.includes(hook)
export const declaresTool = (m: CapabilityManifest, tool: string): boolean => m.tools.includes(tool)

const withinScope = (path: string, scope: string): boolean =>
  path === scope || path.startsWith(scope.endsWith("/") ? scope : `${scope}/`)

export const canReadPath = (m: CapabilityManifest, path: string): boolean =>
  m.filesystem.read.some((scope) => withinScope(path, scope))

export const canWritePath = (m: CapabilityManifest, path: string): boolean =>
  m.filesystem.write.some((scope) => withinScope(path, scope))

export const canEgress = (
  m: CapabilityManifest,
  host: string,
  firstPartyHosts: ReadonlyArray<string>
): boolean => {
  const net = m.network
  if (net === "none") return false
  if (net === "first-party") return firstPartyHosts.includes(host)
  return net.vendorHosts.includes(host)
}

export const canUseMemoryStore = (m: CapabilityManifest, store: string): boolean => m.memory.stores.includes(store)
export const canWriteMemory = (m: CapabilityManifest): boolean => m.memory.write
export const canSpawnSubprocess = (m: CapabilityManifest): boolean => m.subprocess
