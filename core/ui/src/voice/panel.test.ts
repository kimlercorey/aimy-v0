/**
 * ui/src/voice/panel.test.ts — the voice panel state machine (pure update).
 *
 * Covers: panel open fetches engine status; install progress drives the
 * installing state; ready triggers a voice fetch; voice add selects the
 * new clone; enabling voice with no engine opens the panel.
 */
import { describe, expect, it } from "vitest"

import { initialModel, type Model } from "../model.js"
import { Message } from "../messages.js"
import { update } from "../update.js"

const fresh = (): Model => initialModel()

const apply = (model: Model, message: Parameters<typeof update>[1]) =>
  update(model, message)

describe("voice panel", () => {
  it("opening the panel fetches engine status", () => {
    const r = apply(fresh(), Message.VoicePanelToggled({ open: true }))
    expect(r.model.session.voicePanelOpen).toBe(true)
    expect(r.commands).toHaveLength(1)
  })

  it("closing the panel issues no command", () => {
    const opened = apply(fresh(), Message.VoicePanelToggled({ open: true }))
    const r = apply(opened.model, Message.VoicePanelToggled({ open: false }))
    expect(r.model.session.voicePanelOpen).toBe(false)
    expect(r.commands).toBeUndefined()
  })

  it("status ready triggers a voice fetch", () => {
    const opened = apply(fresh(), Message.VoicePanelToggled({ open: true }))
    const r = apply(opened.model, Message.TtsEngineStatusReceived({ state: "ready" }))
    expect(r.model.session.ttsEngine.state).toBe("ready")
    expect(r.commands).toHaveLength(1)
  })

  it("status missing triggers no fetch", () => {
    const opened = apply(fresh(), Message.VoicePanelToggled({ open: true }))
    const r = apply(opened.model, Message.TtsEngineStatusReceived({ state: "missing" }))
    expect(r.model.session.ttsEngine.state).toBe("missing")
    expect(r.commands).toBeUndefined()
  })

  it("install progress drives installing state; done refetches voices", () => {
    const m0 = fresh()
    const started = apply(m0, Message.TtsInstallStarted({}))
    expect(started.model.session.ttsEngine.state).toBe("installing")
    const prog = apply(
      started.model,
      Message.TtsInstallProgressReceived({ phase: "deps", message: "Downloading torch…" })
    )
    expect(prog.model.session.ttsEngine.state).toBe("installing")
    expect(prog.model.session.ttsEngine.progressMessage).toBe("Downloading torch…")
    const done = apply(
      prog.model,
      Message.TtsInstallProgressReceived({ phase: "done", message: "installed" })
    )
    expect(done.model.session.ttsEngine.state).toBe("ready")
    expect(done.commands).toHaveLength(1)
  })

  it("install error surfaces the detail", () => {
    const m0 = fresh()
    const r = apply(
      m0,
      Message.TtsInstallProgressReceived({ phase: "error", message: "no disk space" })
    )
    expect(r.model.session.ttsEngine.state).toBe("failed")
    expect(r.model.session.ttsEngine.detail).toBe("no disk space")
  })

  it("voices received stores the list and picks the default", () => {
    const m0 = fresh()
    const r = apply(
      m0,
      Message.VoicesReceived({
        voices: [
          { id: "v1", name: "Default", isDefault: true },
          { id: "v2", name: "Clone", isDefault: false },
        ],
      })
    )
    expect(r.model.session.voices).toHaveLength(2)
    expect(r.model.session.activeVoiceId).toBe("v1")
  })

  it("adding a voice selects the new clone immediately", () => {
    const m0 = fresh()
    const r = apply(
      m0,
      Message.VoiceAdded({ id: "v9", name: "Kimler", isDefault: false })
    )
    expect(r.model.session.voices.map((v) => v.id)).toContain("v9")
    expect(r.commands).toHaveLength(1) // SelectVoice
  })

  it("enabling voice with no engine opens the panel", () => {
    const r = apply(fresh(), Message.VoiceToggled({ enabled: true }))
    expect(r.model.session.voiceEnabled).toBe(true)
    expect(r.model.session.voicePanelOpen).toBe(true)
    expect(r.commands).toHaveLength(1)
  })

  it("enabling voice with a ready engine does not open the panel", () => {
    const m0 = fresh()
    const ready = apply(m0, Message.TtsEngineStatusReceived({ state: "ready" }))
    const r = apply(ready.model, Message.VoiceToggled({ enabled: true }))
    expect(r.model.session.voiceEnabled).toBe(true)
    expect(r.model.session.voicePanelOpen).toBe(false)
  })

  it("voice errors clear when the panel reopens", () => {
    const m0 = fresh()
    const failed = apply(m0, Message.VoicesFailed({ reason: "boom" }))
    expect(failed.model.session.voiceError).toBe("boom")
    const reopened = apply(failed.model, Message.VoicePanelToggled({ open: true }))
    expect(reopened.model.session.voiceError).toBeUndefined()
  })
})
