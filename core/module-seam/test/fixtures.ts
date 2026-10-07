/** Shared fixtures for module-seam tests. */
import { Effect } from "effect"
import {
  type CapabilityManifest,
  type ModuleHookImpls,
  type ModuleHostApi,
  type ModuleLifecycleApi,
  type SafetyKernelSeam,
  type SkillStore,
  type SkillSummary,
  type ToolCall,
  Allow,
  ModuleLifecycle,
  ModuleLifecycleLive,
  allowAllKernel,
  makeBackendSet,
  makeDenyAllKernel,
  makeDirectGate,
  makeMapSkillStore,
  makeModuleHooks,
  makeModuleHost,
  stubIdentitySeam
} from "../src/index.js"

export const SKILL_MD_V1 = `---
name: web-research
version: 1.0.0
description: Web research reference module.
author: AImy
license: ISC
aimy:
  hooks: [beforeToolCall, afterToolCall]
  tools: [web_fetch, web_search, skill_view]
  filesystem:
    read: [/data/research]
    write: []
  network:
    vendorHosts: [api.search.example, cdn.fetch.example]
  memory:
    stores: [research]
    write: true
  subprocess: false
---

# Web Research

Body text here.
`

/** v2 narrows the manifest: drops web_search and memory write. */
export const SKILL_MD_V2_NARROW = `---
name: web-research
version: 2.0.0
description: Web research reference module.
aimy:
  hooks: [beforeToolCall]
  tools: [web_fetch, skill_view]
  filesystem:
    read: [/data/research]
    write: []
  network:
    vendorHosts: [api.search.example]
  memory:
    stores: [research]
    write: false
  subprocess: false
---
`

/** v2 widens the manifest: adds a tool, a write path, and subprocess. */
export const SKILL_MD_V2_WIDE = `---
name: web-research
version: 2.0.0
description: Web research reference module.
aimy:
  hooks: [beforeToolCall, afterToolCall]
  tools: [web_fetch, web_search, skill_view, code_exec]
  filesystem:
    read: [/data/research]
    write: [/data/research/out]
  network:
    vendorHosts: [api.search.example, cdn.fetch.example]
  memory:
    stores: [research]
    write: true
  subprocess: true
---
`

export const testManifest = (overrides: Partial<CapabilityManifest> = {}): CapabilityManifest => ({
  hooks: ["beforeToolCall"],
  tools: ["web_fetch"],
  filesystem: { read: ["/data"], write: [] },
  network: "none",
  memory: { stores: [], write: false },
  subprocess: false,
  ...overrides
})

export const testCall = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  id: "call-1",
  tool: "web_fetch",
  args: { url: "https://cdn.fetch.example/x" },
  tier: "T0",
  truncated: false,
  ...overrides
})

export interface TestHostOpts {
  readonly kernel?: SafetyKernelSeam
  readonly impls?: ReadonlyArray<ModuleHookImpls>
  readonly skills?: ReadonlyArray<SkillSummary>
  readonly skillStore?: SkillStore
}

export const testHostDeps = (lifecycle: ModuleLifecycleApi, opts: TestHostOpts = {}) => {
  const kernel = opts.kernel ?? allowAllKernel
  return {
    lifecycle,
    hooks: makeModuleHooks({ impls: opts.impls ?? [], kernel }),
    kernel,
    identity: stubIdentitySeam("test-instance-uuid-0001"),
    backends: makeBackendSet(makeDirectGate(kernel)),
    platform: "linux" as const,
    skills: opts.skills ?? [],
    skillStore: opts.skillStore ?? makeMapSkillStore(new Map())
  }
}

/**
 * Run a program against a fresh ModuleHost (in-memory lifecycle).
 * Provides ModuleLifecycleLive; hook impls + kernel come from opts.
 */
export const withTestHost = <A, E>(
  program: (host: ModuleHostApi) => Effect.Effect<A, E>,
  opts: TestHostOpts = {}
): Effect.Effect<A, E> =>
  Effect.provide(
    Effect.gen(function* () {
      const lifecycle = yield* ModuleLifecycle
      return yield* program(makeModuleHost(testHostDeps(lifecycle, opts)))
    }),
    ModuleLifecycleLive
  )

export { allowAllKernel, makeDenyAllKernel, Allow }
