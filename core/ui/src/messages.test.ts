/**
 * messages.test.ts — the structural rule, tested two ways (architecture §3.2).
 *
 * 1. Source scan: no dial-setting message variant may exist in messages.ts —
 *    not `DialsSetDirectly`, not the ASC track's `DialComputationArchived`,
 *    not anything matching /dials?.*set|set.*dials?/i. Dials are write-only
 *    from the ASC pipeline ("computed, not chosen"); the shell union must not
 *    grow a write path even by accident.
 * 2. Union shape: MESSAGE_TAGS matches the union's declared members exactly,
 *    so the runtime rejection guard in update.ts cannot drift out of sync.
 */
import { describe, expect, it } from "@effect/vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { MESSAGE_TAGS, Message } from "./messages.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const rawSource = fs.readFileSync(path.join(here, "messages.ts"), "utf8")
// The structural rule is about the CODE: comments may discuss the forbidden
// variant (this file documents why it is absent), so strip them first.
const source = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|\s)\/\/.*$/gm, "$1")

describe("message vocabulary (structural rule)", () => {
  it("contains no dial-setting variant", () => {
    expect(source).not.toMatch(/DialsSetDirectly/i)
    expect(source).not.toMatch(/DialsSet/i)
    expect(source).not.toMatch(/SetDials/i)
    // The ASC track's read-only write message belongs to the ASC union, not this one.
    expect(source).not.toMatch(/DialComputationArchived/)
    expect(source).not.toMatch(/OtherModelGuardFired/)
    expect(source).not.toMatch(/ErrorTermFired/)
    expect(source).not.toMatch(/AffectTuningChanged/)
    // Belt and suspenders: no mention of dials survives comment-stripping.
    expect(source).not.toMatch(/dial/i)
  })

  it("no variant name suggests dial mutation", () => {
    for (const tag of MESSAGE_TAGS) {
      expect(tag.toLowerCase()).not.toContain("dial")
    }
  })

  it("MESSAGE_TAGS matches the union members exactly", () => {
    // Every variant is a callable property on the union object.
    for (const tag of MESSAGE_TAGS) {
      expect(typeof (Message as unknown as Record<string, unknown>)[tag]).toBe("function")
    }
    expect(MESSAGE_TAGS).toHaveLength(16)
  })

  it("constructs the session + permission MVP vocabulary", () => {
    const sent = Message.UserSentMessage({ id: "m1", text: "hi", at: 1 })
    expect(sent._tag).toBe("UserSentMessage")
    const denied = Message.PermissionDenied({ requestId: "r1", at: 2 })
    expect(denied._tag).toBe("PermissionDenied")
    const chunk = Message.StreamChunkReceived({ streamId: "s1", delta: "hel" })
    expect(chunk.delta).toBe("hel")
  })
})
