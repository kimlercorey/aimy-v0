/**
 * model.test.ts — the top-level Model: Schema round-trips and slice ownership.
 */
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { initialModel, Model } from "./model.js"

describe("Model", () => {
  it("initialModel decodes through the Model schema", () => {
    const decoded = Schema.decodeUnknownSync(Model)(initialModel())
    expect(decoded.session.sessionId).toBe("session-1")
    expect(decoded.session.messages).toEqual([])
    expect(decoded.permissions.pending).toEqual([])
    expect(decoded.rejections.records).toEqual([])
  })

  it("encodes back to JSON and round-trips", () => {
    const json = JSON.stringify(Schema.encodeSync(Model)(initialModel()))
    const back = Schema.decodeUnknownSync(Model)(JSON.parse(json))
    expect(back.session.branchId).toBe("session-1")
  })

  it("sibling slices are discriminated placeholders the shell passes through", () => {
    const m = initialModel()
    expect(m.asc._tag).toBe("asc")
    expect(m.sovereignty._tag).toBe("sovereignty")
    expect(m.jobs._tag).toBe("jobs")
    expect(m.banners._tag).toBe("banners")
    expect(m.memoryView._tag).toBe("memoryView")
  })

  it("session slice carries the §3.1 fields", () => {
    const m = initialModel()
    expect(m.session._tag).toBe("session")
    expect(m.session.streaming.active).toBe(false)
    expect(m.session.contextMeter.ceiling).toBe(0)
    expect(m.session.listWindow.overscan).toBe(8)
  })
})
