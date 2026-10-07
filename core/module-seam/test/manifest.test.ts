/** Manifest parsing + validation + fail-closed capability predicates. */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  ModuleError,
  canEgress,
  canReadPath,
  canSpawnSubprocess,
  canUseMemoryStore,
  canWriteMemory,
  canWritePath,
  declaresHook,
  declaresTool,
  parseModuleManifest
} from "../src/index.js"
import { SKILL_MD_V1, testManifest } from "./fixtures.js"

describe("parseModuleManifest", () => {
  it.effect("parses a valid SKILL.md frontmatter", () =>
    Effect.gen(function* () {
      const m = yield* parseModuleManifest(SKILL_MD_V1, "web-research")
      expect(m.name).toBe("web-research")
      expect(m.version).toBe("1.0.0")
      expect(m.capability.tools).toEqual(["web_fetch", "web_search", "skill_view"])
      expect(m.capability.hooks).toEqual(["beforeToolCall", "afterToolCall"])
      expect(m.capability.filesystem.read).toEqual(["/data/research"])
      expect(m.capability.network).toEqual({ vendorHosts: ["api.search.example", "cdn.fetch.example"] })
      expect(m.capability.memory).toEqual({ stores: ["research"], write: true })
      expect(m.capability.subprocess).toBe(false)
    })
  )

  it.effect("missing frontmatter is a typed ModuleError", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(parseModuleManifest("# no frontmatter\n", "m"))
      expect(err).toBeInstanceOf(ModuleError)
    })
  )

  it.effect("unknown capability keys are rejected fail-closed", () =>
    Effect.gen(function* () {
      const md = SKILL_MD_V1.replace("  subprocess: false", "  subprocess: false\n  backdoor: true")
      const err = yield* Effect.flip(parseModuleManifest(md, "web-research"))
      expect(err).toBeInstanceOf(ModuleError)
      expect((err as ModuleError).reason).toContain("backdoor")
    })
  )

  it.effect("declaring an unknown hook is rejected", () =>
    Effect.gen(function* () {
      const md = SKILL_MD_V1.replace(
        "  hooks: [beforeToolCall, afterToolCall]",
        "  hooks: [beforeToolCall, mindControl]"
      )
      const err = yield* Effect.flip(parseModuleManifest(md, "web-research"))
      expect(err).toBeInstanceOf(ModuleError)
      expect((err as ModuleError).reason).toContain("mindControl")
    })
  )

  it.effect("relative filesystem scopes are rejected", () =>
    Effect.gen(function* () {
      const md = SKILL_MD_V1.replace("read: [/data/research]", "read: [data/research]")
      const err = yield* Effect.flip(parseModuleManifest(md, "web-research"))
      expect(err).toBeInstanceOf(ModuleError)
      expect((err as ModuleError).reason).toContain("absolute path")
    })
  )

  it.effect("invalid vendor hostnames are rejected", () =>
    Effect.gen(function* () {
      const md = SKILL_MD_V1.replace("api.search.example", "not a host!!")
      const err = yield* Effect.flip(parseModuleManifest(md, "web-research"))
      expect(err).toBeInstanceOf(ModuleError)
    })
  )

  it.effect("block-style YAML and first-party network parse", () =>
    Effect.gen(function* () {
      const md = `---
name: local-only
version: 0.1.0
description: Local module.
aimy:
  hooks:
    - beforeToolCall
  tools:
    - read_notes
  filesystem:
    read:
      - /notes
    write: []
  network: first-party
  memory:
    stores: []
    write: false
  subprocess: false
---
`
      const m = yield* parseModuleManifest(md, "local-only")
      expect(m.capability.network).toBe("first-party")
      expect(m.capability.filesystem.read).toEqual(["/notes"])
    })
  )
})

describe("capability predicates (fail-closed)", () => {
  const m = testManifest({
    tools: ["web_fetch"],
    hooks: ["beforeToolCall"],
    filesystem: { read: ["/data/research"], write: ["/data/research/out"] },
    network: { vendorHosts: ["api.search.example"] },
    memory: { stores: ["research"], write: false },
    subprocess: false
  })

  it("undeclared tools and hooks are denied", () => {
    expect(declaresTool(m, "web_fetch")).toBe(true)
    expect(declaresTool(m, "code_exec")).toBe(false)
    expect(declaresHook(m, "beforeToolCall")).toBe(true)
    expect(declaresHook(m, "transformContext")).toBe(false)
  })

  it("filesystem scopes are prefix-contained", () => {
    expect(canReadPath(m, "/data/research/a/b")).toBe(true)
    expect(canReadPath(m, "/data/research")).toBe(true)
    expect(canReadPath(m, "/data/other")).toBe(false)
    expect(canReadPath(m, "/data/research-evil")).toBe(false) // prefix, not path segment
    expect(canWritePath(m, "/data/research/out/f")).toBe(true)
    expect(canWritePath(m, "/data/research/f")).toBe(false)
  })

  it("network egress classes", () => {
    expect(canEgress(m, "api.search.example", [])).toBe(true)
    expect(canEgress(m, "evil.example", [])).toBe(false)
    expect(canEgress(testManifest({ network: "none" }), "api.search.example", [])).toBe(false)
    const fp = testManifest({ network: "first-party" })
    expect(canEgress(fp, "printer.lan", ["printer.lan"])).toBe(true)
    expect(canEgress(fp, "evil.example", ["printer.lan"])).toBe(false)
  })

  it("memory and subprocess defaults deny", () => {
    expect(canUseMemoryStore(m, "research")).toBe(true)
    expect(canUseMemoryStore(m, "other")).toBe(false)
    expect(canWriteMemory(m)).toBe(false)
    expect(canWriteMemory(testManifest({ memory: { stores: [], write: true } }))).toBe(true)
    expect(canSpawnSubprocess(m)).toBe(false)
    expect(canSpawnSubprocess(testManifest({ subprocess: true }))).toBe(true)
  })
})
