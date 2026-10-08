/**
 * desktop/test/ipc.test.ts — M10 Track 2: IPC handlers, preload bridge, client.
 *
 * Strategy:
 * - FAKE `DesktopEngine`: scripted `AsyncGenerator` chat streams plus REAL
 *   in-memory `MemoryService`/`ModuleHost` layers (so `export.run` exercises
 *   the real `exportData` path through `engine.run`).
 * - Fake `ipcMain`/`WebContents` pair; the REAL services behind the command
 *   table (in-memory CommsBanner / ASCEngine / JobRunner / LearningTimeline,
 *   file-backed identity+locker under a tmp dir).
 * - The preload is tested against a mocked `electron` module (allowlist both
 *   directions); the renderer client against a fake bridge; plus one
 *   end-to-end run: client → real preload allowlist → fake ipcMain →
 *   handlers → real services.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Context, Effect, Layer, Scope } from "effect"
import { describe, expect, it, vi, type Mock } from "vitest"
import type { IpcMain } from "electron"

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

import type { ChatChunk } from "../../agent-loop/src/index.js"
import { ASCEngine, ASCEngineFullLive, InMemoryMemoryReaderLive } from "../../asc-engine/index.js"
import { CommsBanner, CommsBannerEphemeral } from "../../comms/service.js"
import { createIpcClient } from "../src/ipc/client.js"
import {
  createChatStreams,
  registerIpcWithDeps,
  type IpcWireDeps
} from "../src/ipc/handlers.js"
import { loadSovereigntyStore } from "../src/ipc/sovereignty.js"
import type { MessagingGateway } from "../src/main/messaging.js"
import type { TtsEngine } from "../src/main/tts-engine.js"

/** In-memory TTS engine stub: install flips to ready, server is a no-op. */
const stubTtsEngine = (): TtsEngine => {
  let state: "missing" | "installing" | "ready" | "failed" = "missing"
  let voiceId: string | undefined
  // The stub service is never usable: any synthesis attempt defects loudly.
  const deadService = {
    speak: () => Effect.die(new Error("stub tts engine: no service")),
    voices: () => Effect.die(new Error("stub tts engine: no service")),
    setVoice: () => Effect.die(new Error("stub tts engine: no service")),
    addVoice: () => Effect.die(new Error("stub tts engine: no service")),
    health: () =>
      Effect.succeed({ reachable: false, modelLoaded: false, reason: "stub" as const }),
  }
  return {
    status: () => ({ state }),
    install: async (onProgress) => {
      state = "installing"
      onProgress({ phase: "deps", message: "stub install" })
      state = "ready"
      onProgress({ phase: "done", message: "stub installed" })
    },
    ensureServer: async () => undefined,
    stopServer: () => undefined,
    venvPython: () => "/stub/python",
    activeVoiceId: () => voiceId,
    setActiveVoice: (id: string) => { voiceId = id },
    ttsService: () => Effect.succeed(deadService),
  }
}

/** In-memory messaging stub: the wizard commands without any network. */
const stubMessaging = (): MessagingGateway => {
  let token: string | undefined
  let code: string | undefined
  let paired = false
  let kinds: ReadonlyArray<string> = ["success", "critical"]
  return {
    status: async () => ({
      configured: token !== undefined,
      botUsername: token !== undefined ? "stubbot" : undefined,
      paired,
      forwardingKinds: kinds,
    }),
    validateToken: async (t: string) => {
      if (t === "bad") return { ok: false, error: "Token invalid: bad" }
      token = t
      return { ok: true, botUsername: "stubbot" }
    },
    issueCode: async () => {
      code = "123456"
      return { code, expiresAt: new Date(Date.now() + 300_000).toISOString() }
    },
    checkPairing: async () => ({ paired }),
    getForwarding: async () => ({ kinds }),
    setForwarding: async (k: ReadonlyArray<string>) => {
      kinds = k
    },
    testMessage: async () =>
      token !== undefined && paired ? { ok: true } : { ok: false, error: "not ready" },
    startRuntime: () => undefined,
  }
}
import {
  type AimyBridgeApi,
  type IpcCommand,
  type IpcCommandResult,
  type IpcEvent,
  type WindowAimy
} from "../src/ipc/protocol.js"
import type { DesktopEngine, EngineRequirements } from "../src/main/engine.js"
import { IdentityService, IdentityServiceLive, ensureInstanceId } from "../../identity/identity.js"
import { FileLockerLive, SecretLocker } from "../../identity/locker.js"
import { AlertSink, JobRunner, JobRunnerLive } from "../../jobs/src/runner.js"
import { InMemoryRunHistory } from "../../jobs/src/history.js"
import type { JobAlert } from "../../jobs/src/types.js"
import {
  InMemoryTimelineStore,
  LearningTimeline,
  LearningTimelineLive,
  type LearningEvent,
  type Provenance
} from "../../learning/src/timeline.js"
import { AllowAllGate, MemoryPaths, MemoryService, MemoryServiceLive } from "../../memory/service.js"
import { makeMockHttpClient, HttpClient } from "../../web-retrieval/src/http.js"
import { ModuleHost, makeModuleHost } from "../../module-seam/src/host.js"
import { ModuleLifecycle, ModuleLifecycleLive } from "../../module-seam/src/lifecycle.js"
import { makeModuleHooks } from "../../module-seam/src/hooks.js"
import { allowAllKernel } from "../../module-seam/src/kernel-seam.js"
import { makeBackendSet, makeDirectGate } from "../../module-seam/src/sandbox.js"
import { makeMapSkillStore } from "../../module-seam/src/skill-index.js"
import { stubIdentitySeam } from "../../module-seam/src/instance.js"
import type { AimyPaths } from "../../substrate/config.js"
import { Redacted } from "../../substrate/types.js"

// ── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const waitFor = async (
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8000
): Promise<void> => {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`)
    await sleep(25)
  }
}

const token = (delta: string): ChatChunk => ({ _tag: "Token", delta })

const scriptOf = (
  chunks: ReadonlyArray<ChatChunk>,
  opts?: { readonly throwAfter?: string }
): (() => AsyncGenerator<ChatChunk>) =>
  async function* (): AsyncGenerator<ChatChunk> {
    for (const c of chunks) yield c
    if (opts?.throwAfter !== undefined) throw new Error(opts.throwAfter)
  }

// ── fake engine ─────────────────────────────────────────────────────────────

const buildTestEngineLayer = (
  root: string
): Layer.Layer<MemoryService | ModuleHost | import("../../web-retrieval/src/http.js").HttpClient, never, never> => {
  const memoryLayer = Layer.provide(
    MemoryServiceLive,
    Layer.mergeAll(
      AllowAllGate,
      Layer.succeed(MemoryPaths, {
        sessionsDir: path.join(root, "engine-memory", "sessions"),
        storesDir: path.join(root, "engine-memory", "stores")
      })
    )
  )
  const hostLayer = Layer.provide(
    Layer.effect(
      ModuleHost,
      Effect.map(ModuleLifecycle, (lifecycle) =>
        makeModuleHost({
          lifecycle,
          hooks: makeModuleHooks({ impls: [], kernel: allowAllKernel }),
          kernel: allowAllKernel,
          identity: stubIdentitySeam("ipc-test-instance"),
          backends: makeBackendSet(makeDirectGate(allowAllKernel)),
          platform: "linux",
          skills: [],
          skillStore: makeMapSkillStore(new Map())
        })
      )
    ),
    ModuleLifecycleLive
  )
  return Layer.mergeAll(
    memoryLayer,
    hostLayer,
    // No network in tests: every request fails like a refused connection,
    // so tts.health honestly reports unreachable and voices/setVoice fail.
    makeMockHttpClient(() => Effect.fail(new Error("connection refused") as never))
  )
}

/**
 * Fake engine: scripted chat streams; `run` executes against the REAL
 * in-memory MemoryService/ModuleHost (the only engine-layer services the
 * command table needs). Anything else would fail loudly — the table never
 * asks for it.
 */
const makeFakeEngine = (
  script: () => AsyncGenerator<ChatChunk>,
  engineCtx: Context.Context<MemoryService | ModuleHost | import("../../web-retrieval/src/http.js").HttpClient>
): DesktopEngine => {
  const memory = Context.get(engineCtx, MemoryService)
  const host = Context.get(engineCtx, ModuleHost)
  const http = Context.get(engineCtx, HttpClient)
  return {
    run: <A, E>(effect: Effect.Effect<A, E, EngineRequirements>): Promise<A> =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(MemoryService, memory),
          Effect.provideService(ModuleHost, host),
          Effect.provideService(HttpClient, http)
        ) as Effect.Effect<A, E, never>
      ),
    chatStream: (_sessionId: string, _input: string): AsyncIterable<ChatChunk> => ({
      [Symbol.asyncIterator]: () => script()
    }),
    shutdown: (): Promise<void> => Promise.resolve()
  }
}

// ── fake ipcMain / sender ───────────────────────────────────────────────────

interface FakeSender {
  readonly sent: Array<{ readonly channel: string; readonly evt: unknown }>
  readonly onSend: (hook: (channel: string, evt: unknown) => void) => void
  readonly send: (channel: string, evt: unknown) => void
  readonly isDestroyed: () => boolean
}

const makeFakeSender = (): FakeSender => {
  const sent: Array<{ channel: string; evt: unknown }> = []
  const hooks: Array<(channel: string, evt: unknown) => void> = []
  return {
    sent,
    onSend: (hook) => {
      hooks.push(hook)
    },
    send: (channel, evt) => {
      sent.push({ channel, evt })
      for (const h of [...hooks]) h(channel, evt)
    },
    isDestroyed: () => false
  }
}

interface FakeIpcMain {
  readonly handlers: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>
  readonly handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => void
}

const makeFakeIpcMain = (): FakeIpcMain => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  return {
    handlers,
    handle: (channel, listener) => {
      handlers.set(channel, listener)
    }
  }
}

// ── test service wiring ─────────────────────────────────────────────────────

const buildTestDeps = async (
  engine: DesktopEngine,
  root: string,
  paths: AimyPaths
): Promise<IpcWireDeps> => {
  const instanceId = await Effect.runPromise(ensureInstanceId(paths))
  const lockerLayer = FileLockerLive({
    passphrase: Redacted.make("ipc-test-passphrase"),
    instanceId,
    paths
  })
  const extrasLayer = Layer.mergeAll(
    CommsBannerEphemeral(),
    Layer.provide(ASCEngineFullLive, InMemoryMemoryReaderLive),
    Layer.provideMerge(
      JobRunnerLive,
      Layer.mergeAll(
        Layer.succeed(
          AlertSink,
          AlertSink.of({
            alert: (_a: JobAlert) => Effect.void
          })
        ),
        InMemoryRunHistory
      )
    ),
    Layer.provide(LearningTimelineLive, InMemoryTimelineStore),
    Layer.provide(IdentityServiceLive({ instanceId, paths }), lockerLayer),
    lockerLayer
  )
  const scope = Effect.runSync(Scope.make())
  const ctx = await Effect.runPromise(
    Layer.build(extrasLayer).pipe(Effect.provideService(Scope.Scope, scope))
  )
  return {
    engine,
    chatStreams: createChatStreams(engine),
    comms: Context.get(ctx, CommsBanner),
    asc: Context.get(ctx, ASCEngine),
    jobs: Context.get(ctx, JobRunner),
    timeline: Context.get(ctx, LearningTimeline),
    identity: Context.get(ctx, IdentityService),
    locker: Context.get(ctx, SecretLocker),
    sovereignty: loadSovereigntyStore(path.join(root, "sovereignty.json")),
    messaging: stubMessaging(),
    tts: stubTtsEngine(),
    paths,
    instanceId
  }
}

interface TestSetup {
  readonly engine: DesktopEngine
  readonly deps: IpcWireDeps
  readonly sender: FakeSender
  readonly ipcMain: FakeIpcMain
  readonly invoke: (channel: string, payload: unknown, sender?: FakeSender) => Promise<unknown>
  readonly root: string
}

const setup = async (script: () => AsyncGenerator<ChatChunk>): Promise<TestSetup> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-ipc-test-"))
  const paths: AimyPaths = {
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state")
  }
  const engineScope = Effect.runSync(Scope.make())
  const engineCtx = await Effect.runPromise(
    Layer.build(buildTestEngineLayer(root)).pipe(Effect.provideService(Scope.Scope, engineScope))
  )
  const engine = makeFakeEngine(script, engineCtx)
  const deps = await buildTestDeps(engine, root, paths)
  const ipcMain = makeFakeIpcMain()
  registerIpcWithDeps(ipcMain as unknown as IpcMain, engine, async () => deps)
  const sender = makeFakeSender()
  const invoke = (channel: string, payload: unknown, via?: FakeSender): Promise<unknown> => {
    const handler = ipcMain.handlers.get(channel)
    if (handler === undefined) return Promise.reject(new Error(`no handler for ${channel}`))
    return handler({ sender: via ?? sender }, payload)
  }
  return { engine, deps, sender, ipcMain, invoke, root }
}

const eventsOf = (sender: FakeSender, tag: string): Array<unknown> =>
  sender.sent.filter((s) => (s.evt as { _tag?: unknown })._tag === tag).map((s) => s.evt)

const testProvenance: Provenance = { origin: "review-fork", sessionId: "sess-1", profileId: "default" }

const testLearningEvent = (): LearningEvent => ({
  type: "review-fork.proposed-add",
  provenance: testProvenance,
  subject: "skill.weather",
  evidenceIds: [],
  payload: { store: "skills", summary: "new weather skill" }
})

// ── command round-trips ─────────────────────────────────────────────────────

describe("ipc command round-trips", () => {
  it("every command tag dispatches and returns its protocol response", async () => {
    const homeBefore = process.env.HOME
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "aimy-ipc-home-"))
    process.env.HOME = tmpHome
    try {
      const t = await setup(scriptOf([token("a"), token("b")]))
      const { invoke, deps, sender } = t

      // chat.send → { streamId }; drain the stream through the sender.
      const sendRes = (await invoke("aimy:chat.send", {
        _tag: "chat.send",
        sessionId: "s-roundtrip",
        input: "hello"
      })) as { streamId: string }
      expect(typeof sendRes.streamId).toBe("string")
      await waitFor(
        () => eventsOf(sender, "chat.done").length > 0,
        "chat.done after round-trip send"
      )
      expect(eventsOf(sender, "chat.token").map((e) => (e as { delta: string }).delta)).toEqual([
        "a",
        "b"
      ])

      // A second concurrent stream gets its own id.
      const sendRes2 = (await invoke("aimy:chat.send", {
        _tag: "chat.send",
        sessionId: "s-roundtrip",
        input: "again"
      })) as { streamId: string }
      expect(sendRes2.streamId).not.toBe(sendRes.streamId)
      await waitFor(
        () => deps.chatStreams.activeIds().length === 0,
        "both round-trip streams drained"
      )
      // Cancelling a completed stream is a clean error: terminal state is terminal.
      await expect(
        invoke("aimy:chat.cancel", { _tag: "chat.cancel", streamId: sendRes.streamId })
      ).rejects.toThrow(/unknown chat stream/)

      // banners: publish directly, then list/dismiss through the channel.
      const banner = await Effect.runPromise(
        deps.comms.publish({ severity: "info", source: "system", title: "Hi", body: "there" })
      )
      const listRes = (await invoke("aimy:banners.list", { _tag: "banners.list" })) as {
        banners: Array<{ id: string }>
      }
      expect(listRes.banners.map((b) => b.id)).toContain(banner.id)
      await invoke("aimy:banners.dismiss", { _tag: "banners.dismiss", id: banner.id })
      const listRes2 = (await invoke("aimy:banners.list", { _tag: "banners.list" })) as {
        banners: Array<{ id: string }>
      }
      expect(listRes2.banners.map((b) => b.id)).not.toContain(banner.id)

      // asc: read dials, tune through evidence, dialsUpdated pushed.
      const dials = (await invoke("aimy:asc.readDials", { _tag: "asc.readDials" })) as Record<
        string,
        number
      >
      for (const name of ["warmth", "playfulness", "intensity", "vulnerability"]) {
        expect(typeof dials[name]).toBe("number")
      }
      const tuned = (await invoke("aimy:asc.tune", {
        _tag: "asc.tune",
        dial: "warmth",
        target: 7
      })) as Record<string, number>
      expect(typeof tuned["warmth"]).toBe("number")
      const dialEvents = eventsOf(sender, "asc.dialsUpdated") as Array<{ dials: unknown }>
      expect(dialEvents.length).toBeGreaterThan(0)
      expect(dialEvents[dialEvents.length - 1]!.dials).toEqual(tuned)
      await expect(
        invoke("aimy:asc.tune", { _tag: "asc.tune", dial: "nope", target: 5 })
      ).rejects.toThrow(/unknown ASC dial/)
      await expect(
        invoke("aimy:asc.tune", { _tag: "asc.tune", dial: "warmth", target: 99 })
      ).rejects.toThrow(/out of range/)

      // sovereignty: verified defaults, set, unknown key rejected.
      const sovList = (await invoke("aimy:sovereignty.list", { _tag: "sovereignty.list" })) as {
        toggles: Array<{ key: string; enabled: boolean }>
      }
      const byKey = new Map(sovList.toggles.map((tg) => [tg.key, tg.enabled]))
      expect(byKey.get("localInference")).toBe(true)
      expect(byKey.get("telemetry")).toBe(false)
      await invoke("aimy:sovereignty.set", {
        _tag: "sovereignty.set",
        key: "telemetry",
        value: true
      })
      const sovList2 = (await invoke("aimy:sovereignty.list", { _tag: "sovereignty.list" })) as {
        toggles: Array<{ key: string; enabled: boolean }>
      }
      expect(new Map(sovList2.toggles.map((tg) => [tg.key, tg.enabled])).get("telemetry")).toBe(true)
      await expect(
        invoke("aimy:sovereignty.set", { _tag: "sovereignty.set", key: "evil", value: true })
      ).rejects.toThrow(/unknown sovereignty key/)

      // jobs: schedule directly, list/runNow through the channel.
      await Effect.runPromise(
        deps.jobs.schedule({
          id: "test-job",
          name: "Test job",
          tier: "T1",
          schedule: { _tag: "OneShot", atMs: Date.now() + 3_600_000 },
          restart: { _tag: "Never" },
          notify: "never",
          run: Effect.void
        })
      )
      const jobsRes = (await invoke("aimy:jobs.list", { _tag: "jobs.list" })) as {
        jobs: Array<{ id: string; status: string }>
        statuses: Record<string, string>
      }
      expect(jobsRes.jobs.map((j) => j.id)).toContain("test-job")
      expect(jobsRes.statuses["test-job"]).toBe("enabled")
      await invoke("aimy:jobs.runNow", { _tag: "jobs.runNow", id: "test-job" })
      await expect(
        invoke("aimy:jobs.runNow", { _tag: "jobs.runNow", id: "missing-job" })
      ).rejects.toThrow()

      // timeline: record directly, list through the channel.
      const node = await Effect.runPromise(deps.timeline.recordEvent(testLearningEvent()))
      const timelineRes = (await invoke("aimy:timeline.list", { _tag: "timeline.list" })) as {
        nodes: Array<{ nodeId: string }>
      }
      expect(timelineRes.nodes.map((n) => n.nodeId)).toContain(node.nodeId)

      // export: seed engine memory, run the real export, bundle verifies.
      const engineCtxMemory = deps.engine
      await engineCtxMemory.run(
        Effect.gen(function* () {
          const memory = yield* MemoryService
          yield* memory.set("profile", "name", "Kimler")
        })
      )
      const exportRes = (await invoke("aimy:export.run", { _tag: "export.run" })) as {
        bundlePath: string
      }
      expect(fs.existsSync(path.join(exportRes.bundlePath, "manifest.json"))).toBe(true)
      const profileBundle = path.join(exportRes.bundlePath, "memory", "stores", "profile.json")
      expect(fs.existsSync(profileBundle)).toBe(true)
      expect(fs.readFileSync(profileBundle, "utf8")).toContain("Kimler")

      // config: defaults, then set/get round-trip against a sandboxed HOME.
      const cfg1 = (await invoke("aimy:config.get", { _tag: "config.get" })) as {
        baseUrl: string
        model: string
      }
      expect(cfg1.baseUrl).toBe("http://127.0.0.1:8000")
      await invoke("aimy:config.set", {
        _tag: "config.set",
        baseUrl: "http://127.0.0.1:9000",
        model: "test-model"
      })
      const cfg2 = (await invoke("aimy:config.get", { _tag: "config.get" })) as {
        baseUrl: string
        model: string
      }
      expect(cfg2).toEqual({ baseUrl: "http://127.0.0.1:9000", model: "test-model" })
      expect(fs.existsSync(path.join(tmpHome, ".aimy", "desktop.json"))).toBe(true)
    } finally {
      if (homeBefore === undefined) delete process.env.HOME
      else process.env.HOME = homeBefore
    }
  })

  it("a payload whose _tag does not match the channel is rejected", async () => {
    const t = await setup(scriptOf([]))
    await expect(
      t.invoke("aimy:chat.send", { _tag: "banners.list" })
    ).rejects.toThrow(/rejected payload/)
    await expect(t.invoke("aimy:banners.list", { _tag: "chat.send", sessionId: "s", input: "x" })).rejects.toThrow(
      /rejected payload/
    )
    await expect(t.invoke("aimy:chat.send", null)).rejects.toThrow(/rejected payload/)
  })

  it("unknown chat stream cancel is a clean error", async () => {
    const t = await setup(scriptOf([]))
    await expect(
      t.invoke("aimy:chat.cancel", { _tag: "chat.cancel", streamId: "no-such-stream" })
    ).rejects.toThrow(/unknown chat stream/)
  })
})

describe("messaging wizard commands", () => {
  it("validate → issue code → status → forwarding → test", async () => {
    const t = await setup(scriptOf([]))
    const { invoke } = t

    const status0 = (await invoke("aimy:messaging.status", {
      _tag: "messaging.status"
    })) as { configured: boolean; paired: boolean }
    expect(status0.configured).toBe(false)
    expect(status0.paired).toBe(false)

    const bad = (await invoke("aimy:messaging.validateToken", {
      _tag: "messaging.validateToken",
      token: "bad"
    })) as { ok: boolean; error?: string }
    expect(bad.ok).toBe(false)

    const good = (await invoke("aimy:messaging.validateToken", {
      _tag: "messaging.validateToken",
      token: "good-token"
    })) as { ok: boolean; botUsername?: string }
    expect(good.ok).toBe(true)
    expect(good.botUsername).toBe("stubbot")

    const codeRes = (await invoke("aimy:messaging.issueCode", {
      _tag: "messaging.issueCode"
    })) as { code: string; expiresAt: string }
    expect(codeRes.code).toBe("123456")

    const pairing = (await invoke("aimy:messaging.checkPairing", {
      _tag: "messaging.checkPairing"
    })) as { paired: boolean }
    expect(pairing.paired).toBe(false)

    const fwd0 = (await invoke("aimy:messaging.getForwarding", {
      _tag: "messaging.getForwarding"
    })) as { kinds: ReadonlyArray<string> }
    expect(fwd0.kinds).toContain("critical")
    await invoke("aimy:messaging.setForwarding", {
      _tag: "messaging.setForwarding",
      kinds: ["critical"]
    })
    const fwd1 = (await invoke("aimy:messaging.getForwarding", {
      _tag: "messaging.getForwarding"
    })) as { kinds: ReadonlyArray<string> }
    expect(fwd1.kinds).toEqual(["critical"])

    await expect(
      invoke("aimy:messaging.setForwarding", { _tag: "messaging.setForwarding", kinds: "x" })
    ).rejects.toThrow(/array of strings/)
  })
})

describe("tts commands", () => {
  it("health, voices, setVoice dispatch through the protocol", async () => {
    const t = await setup(scriptOf([]))
    const { invoke } = t
    // No TTS server in tests: health reports unreachable (a result, not a throw).
    const health = (await invoke("aimy:tts.health", { _tag: "tts.health" })) as {
      health: { reachable: boolean }
    }
    expect(health.health.reachable).toBe(false)
    await expect(invoke("aimy:tts.voices", { _tag: "tts.voices" })).rejects.toThrow()
    await expect(
      invoke("aimy:tts.setVoice", { _tag: "tts.setVoice", voiceId: "v1" })
    ).rejects.toThrow()
  })

  it("engineStatus reports missing, installEngine starts the stub install", async () => {
    const t = await setup(scriptOf([]))
    const { invoke } = t
    const before = (await invoke("aimy:tts.engineStatus", { _tag: "tts.engineStatus" })) as {
      state: string
    }
    expect(before.state).toBe("missing")
    const started = (await invoke("aimy:tts.installEngine", { _tag: "tts.installEngine" })) as {
      started: boolean
    }
    expect(started.started).toBe(true)
    // The stub install completes synchronously: engine is ready now.
    const after = (await invoke("aimy:tts.engineStatus", { _tag: "tts.engineStatus" })) as {
      state: string
    }
    expect(after.state).toBe("ready")
    // Second install is a no-op.
    const again = (await invoke("aimy:tts.installEngine", { _tag: "tts.installEngine" })) as {
      started: boolean
    }
    expect(again.started).toBe(false)
  })

  it("addVoice validates its inputs before touching the server", async () => {
    const t = await setup(scriptOf([]))
    const { invoke } = t
    await expect(
      invoke("aimy:tts.addVoice", { _tag: "tts.addVoice", name: "", audioBase64: "eA==" })
    ).rejects.toThrow(/non-empty string/)
    await expect(
      invoke("aimy:tts.addVoice", {
        _tag: "tts.addVoice",
        name: "x".repeat(81),
        audioBase64: "eA==",
      })
    ).rejects.toThrow(/at most 80/)
  })
})

// ── streaming ───────────────────────────────────────────────────────────────

describe("chat streaming", () => {
  it("delivers token deltas in order, then chat.done", async () => {
    const t = await setup(scriptOf([token("Hello, "), token("brave "), token("new world")]))
    const res = (await t.invoke("aimy:chat.send", {
      _tag: "chat.send",
      sessionId: "s1",
      input: "hi"
    })) as { streamId: string }
    await waitFor(
      () => eventsOf(t.sender, "chat.done").length > 0,
      "chat.done for ordered stream"
    )
    const tokens = eventsOf(t.sender, "chat.token") as Array<{
      streamId: string
      delta: string
    }>
    expect(tokens.map((e) => e.delta)).toEqual(["Hello, ", "brave ", "new world"])
    expect(new Set(tokens.map((e) => e.streamId))).toEqual(new Set([res.streamId]))
    const done = eventsOf(t.sender, "chat.done") as Array<{ streamId: string }>
    expect(done[done.length - 1]!.streamId).toBe(res.streamId)
    // done is terminal: it is the last event for the stream.
    const lastIdx = t.sender.sent.length - 1
    expect((t.sender.sent[lastIdx]!.evt as { _tag: string })._tag).toBe("chat.done")
  })

  it("cancel stops delivery and interrupts the engine iterator", async () => {
    let returned = false
    // NOTE: an async generator processes a queued `return()` only when it
    // reaches a yield/return point — so the script must keep yielding (a
    // never-resolving `await` or a yield-free wake loop would deadlock the
    // cancel). Ticks after the first are fine: the test asserts delivery
    // *stops* at cancel time.
    const script = async function* (): AsyncGenerator<ChatChunk> {
      try {
        yield token("first")
        for (;;) {
          await sleep(25)
          yield token("tick")
        }
      } finally {
        returned = true
      }
    }
    const t = await setup(script)
    const res = (await t.invoke("aimy:chat.send", {
      _tag: "chat.send",
      sessionId: "s1",
      input: "hi"
    })) as { streamId: string }
    await waitFor(() => eventsOf(t.sender, "chat.token").length > 0, "first token before cancel")
    await t.invoke("aimy:chat.cancel", { _tag: "chat.cancel", streamId: res.streamId })
    await waitFor(() => returned, "engine iterator return() called")
    await sleep(150) // let the pump settle: no done/error may follow a cancel
    expect(eventsOf(t.sender, "chat.done")).toEqual([])
    expect(eventsOf(t.sender, "chat.error")).toEqual([])
    expect(t.deps.chatStreams.activeIds()).toEqual([])
    const tokens = eventsOf(t.sender, "chat.token") as Array<{ delta: string; streamId: string }>
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens[0]!.delta).toBe("first")
    expect(new Set(tokens.map((e) => e.streamId))).toEqual(new Set([res.streamId]))
    // Delivery truly stopped: the count is stable after the cancel settled.
    await sleep(150)
    expect(eventsOf(t.sender, "chat.token").length).toBe(tokens.length)
  })

  it("stream failures surface as chat.error with a clean message", async () => {
    const t = await setup(scriptOf([token("partial")], { throwAfter: "synthetic stream failure" }))
    const res = (await t.invoke("aimy:chat.send", {
      _tag: "chat.send",
      sessionId: "s1",
      input: "hi"
    })) as { streamId: string }
    await waitFor(
      () => eventsOf(t.sender, "chat.error").length > 0,
      "chat.error for failed stream"
    )
    const errors = eventsOf(t.sender, "chat.error") as Array<{
      streamId: string
      error: string
    }>
    expect(errors.length).toBe(1)
    expect(errors[0]!.streamId).toBe(res.streamId)
    expect(errors[0]!.error).toBe("synthetic stream failure")
    expect(errors[0]!.error).not.toContain("at ")
    expect(eventsOf(t.sender, "chat.done")).toEqual([])
  })
})

// ── banner forwarding ───────────────────────────────────────────────────────

describe("banner.published forwarding", () => {
  it("published banners are pushed to every live renderer", async () => {
    const t = await setup(scriptOf([]))
    const secondSender = makeFakeSender()
    // Both renderers invoke once, registering their webContents for broadcasts.
    await t.invoke("aimy:banners.list", { _tag: "banners.list" })
    await t.invoke("aimy:banners.list", { _tag: "banners.list" }, secondSender)
    const seenBy = (sender: FakeSender, id: string): boolean =>
      sender.sent.some(
        (s) =>
          (s.evt as { _tag?: string })._tag === "banner.published" &&
          (s.evt as { banner?: { id?: string } }).banner?.id === id
      )
    // The forwarding subscription starts asynchronously after registration;
    // re-publish until it is live (each attempt uses a fresh title).
    await waitFor(
      async () => {
        const b = await Effect.runPromise(
          t.deps.comms.publish({
            severity: "info",
            source: "system",
            title: `ping-${Date.now()}-${Math.random()}`,
            body: "ping"
          })
        )
        await sleep(50)
        return seenBy(t.sender, b.id) && seenBy(secondSender, b.id)
      },
      "banner.published forwarded to both renderers"
    )
  })
})

// ── preload bridge ──────────────────────────────────────────────────────────

const mockedElectron = async (): Promise<{
  contextBridge: { exposeInMainWorld: Mock }
  ipcRenderer: { invoke: Mock; on: Mock; removeListener: Mock }
}> =>
  (await import("electron")) as unknown as {
    contextBridge: { exposeInMainWorld: Mock }
    ipcRenderer: { invoke: Mock; on: Mock; removeListener: Mock }
  }

let cachedPreloadApi: AimyBridgeApi | undefined
const getPreloadApi = async (): Promise<AimyBridgeApi> => {
  if (cachedPreloadApi === undefined) {
    await import("../src/preload.js")
    const { contextBridge } = await mockedElectron()
    const calls = contextBridge.exposeInMainWorld.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]![0]).toBe("aimy")
    cachedPreloadApi = calls[0]![1] as AimyBridgeApi
  }
  return cachedPreloadApi
}

describe("preload bridge", () => {
  it("exposes exactly the window.aimy API and nothing else", async () => {
    const api = await getPreloadApi()
    expect(Object.keys(api).sort()).toEqual(["invoke", "subscribe"])
  })

  it("invoke allowlist blocks a forged command tag before touching ipcRenderer", async () => {
    const api = await getPreloadApi()
    const { ipcRenderer } = await mockedElectron()
    ipcRenderer.invoke.mockClear()
    await expect(api.invoke({ _tag: "definitely-not-a-command" } as never)).rejects.toThrow(
      /unknown command tag/
    )
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it("invoke allowlist passes valid tags to aimy:<tag>", async () => {
    const api = await getPreloadApi()
    const { ipcRenderer } = await mockedElectron()
    ipcRenderer.invoke.mockImplementation(async (channel: string, payload: unknown) => ({
      channel,
      payload
    }))
    const cmd = { _tag: "chat.send", sessionId: "s", input: "hi" } as const
    await api.invoke(cmd)
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("aimy:chat.send", cmd)
  })

  it("event allowlist drops forged events before the renderer handler", async () => {
    const api = await getPreloadApi()
    const { ipcRenderer } = await mockedElectron()
    const seen: Array<IpcEvent> = []
    const unsubscribe = api.subscribe((evt) => {
      seen.push(evt)
    })
    const onCalls = ipcRenderer.on.mock.calls
    expect(onCalls.length).toBeGreaterThan(0)
    const listener = onCalls[onCalls.length - 1]![1] as (event: unknown, evt: unknown) => void
    listener({}, { _tag: "forged-evil", payload: "x" })
    listener({}, null)
    listener({}, "not-an-object")
    listener({}, { _tag: "chat.token", streamId: "s", delta: "d" })
    expect(seen).toEqual([{ _tag: "chat.token", streamId: "s", delta: "d" }])
    unsubscribe()
    expect(ipcRenderer.removeListener).toHaveBeenCalled()
  })
})

// ── renderer client ─────────────────────────────────────────────────────────

describe("renderer client", () => {
  const makeFakeBridge = (): {
    bridge: WindowAimy
    invoked: Array<IpcCommand>
    issued: Array<string>
    emit: (evt: IpcEvent) => void
    subscriberCount: () => number
  } => {
    const subscribers = new Set<(evt: IpcEvent) => void>()
    const invoked: Array<IpcCommand> = []
    const issued: Array<string> = []
    let seq = 0
    const bridge: WindowAimy = {
      aimy: {
        invoke: (<C extends IpcCommand>(cmd: C): Promise<IpcCommandResult<C>> => {
          invoked.push(cmd)
          if (cmd._tag === "chat.send") {
            const streamId = `stream-${++seq}`
            issued.push(streamId)
            return Promise.resolve({ streamId }) as unknown as Promise<IpcCommandResult<C>>
          }
          if (cmd._tag === "chat.cancel") {
            return Promise.resolve(undefined) as unknown as Promise<IpcCommandResult<C>>
          }
          return Promise.reject(new Error(`unexpected command ${cmd._tag}`))
        }),
        subscribe: (handler: (evt: IpcEvent) => void): (() => void) => {
          subscribers.add(handler)
          return () => {
            subscribers.delete(handler)
          }
        }
      }
    }
    return {
      bridge,
      invoked,
      issued,
      emit: (evt) => {
        for (const h of [...subscribers]) h(evt)
      },
      subscriberCount: () => subscribers.size
    }
  }

  it("chatStream yields deltas in order, ignores other streams, resolves on done", async () => {
    const fake = makeFakeBridge()
    const client = createIpcClient(fake.bridge)
    const stream = client.chatStream("s1", "hello")
    const collected: Array<string> = []
    const finished = (async (): Promise<void> => {
      for await (const delta of stream) collected.push(delta)
    })()
    await waitFor(
      () => fake.invoked.some((c) => c._tag === "chat.send"),
      "chat.send invoked"
    )
    const streamId = fake.issued[0]!
    fake.emit({ _tag: "chat.token", streamId: "someone-else", delta: "ignored" })
    fake.emit({ _tag: "chat.token", streamId, delta: "a" })
    fake.emit({ _tag: "chat.token", streamId, delta: "b" })
    fake.emit({ _tag: "chat.done", streamId })
    await finished
    expect(collected).toEqual(["a", "b"])
    expect(fake.subscriberCount()).toBe(0)
  })

  it("chatStream throws the clean message on chat.error", async () => {
    const fake = makeFakeBridge()
    const client = createIpcClient(fake.bridge)
    const stream = client.chatStream("s1", "hello")
    const finished = (async (): Promise<void> => {
      for await (const _delta of stream) {
        // drain
      }
    })()
    await waitFor(
      () => fake.invoked.some((c) => c._tag === "chat.send"),
      "chat.send invoked"
    )
    fake.emit({ _tag: "chat.error", streamId: fake.issued[0]!, error: "boom" })
    await expect(finished).rejects.toThrow("boom")
  })

  it("cancel() sends chat.cancel, ends iteration, and unsubscribes", async () => {
    const fake = makeFakeBridge()
    const client = createIpcClient(fake.bridge)
    const stream = client.chatStream("s1", "hello")
    const collected: Array<string> = []
    const finished = (async (): Promise<void> => {
      for await (const delta of stream) collected.push(delta)
    })()
    await waitFor(
      () => fake.invoked.some((c) => c._tag === "chat.send"),
      "chat.send invoked"
    )
    const streamId = fake.issued[0]!
    stream.cancel()
    await finished
    expect(collected).toEqual([])
    const cancels = fake.invoked.filter((c) => c._tag === "chat.cancel") as Array<{
      _tag: "chat.cancel"
      streamId: string
    }>
    expect(cancels.map((c) => c.streamId)).toEqual([streamId])
    expect(fake.subscriberCount()).toBe(0)
  })

  it("cancel() before chat.send resolves still cancels once the stream exists", async () => {
    const fake = makeFakeBridge()
    const client = createIpcClient(fake.bridge)
    const stream = client.chatStream("s1", "hello")
    stream.cancel()
    await waitFor(
      () => fake.invoked.some((c) => c._tag === "chat.cancel"),
      "deferred chat.cancel sent"
    )
    const collected: Array<string> = []
    for await (const delta of stream) collected.push(delta)
    expect(collected).toEqual([])
  })
})

// ── end-to-end: client → preload → handlers ─────────────────────────────────

describe("end-to-end through the real preload allowlist", () => {
  it("typed round-trip plus streaming across the whole bridge", async () => {
    const t = await setup(scriptOf([token("Hello, "), token("world")]))
    const { ipcRenderer } = await mockedElectron()
    const rendererListeners: Array<(event: unknown, evt: unknown) => void> = []
    // Main → renderer: sender.send routes into the preload's "aimy:event" listener.
    t.sender.onSend((channel, evt) => {
      if (channel === "aimy:event") {
        for (const l of [...rendererListeners]) l({}, evt)
      }
    })
    // Renderer → main: ipcRenderer.invoke routes into the fake ipcMain.
    ipcRenderer.invoke.mockImplementation(async (channel: string, payload: unknown) => {
      const handler = t.ipcMain.handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return handler({ sender: t.sender }, payload)
    })
    ipcRenderer.on.mockImplementation(
      (channel: string, listener: (event: unknown, evt: unknown) => void) => {
        if (channel === "aimy:event") rendererListeners.push(listener)
      }
    )

    const api = await getPreloadApi()
    const client = createIpcClient({ aimy: api })

    // Typed invoke round-trip: client → preload allowlist → handlers → real CommsBanner.
    const listRes = await client.invoke({ _tag: "banners.list" })
    expect(listRes.banners).toEqual([])

    // A forged tag is blocked by the preload — it never reaches the main side.
    await expect(client.invoke({ _tag: "definitely-not-a-command" } as never)).rejects.toThrow(
      /unknown command tag/
    )
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith(
      "aimy:definitely-not-a-command",
      expect.anything()
    )

    // Chat streaming end-to-end: tokens flow main → sender → preload → client.
    const stream = client.chatStream("s-e2e", "hello")
    const deltas: Array<string> = []
    const drained = (async (): Promise<void> => {
      for await (const delta of stream) deltas.push(delta)
    })()
    await drained
    expect(deltas).toEqual(["Hello, ", "world"])
  })
})

// ── sovereignty store ───────────────────────────────────────────────────────

describe("sovereignty store", () => {
  it("defaults to everything-off-except-local-inference", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimy-sov-")), "sov.json")
    const store = loadSovereigntyStore(file)
    const byKey = new Map(store.list().map((tg) => [tg.key, tg.enabled]))
    expect(byKey.get("localInference")).toBe(true)
    for (const key of ["offlineMode", "updateChecks", "trustedBroadcast", "telemetry", "lanDiscoverability"]) {
      expect(byKey.get(key)).toBe(false)
    }
  })

  it("persists toggles across loads, including per-item keys", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimy-sov-")), "sov.json")
    const store = loadSovereigntyStore(file)
    store.set("telemetry", true)
    store.set("webRetrieval:web-retrieval", true)
    const reloaded = loadSovereigntyStore(file)
    const byKey = new Map(reloaded.list().map((tg) => [tg.key, tg.enabled]))
    expect(byKey.get("telemetry")).toBe(true)
    expect(byKey.get("webRetrieval:web-retrieval")).toBe(true)
    expect(byKey.get("localInference")).toBe(true)
  })

  it("rejects unknown keys and non-boolean values", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimy-sov-")), "sov.json")
    const store = loadSovereigntyStore(file)
    expect(() => store.set("evil", true)).toThrow(/unknown sovereignty key/)
    expect(() => store.set("telemetry", "yes" as unknown as boolean)).toThrow(/must be a boolean/)
    expect(() => store.set("webRetrieval:", true)).toThrow(/unknown sovereignty key/)
  })

  it("a corrupt file degrades to defaults instead of throwing", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aimy-sov-")), "sov.json")
    fs.writeFileSync(file, "not json{{{")
    const store = loadSovereigntyStore(file)
    expect(new Map(store.list().map((tg) => [tg.key, tg.enabled])).get("localInference")).toBe(true)
  })
})
