/** Lifecycle state machine: transitions, staged updates, trust, rollback, archive-on-remove. */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  ModuleError,
  ModuleLifecycle,
  ModuleLifecycleLive,
  TrustDecisionRequired,
  diffCapabilities
} from "../src/index.js"
import { testManifest } from "./fixtures.js"

const withLifecycle = <A, E>(program: (lc: ModuleLifecycle["Service"]) => Effect.Effect<A, E>) =>
  Effect.provide(
    Effect.gen(function* () {
      const lc = yield* ModuleLifecycle
      return yield* program(lc)
    }),
    ModuleLifecycleLive
  )

const installWebResearch = (lc: ModuleLifecycle["Service"]) =>
  lc.install({
    moduleId: "web-research",
    name: "web-research",
    version: "1.0.0",
    manifest: testManifest({ tools: ["web_fetch", "web_search"] }),
    artifacts: { memoryEntries: ["mem-1", "mem-2"], skillEntries: ["skill-1"] }
  })

describe("ModuleLifecycle", () => {
  it.effect("install -> enable -> start -> stop -> disable", () =>
    withLifecycle((lc) =>
      Effect.gen(function* () {
        yield* installWebResearch(lc)
        expect((yield* lc.transition("web-research", { _tag: "Enable" })).state).toBe("enabled")
        expect((yield* lc.transition("web-research", { _tag: "Start" })).state).toBe("running")
        expect((yield* lc.transition("web-research", { _tag: "Stop" })).state).toBe("enabled")
        expect((yield* lc.transition("web-research", { _tag: "Disable" })).state).toBe("disabled")
        expect((yield* lc.get("web-research")).state).toBe("disabled")
      })
    )
  )

  it.effect("invalid transitions fail typed and leave state untouched", () =>
    withLifecycle((lc) =>
      Effect.gen(function* () {
        yield* installWebResearch(lc)
        const err = yield* Effect.flip(lc.transition("web-research", { _tag: "Start" }))
        expect(err).toBeInstanceOf(ModuleError)
        expect((err as ModuleError).module).toBe("web-research")
        expect((yield* lc.get("web-research")).state).toBe("installed")
        // The failed attempt is recorded in the outcome log, separate from state.
        const outcomes = yield* lc.outcomes()
        const failed = outcomes.filter((o) => o.result === "failed")
        expect(failed.length).toBe(1)
        expect(failed[0]?.transition).toBe("Start")
        expect(failed[0]?.from).toBe("installed")
        expect(failed[0]?.to).toBe("installed")
      })
    )
  )

  it.effect("outcome records are separate from lifecycle state", () =>
    withLifecycle((lc) =>
      Effect.gen(function* () {
        yield* installWebResearch(lc)
        yield* lc.transition("web-research", { _tag: "Enable" })
        yield* lc.transition("web-research", { _tag: "Start" })
        const outcomes = yield* lc.outcomes()
        expect(outcomes.map((o) => o.transition)).toEqual(["Install", "Enable", "Start"])
        expect(outcomes.every((o) => o.result === "ok")).toBe(true)
        const record = yield* lc.get("web-research")
        // State carries no history; history carries no state.
        expect(record.state).toBe("running")
        expect("outcomes" in record).toBe(false)
      })
    )
  )

  it.effect("manifest narrowing on update is free (no trust decision needed)", () =>
    withLifecycle((lc) =>
      Effect.gen(function* () {
        yield* installWebResearch(lc)
        yield* lc.transition("web-research", { _tag: "Enable" })
        const narrow = testManifest({ tools: ["web_fetch"] }) // drops web_search
        yield* lc.transition("web-research", { _tag: "StageUpdate", version: "2.0.0", manifest: narrow })
        expect((yield* lc.get("web-research")).state).toBe("updating")
        const activated = yield* lc.transition("web-research", { _tag: "ActivateUpdate" })
        expect(activated.version).toBe("2.0.0")
        expect(activated.manifest.tools).toEqual(["web_fetch"])
        expect(activated.state).toBe("enabled") // resumed prior state
      })
    )
  )

  it.effect("manifest widening on update re-prompts: trust decision required", () =>
    withLifecycle((lc) =>
      Effect.gen(function* () {
        yield* installWebResearch(lc)
        yield* lc.transition("web-research", { _tag: "Enable" })
        const wide = testManifest({ tools: ["web_fetch", "web_search", "code_exec"], subprocess: true })
        yield* lc.transition("web-research", { _tag: "StageUpdate", version: "2.0.0", manifest: wide })

        const diff = diffCapabilities(testManifest({ tools: ["web_fetch", "web_search"] }), wide)
        expect(diff.widened).toContain("tool:+code_exec")
        expect(diff.widened).toContain("subprocess:off->on")

        // No trust: activation refused, staged update kept.
        const err = yield* Effect.flip(lc.transition("web-research", { _tag: "ActivateUpdate" }))
        expect(err).toBeInstanceOf(TrustDecisionRequired)
        expect((err as TrustDecisionRequired).widened).toEqual(diff.widened)
        expect((yield* lc.get("web-research")).state).toBe("updating")
        expect((yield* lc.get("web-research")).version).toBe("1.0.0")

        // Trust covering exactly the widened set: activation proceeds.
        const activated = yield* lc.transition("web-research", {
          _tag: "ActivateUpdate",
          trust: { decidedAt: Date.now(), widened: diff.widened, approved: true }
        })
        expect(activated.version).toBe("2.0.0")
        expect(activated.previous?.version).toBe("1.0.0")

        // Trust covering the WRONG set is rejected: v3 widens further.
        const wider = testManifest({
          tools: ["web_fetch", "web_search", "code_exec", "net_sniff"],
          subprocess: true
        })
        yield* lc.transition("web-research", { _tag: "StageUpdate", version: "3.0.0", manifest: wider })
        const err2 = yield* Effect.flip(
          lc.transition("web-research", {
            _tag: "ActivateUpdate",
            trust: { decidedAt: Date.now(), widened: ["tool:+code_exec"], approved: true }
          })
        )
        expect(err2).toBeInstanceOf(TrustDecisionRequired)
        expect((err2 as TrustDecisionRequired).widened).toEqual(["tool:+net_sniff"])
        expect((yield* lc.get("web-research")).version).toBe("2.0.0") // still staged, not activated
      })
    )
  )

  it.effect("rollback restores the previous version", () =>
    withLifecycle((lc) =>
      Effect.gen(function* () {
        yield* installWebResearch(lc)
        yield* lc.transition("web-research", { _tag: "Enable" })
        const v2 = testManifest({ tools: ["web_fetch"] })
        yield* lc.transition("web-research", { _tag: "StageUpdate", version: "2.0.0", manifest: v2 })
        yield* lc.transition("web-research", { _tag: "ActivateUpdate" })
        expect((yield* lc.get("web-research")).version).toBe("2.0.0")
        // One-click rollback.
        const rolled = yield* lc.transition("web-research", { _tag: "Rollback" })
        expect(rolled.version).toBe("1.0.0")
        expect(rolled.manifest.tools).toEqual(["web_fetch", "web_search"])
        expect(rolled.state).toBe("enabled")
      })
    )
  )

  it.effect("removal archives module-created entries, never deletes them", () =>
    withLifecycle((lc) =>
      Effect.gen(function* () {
        yield* installWebResearch(lc)
        yield* lc.transition("web-research", { _tag: "Enable" })
        const archive = yield* lc.remove("web-research")
        expect(archive.moduleId).toBe("web-research")
        expect(archive.archivedMemoryEntries).toEqual(["mem-1", "mem-2"])
        expect(archive.archivedSkillEntries).toEqual(["skill-1"])
        expect((yield* lc.get("web-research")).state).toBe("removed")
        const outcomes = yield* lc.outcomes()
        expect(outcomes.at(-1)?.transition).toBe("Remove")
        expect(outcomes.at(-1)?.result).toBe("ok")
      })
    )
  )
})
