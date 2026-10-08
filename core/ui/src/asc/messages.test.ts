/**
 * Structural test: the computed-not-chosen rule at the message level.
 *
 * Scans `messages.ts` source and proves:
 * 1. No message variant can set dials — there is no `DialsSetDirectly`,
 *    `SetDials`, `DialChanged`, or any other dial-mutation variant. The only
 *    dial-carrying variant is `DialComputationArchived`, the pipeline's
 *    read-only write.
 * 2. The pipeline-only dispatch of `DialComputationArchived` is documented
 *    in the source.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, "messages.ts"), "utf8")

/** Variant tags declared in the `defineMessageUnion({...})` literal. */
const variantTags = (): Array<string> => {
  const literal = source.slice(
    source.indexOf("defineMessageUnion({"),
    source.lastIndexOf("})"),
  )
  const tags: Array<string> = []
  for (const match of literal.matchAll(/^  (\w+):\s*\{/gm)) {
    const tag = match[1]
    if (tag !== undefined) tags.push(tag)
  }
  return tags
}

describe("ASC messages: computed, not chosen (structural)", () => {
  it("declares exactly the expected variants", () => {
    expect(variantTags().sort()).toEqual(
      [
        "AffectTuningChanged",
        "DiagnosticRunCompleted",
        "DialComputationArchived",
        "ErrorTermFired",
        // Display-only: the voice channel drives the preview through the
        // turn's AU timeline. Never carries dials, never writes them.
        "ExpressionFrameCleared",
        "ExpressionFrameShown",
        "OtherModelGuardFired",
        "PreviewRendererChanged",
        "TuningChangeFailed",
        "TuningChangeRecorded",
      ].sort(),
    )
  })

  it("contains no dial-mutation variant", () => {
    const tags = variantTags()
    // The only dial-carrying variant is the pipeline's read-only write.
    const dialCarriers = tags.filter((t) => /dial/i.test(t))
    expect(dialCarriers).toEqual(["DialComputationArchived"])
    // No setter-shaped variant under any name.
    for (const tag of tags) {
      expect(tag).not.toMatch(/^(set|update|change|mutate)/i)
      expect(tag).not.toMatch(/dials?set/i)
    }
  })

  it("documents that DialComputationArchived is pipeline-only", () => {
    const flat = source.replace(/[*]/g, "").replace(/\s+/g, " ")
    expect(flat).toContain("dispatched ONLY by the ASC pipeline")
    expect(flat).toContain("NO `DialsSetDirectly`")
  })

  it("the update source has no dial-writing call", () => {
    const updateSource = fs.readFileSync(path.join(here, "update.ts"), "utf8")
    expect(updateSource).not.toMatch(/applyPipelineDials|setDials/i)
  })
})
