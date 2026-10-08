/**
 * ui/src/messaging/messaging.test.ts — the wizard state machine (pure update).
 *
 * No IPC here: update is pure, so we drive it through messages and assert
 * the model transitions + the commands it answers with.
 */
import { describe, expect, it } from "vitest"

import { Message } from "./messages.js"
import { initialModel } from "./model.js"
import { update } from "./update.js"

const apply = (model: ReturnType<typeof initialModel>, message: Message) => update(model, message)

describe("messaging wizard", () => {
  it("starts idle with no status", () => {
    const m = initialModel()
    expect(m.step).toBe("idle")
    expect(m.status).toBeUndefined()
  })

  it("StatusRequested → busy + RefreshStatus command", () => {
    const r = apply(initialModel(), Message.StatusRequested({}))
    expect(r.model.busy).toBe(true)
    expect(r.commands?.length).toBe(1)
  })

  it("StatusReceived stores status and forwarding kinds", () => {
    const r = apply(
      initialModel(),
      Message.StatusReceived({
        configured: true,
        botUsername: "testbot",
        paired: true,
        forwardingKinds: ["critical"],
      })
    )
    expect(r.model.status?.configured).toBe(true)
    expect(r.model.status?.botUsername).toBe("testbot")
    expect(r.model.forwardingKinds).toEqual(["critical"])
    expect(r.model.busy).toBe(false)
  })

  it("token submit clears the draft and validates", () => {
    const withDraft = { ...initialModel(), draftToken: "  abc123  " }
    const r = apply(withDraft, Message.TokenSubmitted({ token: "  abc123  " }))
    expect(r.model.draftToken).toBe("") // never retained
    expect(r.model.step).toBe("validating")
    expect(r.commands?.length).toBe(1)
  })

  it("empty token is rejected without a command", () => {
    const r = apply(initialModel(), Message.TokenSubmitted({ token: "   " }))
    expect(r.model.tokenError).toContain("Paste the token")
    expect(r.commands).toBeUndefined()
  })

  it("TokenValidated → code step + IssueCode command", () => {
    const r = apply(
      { ...initialModel(), step: "validating", busy: true },
      Message.TokenValidated({ botUsername: "testbot" })
    )
    expect(r.model.step).toBe("code")
    expect(r.model.botUsername).toBe("testbot")
    expect(r.commands?.length).toBe(1)
  })

  it("CodeIssued → pairing step with the code", () => {
    const r = apply(
      { ...initialModel(), step: "code", busy: true },
      Message.CodeIssued({ code: "123456", expiresAt: "2026-10-08T00:00:00Z" })
    )
    expect(r.model.step).toBe("pairing")
    expect(r.model.pairingCode).toBe("123456")
  })

  it("PairingPaired clears the code and moves to prefs", () => {
    const r = apply(
      { ...initialModel(), step: "pairing", pairingCode: "123456" },
      Message.PairingPaired({})
    )
    expect(r.model.step).toBe("prefs")
    expect(r.model.pairingCode).toBeUndefined()
  })

  it("forwarding kinds toggle", () => {
    const m1 = apply(initialModel(), Message.ForwardingKindToggled({ kind: "info" }))
    expect(m1.model.forwardingKinds).toEqual(["info"])
    const m2 = apply(m1.model, Message.ForwardingKindToggled({ kind: "info" }))
    expect(m2.model.forwardingKinds).toEqual([])
  })

  it("forwarding submit saves then tests", () => {
    const r = apply(
      { ...initialModel(), step: "prefs", forwardingKinds: ["critical"] },
      Message.ForwardingSubmitRequested({})
    )
    expect(r.model.busy).toBe(true)
    expect(r.commands?.length).toBe(1)
    const r2 = apply(r.model, Message.ForwardingSaved({ kinds: ["critical"] }))
    expect(r2.model.step).toBe("testing")
  })

  it("TestSucceeded finishes the wizard", () => {
    const r = apply({ ...initialModel(), step: "testing", busy: true }, Message.TestSucceeded({}))
    expect(r.model.step).toBe("done")
    expect(r.model.busy).toBe(false)
  })

  it("WizardCancelled resets to idle, keeping status", () => {
    const mid = {
      ...initialModel(),
      step: "pairing" as const,
      pairingCode: "123456",
      status: {
        configured: true,
        botUsername: "testbot",
        paired: false,
        forwardingKinds: ["critical"],
      },
    }
    const r = apply(mid, Message.WizardCancelled({}))
    expect(r.model.step).toBe("idle")
    expect(r.model.pairingCode).toBeUndefined()
    expect(r.model.status?.configured).toBe(true)
  })
})
