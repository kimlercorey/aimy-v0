/**
 * sovereignty/sovereignty.test.ts — the toggles panel's MUST behaviors.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { interruptEgressFor, NetworkEgress } from "./commands.js"
import { interpretEgress, snapshotOf, type ToggleSnapshot } from "./interpreter.js"
import { initialModel, INVENTORY } from "./model.js"
import { Message } from "./messages.js"
import { update } from "./update.js"

const AT = "2026-10-07T07:00:00.000Z"

const snapshotWith = (overrides: Partial<ToggleSnapshot>): ToggleSnapshot => ({
  offlineMode: false,
  localInference: true,
  cloudEndpoints: [{ id: "cloud-endpoint-1", enabled: false }],
  webRetrieval: [{ moduleId: "web-retrieval", enabled: false }],
  updateChecks: false,
  trustedBroadcast: false,
  telemetry: false,
  lanDiscoverability: false,
  pairSyncScopes: [],
  ...overrides
})

const runDecision = (snapshot: ToggleSnapshot, classId: string, targetId?: string, host = "example.com") =>
  Effect.runPromise(interpretEgress(snapshot, { classId, targetId, host }))

describe("sovereignty defaults", () => {
  it("everything is off except local inference", () => {
    const model = initialModel()
    expect(model.localInference).toBe(true)
    expect(model.offlineMode).toBe(false)
    expect(model.updateChecks).toBe(false)
    expect(model.trustedBroadcast).toBe(false)
    expect(model.telemetry).toBe(false)
    expect(model.lanDiscoverability).toBe(false)
    expect(model.cloudEndpoints.every((e) => !e.enabled)).toBe(true)
    expect(model.webRetrieval.every((m) => !m.enabled)).toBe(true)
    expect(model.pairSyncScopes).toEqual([])
    expect(model.optInLedger).toEqual([])
  })

  it("the inventory covers every §3.6 intent class, including the cloud-TTS absence", () => {
    const kinds = new Set(INVENTORY.map((r) => r.classId))
    for (const id of [
      "localInference",
      "cloudEndpoint",
      "webRetrieval",
      "updateChecks",
      "trustedBroadcast",
      "telemetry",
      "cloudTts",
      "lanDiscovery",
      "pairSync"
    ]) {
      expect(kinds.has(id)).toBe(true)
    }
    const tts = INVENTORY.find((r) => r.classId === "cloudTts")
    expect(tts?.kind).toBe("absent")
    for (const row of INVENTORY) {
      expect(row.statedDataFlow.length).toBeGreaterThan(0)
    }
  })
})

describe("toggle flips and the opt-in ledger", () => {
  it("requesting a flip emits the StampTime command (the view cannot stamp time)", () => {
    const result = update(initialModel(), Message.ToggleFlipRequested({ classId: "telemetry", enabled: true }))
    expect(result.commands).toHaveLength(1)
    expect(result.commands?.[0]?.name).toBe("StampTime")
    expect(result.model.telemetry).toBe(false)
  })

  it("a stamped flip turns the toggle on and appends a ledger entry with the stated data flow", () => {
    const result = update(
      initialModel(),
      Message.ToggleFlipStamped({ classId: "telemetry", enabled: true, at: AT })
    )
    expect(result.model.telemetry).toBe(true)
    expect(result.model.optInLedger).toHaveLength(1)
    const entry = result.model.optInLedger[0]
    expect(entry?.grantedAt).toBe(AT)
    expect(entry?.revokedAt).toBeUndefined()
    expect(entry?.statedDataFlow).toContain("nothing")
    expect(result.commands).toBeUndefined()
  })

  it("flipping a toggle off revokes the open ledger entry and interrupts in-flight egress", () => {
    const on = update(
      initialModel(),
      Message.ToggleFlipStamped({ classId: "updateChecks", enabled: true, at: AT })
    ).model
    const result = update(
      on,
      Message.ToggleFlipStamped({ classId: "updateChecks", enabled: false, at: "2026-10-07T08:00:00.000Z" })
    )
    expect(result.model.updateChecks).toBe(false)
    expect(result.model.optInLedger[0]?.revokedAt).toBe("2026-10-07T08:00:00.000Z")
    expect(result.commands).toHaveLength(1)
    const interrupt = result.commands?.[0]
    expect(interrupt?.name).toBe("NetworkEgress.Interrupt")
    expect((interrupt as { interruptsKey?: string }).interruptsKey).toBe("NetworkEgress:egress:updateChecks")
  })

  it("an interrupted in-flight egress is recorded once", () => {
    const model = initialModel()
    const once = update(model, Message.EgressInterruptCompleted({ classId: "webRetrieval", outcome: "Interrupted" })).model
    expect(once.inflightCancelled).toEqual(["webRetrieval"])
    const twice = update(once, Message.EgressInterruptCompleted({ classId: "webRetrieval", outcome: "Interrupted" })).model
    expect(twice.inflightCancelled).toEqual(["webRetrieval"])
    const notFound = update(model, Message.EgressInterruptCompleted({ classId: "webRetrieval", outcome: "NotFound" })).model
    expect(notFound.inflightCancelled).toEqual([])
  })

  it("per-endpoint flips target the right endpoint and ledger key", () => {
    const result = update(
      initialModel(),
      Message.ToggleFlipStamped({ classId: "cloudEndpoint", targetId: "cloud-endpoint-1", enabled: true, at: AT })
    )
    expect(result.model.cloudEndpoints[0]?.enabled).toBe(true)
    expect(result.model.optInLedger[0]?.classId).toBe("cloudEndpoint:cloud-endpoint-1")
  })

  it("offline mode interrupts every vendor-network class and leaves LAN toggles alone", () => {
    const result = update(initialModel(), Message.OfflineModeStamped({ enabled: true, at: AT }))
    expect(result.model.offlineMode).toBe(true)
    const keys = (result.commands ?? []).map(
      (c) => (c as { interruptsKey?: string }).interruptsKey
    )
    expect(keys).toEqual([
      "NetworkEgress:egress:cloudEndpoint",
      "NetworkEgress:egress:webRetrieval",
      "NetworkEgress:egress:updateChecks",
      "NetworkEgress:egress:trustedBroadcast",
      "NetworkEgress:egress:telemetry"
    ])
    expect(result.model.lanDiscoverability).toBe(false)
  })
})

describe("the egress boundary interpreter", () => {
  it("denies everything not opted in (fail-closed defaults)", async () => {
    const snapshot = snapshotWith({})
    for (const [classId, targetId] of [
      ["cloudEndpoint", "cloud-endpoint-1"],
      ["webRetrieval", "web-retrieval"],
      ["updateChecks", undefined],
      ["trustedBroadcast", undefined],
      ["telemetry", undefined],
      ["lanDiscovery", undefined]
    ] as const) {
      const decision = await runDecision(snapshot, classId, targetId)
      expect(decision._tag).toBe("Denied")
    }
    expect((await runDecision(snapshot, "localInference"))._tag).toBe("Allowed")
  })

  it("allows an opted-in endpoint and denies the others", async () => {
    const snapshot = snapshotWith({
      cloudEndpoints: [
        { id: "cloud-endpoint-1", enabled: true },
        { id: "cloud-endpoint-2", enabled: false }
      ]
    })
    expect((await runDecision(snapshot, "cloudEndpoint", "cloud-endpoint-1"))._tag).toBe("Allowed")
    const denied = await runDecision(snapshot, "cloudEndpoint", "cloud-endpoint-2")
    expect(denied._tag).toBe("Denied")
    if (denied._tag === "Denied") expect(denied.reason).toContain("not opted in")
  })

  it("denies unknown classes, endpoints, and modules — never a silent allow", async () => {
    const snapshot = snapshotWith({})
    for (const [classId, targetId] of [
      ["totallyBogus", undefined],
      ["cloudEndpoint", "evil-endpoint"],
      ["webRetrieval", "evil-module"],
      ["pairSync", "stranger"]
    ] as const) {
      const decision = await runDecision(snapshot, classId, targetId)
      expect(decision._tag).toBe("Denied")
      if (decision._tag === "Denied") expect(decision.reason).toContain("fail-closed")
    }
  })

  it("offline mode denies vendor-network classes even when opted in, but not LAN", async () => {
    const snapshot = snapshotWith({
      offlineMode: true,
      cloudEndpoints: [{ id: "cloud-endpoint-1", enabled: true }],
      telemetry: true,
      lanDiscoverability: true
    })
    expect((await runDecision(snapshot, "cloudEndpoint", "cloud-endpoint-1"))._tag).toBe("Denied")
    expect((await runDecision(snapshot, "telemetry"))._tag).toBe("Denied")
    expect((await runDecision(snapshot, "localInference"))._tag).toBe("Allowed")
    expect((await runDecision(snapshot, "lanDiscovery"))._tag).toBe("Allowed")
  })

  it("snapshotOf freezes the model's toggles for the boundary", () => {
    const snapshot = snapshotOf(initialModel())
    expect(snapshot.localInference).toBe(true)
    expect(snapshot.telemetry).toBe(false)
    expect(snapshot.cloudEndpoints[0]?.enabled).toBe(false)
  })

  it("the NetworkEgress command's Effect enforces the snapshot (interpreter logic, run)", async () => {
    const deniedCmd = NetworkEgress({
      classId: "telemetry",
      host: "telemetry.vendor.example",
      snapshot: snapshotWith({})
    })
    const deniedMsg = await Effect.runPromise(deniedCmd.effect)
    expect(deniedMsg._tag).toBe("EgressDenied")
    if (deniedMsg._tag === "EgressDenied") expect(deniedMsg.reason).toContain("telemetry is off")

    const allowedCmd = NetworkEgress({
      classId: "telemetry",
      host: "telemetry.vendor.example",
      snapshot: snapshotWith({ telemetry: true })
    })
    const allowedMsg = await Effect.runPromise(allowedCmd.effect)
    expect(allowedMsg._tag).toBe("EgressAllowed")
  })

  it("interruptEgressFor builds the Interrupt command for the class key", () => {
    const cmd = interruptEgressFor("trustedBroadcast")
    expect(cmd.name).toBe("NetworkEgress.Interrupt")
    expect(cmd.interruptsKey).toBe("NetworkEgress:egress:trustedBroadcast")
  })
})
