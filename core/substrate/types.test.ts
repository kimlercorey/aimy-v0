import { inspect } from "node:util"
import { describe, expect, it } from "@effect/vitest"

import { InstanceId, Redacted, Timestamp, ToolName } from "./types.js"

const SECRET = "sk-live-abcdef-12345"

describe("Redacted", () => {
  it("never leaks through String()", () => {
    const s = String(Redacted.make(SECRET))
    expect(s).toBe("Redacted")
    expect(s).not.toContain(SECRET)
  })

  it("never leaks through template literals", () => {
    const s = `value=${Redacted.make(SECRET)}`
    expect(s).toBe("value=Redacted")
    expect(s).not.toContain(SECRET)
  })

  it("never leaks through JSON.stringify, nested or top-level", () => {
    const nested = JSON.stringify({ tool: "x", key: Redacted.make(SECRET) })
    expect(nested).toBe('{"tool":"x","key":"Redacted"}')
    expect(nested).not.toContain(SECRET)

    const top = JSON.stringify(Redacted.make(SECRET))
    expect(top).toBe('"Redacted"')
  })

  it("never leaks through util.inspect (console.log path)", () => {
    const s = inspect(Redacted.make(SECRET))
    expect(s).toBe("Redacted")
    expect(s).not.toContain(SECRET)
    const deep = inspect({ nested: [Redacted.make(SECRET)] })
    expect(deep).not.toContain(SECRET)
  })

  it("never leaks through object spread", () => {
    const spread = { ...Redacted.make(SECRET) }
    expect(JSON.stringify(spread)).toBe("{}")
    expect(Object.values(spread).join("")).not.toContain(SECRET)
  })

  it("reveal() is the single explicit access path", () => {
    expect(Redacted.make(SECRET).reveal()).toBe(SECRET)
  })

  it("keeps the wrapped type", () => {
    const n: Redacted<number> = Redacted.make(42)
    const revealed: number = n.reveal()
    expect(revealed).toBe(42)
  })
})

describe("branded types", () => {
  it("InstanceId and ToolName construct from strings", () => {
    const id: InstanceId = InstanceId("550e8400-e29b-41d4-a716-446655440000")
    const tool: ToolName = ToolName("exec")
    expect(typeof id).toBe("string")
    expect(typeof tool).toBe("string")
  })

  it("Timestamp helpers round-trip", () => {
    const t = Timestamp.fromEpochMs(1_700_000_000_000)
    expect(t).toBe(1_700_000_000_000)
    expect(Timestamp.toDate(t)).toEqual(new Date(1_700_000_000_000))
    expect(typeof Timestamp.now()).toBe("number")
  })
})
