/**
 * ui/src/composed/composed.test.ts — the composed app routes to every slice.
 *
 * - Each `Got*` envelope reaches only its own slice (foldChild isolation:
 *   sibling slices keep referential equality).
 * - The shell's structural rules survive composition (dial-mutation rejection).
 * - Initial state composes every slice's initial.
 */
import { describe, expect, it } from "vitest"

import { Message as ShellMessage } from "../messages.js"
import { Message as SovereigntyMessage } from "../sovereignty/index.js"
import { AppMessage } from "./messages.js"
import { initialAppModel } from "./model.js"
import { update } from "./update.js"

describe("composed app", () => {
  it("initializes every slice", () => {
    const model = initialAppModel()
    expect(model.shell.session.sessionId).toBe("session-1")
    expect(model.shell.permissions.pending).toEqual([])
    expect(model.sovereignty.localInference).toBe(true)
    expect(model.timeline.nodes).toEqual([])
    expect(model.jobs.jobs).toEqual([])
    expect(model.banners.banners).toEqual([])
    expect(model.asc.dials).toBeDefined()
    expect(model.exportState.phase).toBeDefined()
    expect(model.onboarding.step).toBeDefined()
  })

  it("GotShell routes to the shell slice only", () => {
    const model = initialAppModel()
    const next = update(
      model,
      AppMessage.GotShell({
        message: ShellMessage.ComposerDraftChanged({ text: "hello" }),
      }),
    )
    expect(next.model.shell.session.composer.draft).toBe("hello")
    // Sibling slices untouched (foldChild writes only its own slice).
    expect(next.model.sovereignty).toBe(model.sovereignty)
    expect(next.model.timeline).toBe(model.timeline)
    expect(next.model.asc).toBe(model.asc)
    expect(next.model.jobs).toBe(model.jobs)
    expect(next.model.banners).toBe(model.banners)
  })

  it("GotSovereignty routes to the sovereignty slice only", () => {
    const model = initialAppModel()
    const next = update(
      model,
      AppMessage.GotSovereignty({
        message: SovereigntyMessage.ToggleFlipRequested({
          classId: "telemetry",
          enabled: true,
        }),
      }),
    )
    // ToggleFlipRequested is pure: it emits the StampTime command and leaves
    // state for ToggleFlipStamped. The envelope routed (a command exists) and
    // every sibling slice keeps referential equality.
    expect(next.commands).toBeDefined()
    expect(next.commands!.length).toBeGreaterThan(0)
    expect(next.model.shell).toBe(model.shell)
    expect(next.model.timeline).toBe(model.timeline)
    expect(next.model.asc).toBe(model.asc)
    expect(next.model.jobs).toBe(model.jobs)
  })

  it("shell rejection gate survives composition (dial mutation rejected)", () => {
    const model = initialAppModel()
    // A dial-mutation-shaped object arriving as unvalidated JSON (the
    // DevTools/MCP dispatch path) is rejected by the shell's gate, which the
    // composed update delegates to. It cannot be wrapped in a GotShell
    // envelope: the envelope's Schema validation rejects it at construction.
    const next = update(model, { _tag: "DialsSetDirectly", dials: [9, 9, 9, 9] })
    const records = next.model.shell.rejections.records
    expect(records.length).toBeGreaterThan(0)
    expect(records[records.length - 1]!.reason).toBe("dial-mutation-rejected")
    // Nothing else changed.
    expect(next.model.asc).toBe(model.asc)
    expect(next.model.sovereignty).toBe(model.sovereignty)
  })
})
