/**
 * composerKeySubmit — the Enter-to-submit decision, tested directly.
 *
 * The view wires this to OnKeyDownPreventDefault on the composer input;
 * the pure function carries the whole decision so the test does not need
 * a DOM or a dispatch context.
 */
import { describe, expect, it } from "vitest"
import { Option } from "effect"

import { composerKeySubmit } from "./view.js"

const tagOf = (result: Option.Option<unknown>): string | null =>
  Option.isSome(result) ? (result.value as { _tag: string })._tag : null

describe("composerKeySubmit", () => {
  it("Enter with a non-empty draft submits a UserSentMessage", () => {
    const result = composerKeySubmit("hello", false, "Enter", false)
    expect(tagOf(result)).toBe("UserSentMessage")
  })

  it("the submitted message carries the draft text", () => {
    const result = composerKeySubmit("  weather?  ", false, "Enter", false)
    expect(Option.isSome(result)).toBe(true)
    if (Option.isSome(result)) {
      expect((result.value as { text: string }).text).toBe("  weather?  ")
    }
  })

  it("declines other keys", () => {
    expect(composerKeySubmit("hello", false, "a", false)).toEqual(Option.none())
    expect(composerKeySubmit("hello", false, "Shift", false)).toEqual(Option.none())
  })

  it("declines Shift+Enter", () => {
    expect(composerKeySubmit("hello", false, "Enter", true)).toEqual(Option.none())
  })

  it("declines while streaming", () => {
    expect(composerKeySubmit("hello", true, "Enter", false)).toEqual(Option.none())
  })

  it("declines empty / whitespace-only drafts", () => {
    expect(composerKeySubmit("", false, "Enter", false)).toEqual(Option.none())
    expect(composerKeySubmit("   ", false, "Enter", false)).toEqual(Option.none())
  })
})
