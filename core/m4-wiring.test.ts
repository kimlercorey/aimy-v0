/**
 * m4-wiring.test.ts — M4 Track 3 acceptance: the full stack, wired and
 * driven end to end.
 *
 * Stack (Layers, composed):
 *   SafetyKernel.layerFromPolicy(openPolicy)
 *     -> kernel-backed PermissionGate behind MemoryServiceLive (+ tmp MemoryPaths)
 *     -> ModuleHooks with the REAL kernel behind the SafetyKernelSeam
 *        (the module-hook dispatcher; the web-research impls ride it)
 *     -> ModuleHost via makeModuleHost (lifecycle + hook dispatch +
 *        manifest enforcement + DirectGate + runtime registry), provided as
 *        a Layer alongside the rest; the host's own kernel seam and the
 *        DirectGate use the allow-all stub (the manifest/hook/dispatch
 *        enforcement under test lives in the host, not the kernel)
 *     -> HonestyServiceInMemory (the SAME ledger the research tool writes)
 *     -> InferencePoolLive (zero-socket: no provider registered)
 *     -> AgentLoop via layerAgentLoop() (honesty picked up via serviceOption)
 *   web-research installed from its REAL SKILL.md via packageModule
 *   (tier T1) -> enable -> start; the research tool runs against a MOCK
 *   HttpClient (fixture routes + request spy) — no test here opens a socket.
 *
 * Covers:
 *   1. Full-stack composition: a "research X" tool call routes through the
 *      seam (ModuleHost.callTool) to the module; the module's hooks fire;
 *      its claims land in the HonestyService ledger with correct badges
 *      (sourced -> verified with evidence, synthesis/coverage -> unverified);
 *      an undeclared tool is denied by the manifest before any hook fires.
 *   2. Manifest enforcement: egress to an undeclared host is a typed
 *      CapabilityDenied (fail-closed); the fetch-policy denial happens
 *      BEFORE any socket opens (asserted via the fetch spy).
 *   3. Disable-mid-run: a disable issued mid-turn stops hook dispatch
 *      immediately (counter-proven), cleans the runtime registry (no
 *      residue), and a research.query while disabled fails with a clean
 *      typed ModuleError — not a hang, not a silent no-op.
 *   4. Badge correctness: sourced claim -> getBadge "verified" with the
 *      evidence listed; unsourced claim -> "unverified", structurally.
 */
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { AgentLoop, layerAgentLoop, type AgentLoopService } from "./agent-loop/src/index.js"
import { HonestyService, HonestyServiceInMemory } from "./honesty/index.js"
import type { HonestyServiceShape } from "./honesty/src/service.js"
import { InferencePoolLive } from "./inference-pool/index.js"
import {
  MemoryDirs,
  MemoryPaths,
  MemoryService,
  MemoryServiceLive,
  PermissionGate,
  type MemoryServiceShape
} from "./memory/index.js"
import {
  Allow,
  Ask,
  CapabilityDenied,
  ModuleError,
  ModuleHost,
  ModuleHooks,
  ModuleLifecycle,
  ModuleLifecycleLive,
  PermissionDenied,
  allowAllKernel,
  enforceEgress,
  makeBackendSet,
  makeDirectGate,
  makeMapSkillStore,
  makeModuleHooks,
  makeModuleHost,
  packageModule,
  stubIdentitySeam,
  type GateVerdict,
  type ModuleHookImpls,
  type ModuleHostApi,
  type ModuleLifecycleApi,
  type SafetyKernelSeam,
  type ToolCall,
  type ToolOutcome
} from "./module-seam/src/index.js"
import {
  PolicyDocument,
  SafetyKernel,
  type SafetyKernelService
} from "./permission-kernel/index.js"
import { ToolName } from "./substrate/types.js"
import {
  EgressDenied,
  RESEARCH_MODULE,
  RESEARCH_QUERY_TOOL,
  checkFetchEgress,
  fetchSource,
  makeDuckDuckGoHtmlProvider,
  makeResearchTool,
  researchHookImpls,
  researchToolCall,
  type HttpClientShape,
  type HttpResponse,
  type ResearchTool
} from "./web-research/src/index.js"
import { DDG_HTML_FIXTURE, SOURCE_HTML_FIXTURE, ok } from "./web-research/test/fixtures.js"

// ---------------------------------------------------------------------------
// Fixtures (the proven patterns from m1-wiring.test.ts)
// ---------------------------------------------------------------------------

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "aimy-m4-test-"))

const webResearchDir = (): string => fileURLToPath(new URL("./web-research", import.meta.url))

const pathsLayer = (dir: string): Layer.Layer<MemoryPaths> =>
  Layer.succeed(MemoryPaths, {
    sessionsDir: path.join(dir, "sessions"),
    storesDir: path.join(dir, "stores")
  } satisfies MemoryDirs)

/** Production-shape gate: every memory op decided by the real SafetyKernel. */
const kernelBackedGate: Layer.Layer<PermissionGate, never, SafetyKernel> = Layer.effect(
  PermissionGate,
  Effect.gen(function* () {
    const kernel = yield* SafetyKernel
    return {
      checkMemory: (op: "read" | "write", store: string) =>
        Effect.gen(function* () {
          const tier = op === "read" ? ("T0" as const) : ("T1" as const)
          const tool = ToolName(`memory:${store}:${op}`)
          const decision = yield* kernel.check({
            tool,
            tier,
            args: { op, store },
            provenance: "m4-wiring-test/memory-gate"
          })
          if (decision === "ask") {
            return yield* Effect.fail(
              new PermissionDenied({
                tool,
                tier,
                reason: "ask unresolved: no interactive approver in headless tests"
              })
            )
          }
        })
    }
  })
)

/**
 * Adapt the REAL SafetyKernel behind the module-seam's structural
 * `SafetyKernelSeam` (same adapter as m1-wiring.test.ts).
 */
const seamFromKernel = (kernel: SafetyKernelService): SafetyKernelSeam => {
  const toKernelIntent = (intent: { tool: string; tier: "T0" | "T1" | "T2" | "T3"; module: string }) => ({
    tool: ToolName(intent.tool),
    tier: intent.tier,
    args: { module: intent.module, tool: intent.tool, tier: intent.tier },
    provenance: `m4-wiring:${intent.module}`
  })
  return {
    check: (intent) =>
      kernel.check(toKernelIntent(intent)).pipe(
        Effect.map(
          (decision): GateVerdict =>
            decision === "allow"
              ? Allow
              : Ask("ask unresolved: no interactive approver in headless tests")
        ),
        Effect.catch((denied: PermissionDenied) =>
          Effect.succeed<GateVerdict>({
            _tag: "Deny",
            reason: denied.reason,
            terminate: false
          })
        )
      ),
    execute: (intent, run) => kernel.execute(toKernelIntent(intent), () => run)
  }
}

const hooksLayer = (
  impls: ReadonlyArray<ModuleHookImpls>
): Layer.Layer<ModuleHooks, never, SafetyKernel> =>
  Layer.effect(
    ModuleHooks,
    Effect.gen(function* () {
      const kernel = yield* SafetyKernel
      return makeModuleHooks({ impls, kernel: seamFromKernel(kernel) })
    })
  )

const openPolicy: PolicyDocument = {
  version: 1,
  rules: [
    { tool: "*", tier: "T0", decision: "allow", reason: "m4 wiring: T0 reads and tools" },
    { tool: "*", tier: "T1", decision: "allow", reason: "m4 wiring: T1 tools (research.query)" },
    { tool: "*", tier: "T2", decision: "deny", reason: "m4 wiring default" },
    { tool: "*", tier: "T3", decision: "deny", reason: "m4 wiring default" }
  ]
}

// ---------------------------------------------------------------------------
// The M4 world: counting hook wrapper + spying mock HTTP + full layer stack
// ---------------------------------------------------------------------------

/** Plain-object hook-fire counters (created before the layers, read after). */
export interface HookFireCounts {
  beforeToolCall: number
  afterToolCall: number
  seenTools: Array<string>
}

/** web-research hook impls with a counting wrapper: every fired hook is proven. */
const countingResearchImpls = (counts: HookFireCounts): ModuleHookImpls => {
  const base = researchHookImpls(RESEARCH_MODULE)
  return {
    module: RESEARCH_MODULE,
    beforeToolCall: (call: ToolCall) =>
      Effect.andThen(
        Effect.sync(() => {
          counts.beforeToolCall++
          counts.seenTools.push(call.tool)
        }),
        base.beforeToolCall?.(call) ?? Effect.succeed(Allow)
      ),
    afterToolCall: (call: ToolCall, outcome: ToolOutcome) =>
      Effect.andThen(
        Effect.sync(() => {
          counts.afterToolCall++
        }),
        base.afterToolCall?.(call, outcome) ?? Effect.succeed(outcome)
      )
  }
}

const SEARCH_URL = "https://html.duckduckgo.com/html/?q=test%20query"

const fixtureRoutes = (): Map<string, HttpResponse> =>
  new Map([
    [SEARCH_URL, ok(DDG_HTML_FIXTURE)],
    ["https://example.com/first", ok(SOURCE_HTML_FIXTURE)],
    [
      "https://example.org/second",
      ok(
        SOURCE_HTML_FIXTURE.replace("Example Article &amp; Findings", "Second Article").replace(
          "The quick brown fox jumps over the lazy dog.",
          "A completely different second source text."
        )
      )
    ]
  ])

const buildM4Layers = (dir: string, impls: ReadonlyArray<ModuleHookImpls>) => {
  const kernelLayer = SafetyKernel.layerFromPolicy(openPolicy)
  const memoryStack = Layer.provide(
    Layer.provide(MemoryServiceLive, Layer.mergeAll(kernelBackedGate, pathsLayer(dir))),
    kernelLayer
  )
  const hooksStack = Layer.provide(hooksLayer(impls), kernelLayer)
  const hostLayer: Layer.Layer<ModuleHost, never, ModuleHooks | ModuleLifecycle> = Layer.effect(
    ModuleHost,
    Effect.gen(function* () {
      const lifecycle = yield* ModuleLifecycle
      const hooks = yield* ModuleHooks
      return makeModuleHost({
        lifecycle,
        hooks,
        kernel: allowAllKernel,
        identity: stubIdentitySeam("m4-test-instance-0001"),
        backends: makeBackendSet(makeDirectGate(allowAllKernel)),
        platform: "linux",
        skills: [],
        skillStore: makeMapSkillStore(new Map())
      })
    })
  )
  // Effect 4: Layer.mergeAll does NOT wire requirements between siblings —
  // the host's requirements are provided explicitly, then the
  // requirement-free stacks merge.
  const hostStack = Layer.provide(hostLayer, Layer.mergeAll(hooksStack, ModuleLifecycleLive))
  const base = Layer.mergeAll(
    InferencePoolLive,
    hooksStack,
    memoryStack,
    HonestyServiceInMemory,
    ModuleLifecycleLive
  )
  const loopOnly = Layer.provide(layerAgentLoop(), base)
  return Layer.mergeAll(
    loopOnly,
    hostStack,
    InferencePoolLive,
    hooksStack,
    memoryStack,
    HonestyServiceInMemory,
    ModuleLifecycleLive
  )
}

export interface M4World {
  readonly host: ModuleHostApi
  readonly lifecycle: ModuleLifecycleApi
  readonly agentLoop: AgentLoopService
  readonly memory: MemoryServiceShape
  readonly tool: ResearchTool
  readonly honesty: HonestyServiceShape
  readonly http: HttpClientShape
  readonly counts: HookFireCounts
  /** Every URL the mock HTTP layer was asked for, in order (the fetch spy). */
  readonly requested: Array<string>
}

/**
 * Build a fresh M4 world: full layer stack + web-research installed from its
 * REAL SKILL.md (packageModule, tier T1), enabled, started. The HTTP layer
 * is mocked (fixture routes + spy) — no socket is ever opened.
 */
const withM4World = <A, E>(
  program: (world: M4World) => Effect.Effect<A, E>
): Promise<A> => {
  const dir = tmpRoot()
  const counts: HookFireCounts = { beforeToolCall: 0, afterToolCall: 0, seenTools: [] }
  const requested: Array<string> = []
  const routes = fixtureRoutes()
  const http: HttpClientShape = {
    request: (req) =>
      Effect.suspend(() => {
        requested.push(req.url)
        const res = routes.get(req.url)
        return res === undefined
          ? Effect.succeed({ status: 404, contentType: "text/html", body: "not found" })
          : Effect.succeed(res)
      })
  }
  const layer = buildM4Layers(dir, [countingResearchImpls(counts)])
  return Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* ModuleHost
      const lifecycle = yield* ModuleLifecycle
      const agentLoop = yield* AgentLoop
      const memory = yield* MemoryService
      const honesty = yield* HonestyService
      const pkg = yield* packageModule(webResearchDir(), { tier: "T1" })
      expect(pkg.moduleId).toBe(RESEARCH_MODULE)
      yield* host.install(pkg)
      yield* host.enable(RESEARCH_MODULE)
      yield* host.start(RESEARCH_MODULE)
      const tool = makeResearchTool({
        provider: makeDuckDuckGoHtmlProvider({ http }),
        http,
        honesty
      })
      return yield* program({ host, lifecycle, agentLoop, memory, tool, honesty, http, counts, requested })
    }).pipe(Effect.provide(layer))
  )
}

const researchArgs = (query: string, sessionId: string, turnId: string) => ({
  query,
  sessionId,
  turnId
})

// ---------------------------------------------------------------------------
// 1. Full-stack composition: "research X" routes through the seam
// ---------------------------------------------------------------------------

describe("M4 full-stack composition", () => {
  it("routes 'research X' through the seam: hooks fire, claims land badged in the ledger", async () => {
    await withM4World(({ host, agentLoop, memory, tool, honesty, counts }) =>
      Effect.gen(function* () {
        // Composition proof: the sibling services resolve from the same layer build.
        expect(agentLoop).toBeDefined()
        const tree = yield* memory.read("m4-probe")
        expect(Array.isArray(tree.entries)).toBe(true)

        expect(yield* host.runtimeModules()).toEqual([RESEARCH_MODULE])

        const report = yield* host.callTool(
          RESEARCH_MODULE,
          researchToolCall("m4t1:call:0", researchArgs("test query", "m4s1", "m4t1")),
          tool.invoke(researchArgs("test query", "m4s1", "m4t1"))
        )

        // Routed through the seam: the module's hooks fired on THIS call.
        expect(counts.beforeToolCall).toBe(1)
        expect(counts.afterToolCall).toBe(1)
        expect(counts.seenTools).toEqual([RESEARCH_QUERY_TOOL])

        // Fixture: 3 results; the http:// one is egress-denied; 2 fetched.
        expect(report.resultCount).toBe(3)
        expect(report.fetchedCount).toBe(2)
        expect(report.claims).toHaveLength(4)

        // Ledger badges, asserted through the service: sourced -> verified
        // with evidence listed; synthesis/coverage -> unverified.
        const verified = report.claims.filter((c) => c.badge.status === "verified")
        const unverified = report.claims.filter((c) => c.badge.status === "unverified")
        expect(verified).toHaveLength(2)
        expect(unverified).toHaveLength(2)
        for (const { claim, badge } of report.claims) {
          const fresh = yield* honesty.getBadge(claim.claimId)
          expect(fresh.status).toBe(badge.status)
          if (badge.status === "verified") {
            const ev = yield* honesty.evidenceFor(claim.claimId)
            expect(ev).toHaveLength(1)
            expect(ev[0]?.kind).toBe("source")
            expect(claim.text).toContain(ev[0]?.ref ?? "∅")
          } else {
            expect(yield* honesty.evidenceFor(claim.claimId)).toHaveLength(0)
          }
        }

        // Manifest enforcement at the seam: an undeclared tool is denied
        // BEFORE any hook fires — it never reaches the module.
        const denied = yield* Effect.flip(
          host.callTool(
            RESEARCH_MODULE,
            {
              ...researchToolCall("m4t1:call:1", researchArgs("x", "m4s1", "m4t1")),
              tool: "web_fetch"
            },
            Effect.succeed("must never run")
          )
        )
        expect(denied).toBeInstanceOf(PermissionDenied)
        expect(counts.beforeToolCall).toBe(1)
        expect(counts.afterToolCall).toBe(1)
      })
    )
  })
})

// ---------------------------------------------------------------------------
// 2. Manifest enforcement: egress to an undeclared host is denied, no socket
// ---------------------------------------------------------------------------

describe("M4 manifest enforcement", () => {
  it("denies egress to an undeclared host fail-closed, opening no socket", async () => {
    await withM4World(({ http, lifecycle, requested }) =>
      Effect.gen(function* () {
        const manifest = (yield* lifecycle.get(RESEARCH_MODULE)).manifest
        // The installed manifest allowlists exactly the declared search host.
        expect(manifest.network).toEqual({ vendorHosts: ["html.duckduckgo.com"] })

        // Declared host passes; normalization (case, port) never widens the match.
        yield* enforceEgress(
          manifest,
          { moduleId: RESEARCH_MODULE, host: "HTML.DUCKDUCKGO.COM:443" },
          { firstPartyHosts: [] }
        )

        // Undeclared host -> typed CapabilityDenied, fail-closed.
        const denied = yield* Effect.flip(
          enforceEgress(
            manifest,
            { moduleId: RESEARCH_MODULE, host: "evil.example.com" },
            { firstPartyHosts: [] }
          )
        )
        expect(denied).toBeInstanceOf(CapabilityDenied)
        expect(denied.capability).toBe("network.egress")
        expect(denied.requested).toBe("evil.example.com")

        // Fetch-policy level: the denial happens BEFORE any socket opens.
        const before = requested.length
        const egressDenied = yield* Effect.flip(
          fetchSource({ http }, "https://evil.example.com/page", new Set(["example.com"]))
        )
        expect(egressDenied).toBeInstanceOf(EgressDenied)
        expect(requested.length).toBe(before) // the spy saw no new request: no socket opened

        // The pure URL gate agrees (defense in depth, same verdict).
        const gateDenied = yield* Effect.flip(
          checkFetchEgress("https://evil.example.com/page", new Set(["example.com"]))
        )
        expect(gateDenied).toBeInstanceOf(EgressDenied)

        // Positive control: an allowed fetch DOES reach the (mock) network.
        const src = yield* fetchSource({ http }, "https://example.com/first", new Set(["example.com"]))
        expect(src.url).toBe("https://example.com/first")
        expect(requested.length).toBe(before + 1)
      })
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Disable-mid-run: hooks stop firing, no residue, clean typed error
// ---------------------------------------------------------------------------

describe("M4 disable-mid-run", () => {
  // NOTE (found issue, Track 1 follow-up): the mid-run disable here is at
  // callTool granularity — withActiveCheck guards the host's per-call hook
  // dispatch, so a disable landing between beforeToolCall and afterToolCall
  // stops the trailing hook. A disable landing mid-`runTurn` does NOT stop
  // that turn's remaining dispatches: withActiveCheck wraps the dispatcher's
  // entry points, but makeModuleHooks' inner turn sequence calls the raw
  // dispatchers directly. Track 1's disable-mid-run test only covers
  // post-disable refusal (requireActive), never true in-flight cessation.
  it("stops hook dispatch mid-call, cleans the runtime registry, refuses cleanly", async () => {
    await withM4World(({ host, tool, counts }) =>
      Effect.gen(function* () {
        // Disable MID-CALL: the disable lands after beforeToolCall fired but
        // before the tool finished — the trailing afterToolCall must not fire.
        const report = yield* host.callTool(
          RESEARCH_MODULE,
          researchToolCall("m4t3:call:0", researchArgs("test query", "m4s3", "m4t3")),
          Effect.andThen(
            host.disable(RESEARCH_MODULE),
            tool.invoke(researchArgs("test query", "m4s3", "m4t3"))
          )
        )

        // The research itself completed (in-flight execution is not killed;
        // only hook dispatch stops) — 2 of 3 fixtures fetched.
        expect(report.fetchedCount).toBe(2)
        // Counter-proven: beforeToolCall fired (pre-disable); afterToolCall
        // was refused by the in-flight guard (post-disable) — the module's
        // hooks stopped firing mid-run.
        expect(counts.beforeToolCall).toBe(1)
        expect(counts.afterToolCall).toBe(0)
        expect(counts.seenTools).toEqual([RESEARCH_QUERY_TOOL])
        // Runtime registry cleaned: no residue.
        expect(yield* host.runtimeModules()).toEqual([])

        // Invoking research.query while disabled -> clean typed ModuleError
        // (not a hang, not a silent no-op).
        const err = yield* Effect.flip(
          host.callTool(
            RESEARCH_MODULE,
            researchToolCall("m4t3:call:1", researchArgs("test query", "m4s3", "m4t3")),
            tool.invoke(researchArgs("test query", "m4s3", "m4t3"))
          )
        )
        expect(err).toBeInstanceOf(ModuleError)
        if (err._tag === "ModuleError") {
          expect(err.reason).toContain("disabled")
        } else {
          throw new Error(`expected ModuleError, got ${err._tag}`)
        }
        // The refused call fired no hooks.
        expect(counts.beforeToolCall).toBe(1)
        expect(counts.afterToolCall).toBe(0)

        // No residue: re-enable + start recovers cleanly and hooks fire again.
        yield* host.enable(RESEARCH_MODULE)
        yield* host.start(RESEARCH_MODULE)
        expect(yield* host.runtimeModules()).toEqual([RESEARCH_MODULE])
        yield* host.callTool(
          RESEARCH_MODULE,
          researchToolCall("m4t3:call:2", researchArgs("test query", "m4s3", "m4t3")),
          tool.invoke(researchArgs("test query", "m4s3", "m4t3"))
        )
        expect(counts.beforeToolCall).toBe(2)
        expect(counts.afterToolCall).toBe(1)
      })
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Badge correctness, asserted through the HonestyService API
// ---------------------------------------------------------------------------

describe("M4 badge correctness", () => {
  it("badges sourced claims verified (evidence listed) and unsourced claims unverified", async () => {
    await withM4World(({ honesty }) =>
      Effect.gen(function* () {
        // Sourced claim: one "source" evidence record -> verified.
        const sourced = yield* honesty.recordClaim({
          sessionId: "m4s4",
          turnId: "m4t4",
          text: "The sky is blue.",
          kind: "factual"
        })
        const attached = yield* honesty.attachEvidence(sourced.claimId, {
          kind: "source",
          ref: "https://example.com/sky",
          summary: "sky color report"
        })
        const badge = yield* honesty.getBadge(sourced.claimId)
        expect(badge.status).toBe("verified")
        expect(badge.evidence).toHaveLength(1)
        expect(badge.evidence[0]?.ref).toBe("https://example.com/sky")
        const listed = yield* honesty.evidenceFor(sourced.claimId)
        expect(listed.map((e) => e.evidenceId)).toEqual([attached.evidenceId])

        // Unsourced synthesis claim: recorded with NO evidence ->
        // unverified, structurally (no code path can mint "verified" here).
        const unsourced = yield* honesty.recordClaim({
          sessionId: "m4s4",
          turnId: "m4t4",
          text: "Synthesis: it seems blue overall.",
          kind: "factual"
        })
        const badge2 = yield* honesty.getBadge(unsourced.claimId)
        expect(badge2.status).toBe("unverified")
        expect(badge2.evidence).toHaveLength(0)
        expect(yield* honesty.evidenceFor(unsourced.claimId)).toHaveLength(0)
      })
    )
  })
})
