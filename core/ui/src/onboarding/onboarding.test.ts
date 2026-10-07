/**
 * onboarding/onboarding.test.ts — the first-run state machine.
 */
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { ApplyInitialConfig } from "./commands.js"
import { Message } from "./messages.js"
import {
  buildInitialConfig,
  initialModel,
  sovereigntyDefaultsSummary,
  SPLASH_DEFAULT_ENDPOINT
} from "./model.js"
import { OnboardingPersistence, OnboardingPersistenceUnwired } from "./seam.js"
import { update } from "./update.js"

const advance = (steps: number) => {
  let model = initialModel()
  for (let i = 0; i < steps; i++) {
    model = update(model, Message.OnboardingAdvanced()).model
  }
  return model
}

describe("onboarding state machine", () => {
  it("walks welcome → identity → endpoint → sovereignty → done", () => {
    expect(advance(0).step).toBe("welcome")
    expect(advance(1).step).toBe("identitySetup")
    expect(advance(2).step).toBe("modelEndpoint")
    expect(advance(3).step).toBe("sovereigntyDefaults")
    // sovereigntyDefaults needs the explicit confirm, not a plain advance
    expect(advance(4).step).toBe("sovereigntyDefaults")
  })

  it("backing up works, but not past welcome or from done", () => {
    const atIdentity = advance(1)
    expect(update(atIdentity, Message.OnboardingBack()).model.step).toBe("welcome")
    expect(update(initialModel(), Message.OnboardingBack()).model.step).toBe("welcome")
  })

  it("display name and endpoint are captured per step", () => {
    const m1 = update(advance(1), Message.OnboardingDisplayNameSet({ displayName: "Kimler" })).model
    expect(m1.displayName).toBe("Kimler")
    const m2 = update(advance(2), Message.OnboardingEndpointSet({ baseUrl: "http://127.0.0.1:11434" })).model
    expect(m2.endpointBaseUrl).toBe("http://127.0.0.1:11434")
  })

  it("skipping lands on done with the preference recorded and no persistence command", () => {
    const result = update(advance(1), Message.OnboardingSkipped())
    expect(result.model.step).toBe("done")
    expect(result.model.skipped).toBe(true)
    expect(result.commands).toBeUndefined()
  })

  it("confirming the sovereignty defaults completes the flow and applies the config", () => {
    const atDefaults = update(
      advance(2),
      Message.OnboardingDisplayNameSet({ displayName: "Kimler" })
    ).model
    const atDefaults2 = update(atDefaults, Message.OnboardingAdvanced()).model
    expect(atDefaults2.step).toBe("sovereigntyDefaults")
    const result = update(atDefaults2, Message.OnboardingSovereigntyConfirmed())
    expect(result.model.step).toBe("done")
    expect(result.model.sovereigntyConfirmed).toBe(true)
    expect(result.commands).toHaveLength(1)
    expect(result.commands?.[0]?.name).toBe("ApplyInitialConfig")
  })

  it("a failed apply records the reason without leaving done", () => {
    const done = update(
      update(advance(3), Message.OnboardingSovereigntyConfirmed()).model,
      Message.OnboardingApplyFailed({ reason: "onboarding:identity:seal-broken" })
    ).model
    expect(done.step).toBe("done")
    expect(done.persistError).toBe("onboarding:identity:seal-broken")
  })
})

describe("initial configuration", () => {
  it("completion produces the initial Model configuration", () => {
    const model = {
      ...initialModel(),
      displayName: "Kimler",
      endpointBaseUrl: "http://127.0.0.1:11434"
    }
    const config = buildInitialConfig(model)
    expect(config.displayName).toBe("Kimler")
    expect(config.endpointBaseUrl).toBe("http://127.0.0.1:11434")
    expect(config.sovereignty.localInference).toBe(true)
    expect(config.sovereignty.telemetry).toBe(false)
    expect(config.sovereignty.optInLedger).toEqual([])
  })

  it("an empty endpoint falls back to the local default", () => {
    const config = buildInitialConfig(initialModel())
    expect(config.endpointBaseUrl).toBe(SPLASH_DEFAULT_ENDPOINT)
    expect(config.displayName).toBeUndefined()
  })

  it("the visible defaults are everything-off-except-local-inference", () => {
    const summary = sovereigntyDefaultsSummary()
    const local = summary.find((r) => r.label === "Local inference")
    expect(local?.state).toBe("on")
    for (const row of summary) {
      if (row.label === "Local inference") continue
      expect(row.state === "off" || row.state === "absent").toBe(true)
    }
    const tts = summary.find((r) => r.label === "Cloud TTS fallback")
    expect(tts?.state).toBe("absent")
  })
})

describe("the onboarding persistence seam", () => {
  it("the unwired persistence fails closed", async () => {
    const config = buildInitialConfig(initialModel())
    const msg = await Effect.runPromise(
      Effect.provide(
        ApplyInitialConfig({ config }).effect,
        Layer.succeed(OnboardingPersistence, OnboardingPersistenceUnwired)
      )
    )
    expect(msg._tag).toBe("OnboardingApplyFailed")
    if (msg._tag === "OnboardingApplyFailed") {
      expect(msg.reason).toBe("onboarding:persistence-not-wired")
    }
  })

  it("a provided persistence yields the applied message", async () => {
    const config = buildInitialConfig(initialModel())
    let applied = false
    const msg = await Effect.runPromise(
      Effect.provide(
        ApplyInitialConfig({ config }).effect,
        Layer.succeed(OnboardingPersistence, {
          apply: (_c) => Effect.sync(() => { applied = true })
        })
      )
    )
    expect(applied).toBe(true)
    expect(msg._tag).toBe("OnboardingConfigApplied")
  })
})
