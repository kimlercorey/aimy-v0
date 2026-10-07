/**
 * export/export.test.ts — the wizard's MUST behaviors: one-click flow,
 * verify-before-package, fail-closed on verification failure, and the
 * locker-manifest-only discipline.
 */
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { ExportBundle } from "./commands.js"
import { Message } from "./messages.js"
import { initialModel, type ExportReceiptModel } from "./model.js"
import { ExportInterpreter, ExportInterpreterUnwired, type ExportInterpreterShape } from "./seam.js"
import { ExportError } from "../../../substrate/errors.js"
import { update } from "./update.js"

const RECEIPT: ExportReceiptModel = {
  version: 1,
  exportedAt: "2026-10-07T07:00:00.000Z",
  instanceId: "instance-123",
  exporterVersion: "aimy-export/1.0.0",
  files: { "memory/sessions/a.jsonl": "abc123", "manifest.json": "def456" },
  bundleHash: "bundle-hash-xyz"
}

describe("export wizard flow", () => {
  it("requesting an export emits the ExportBundle command and enters progress", () => {
    const result = update(initialModel(), Message.ExportRequested({ destination: "/tmp/aimy-export" }))
    expect(result.model.phase).toBe("running")
    expect(result.model.destination).toBe("/tmp/aimy-export")
    expect(result.commands).toHaveLength(1)
    expect(result.commands?.[0]?.name).toBe("ExportBundle")
  })

  it("progress messages update the indicator", () => {
    const running = update(initialModel(), Message.ExportRequested({ destination: "/tmp/x" })).model
    const result = update(
      running,
      Message.ExportProgressed({ currentFile: "memory/sessions/a.jsonl", filesDone: 3, filesTotal: 12 })
    )
    expect(result.model.filesDone).toBe(3)
    expect(result.model.filesTotal).toBe(12)
    expect(result.model.currentFile).toBe("memory/sessions/a.jsonl")
  })

  it("completion stages the receipt but does not show it (verify-before-package)", () => {
    const running = update(initialModel(), Message.ExportRequested({ destination: "/tmp/x" })).model
    const result = update(running, Message.ExportCompleted({ receipt: RECEIPT }))
    expect(result.model.phase).toBe("verifying")
    expect(result.model.receipt).toEqual(RECEIPT)
  })

  it("verification shows the integrity receipt", () => {
    const verifying = update(
      update(initialModel(), Message.ExportRequested({ destination: "/tmp/x" })).model,
      Message.ExportCompleted({ receipt: RECEIPT })
    ).model
    const result = update(verifying, Message.ExportVerified({ receipt: RECEIPT }))
    expect(result.model.phase).toBe("complete")
    expect(result.model.receipt?.bundleHash).toBe("bundle-hash-xyz")
  })

  it("failed verification is fail-closed: no receipt, no partial bundle", () => {
    const verifying = update(
      update(initialModel(), Message.ExportRequested({ destination: "/tmp/x" })).model,
      Message.ExportCompleted({ receipt: RECEIPT })
    ).model
    const result = update(verifying, Message.ExportFailed({ reason: "export:verify:hash-mismatch" }))
    expect(result.model.phase).toBe("failed")
    expect(result.model.receipt).toBeUndefined()
    expect(result.model.error).toBe("export:verify:hash-mismatch")
  })
})

describe("locker manifest discipline", () => {
  it("the wizard state can hold ids and metadata but never secret values", () => {
    const secretValue = "super-secret-value-xyz-123"
    const result = update(
      initialModel(),
      Message.LockerManifestLoaded({
        entries: [
          { name: "identity/instance-signing-key", scope: "instance", createdAt: 1728288000000 },
          { name: "api/openai", scope: "user", createdAt: 1728288100000 }
        ]
      })
    )
    const serialized = JSON.stringify(result.model)
    expect(serialized).not.toContain(secretValue)
    expect(result.model.lockerManifest).toHaveLength(2)
    for (const entry of result.model.lockerManifest) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "name", "scope"])
    }
  })
})

describe("the export interpreter seam", () => {
  const runWith = (shape: ExportInterpreterShape) =>
    Effect.runPromise(
      Effect.provide(ExportBundle({ destination: "/tmp/x" }).effect, Layer.succeed(ExportInterpreter, shape))
    )

  it("the unwired interpreter fails closed — never a phantom success", async () => {
    const msg = await runWith(ExportInterpreterUnwired)
    expect(msg._tag).toBe("ExportFailed")
    if (msg._tag === "ExportFailed") expect(msg.reason).toBe("export:interpreter-not-wired")
  })

  it("a provided interpreter yields the verified receipt", async () => {
    const msg = await runWith({
      run: (_destination) =>
        Effect.succeed({
          version: 1,
          exportedAt: RECEIPT.exportedAt,
          instanceId: RECEIPT.instanceId,
          exporterVersion: RECEIPT.exporterVersion,
          files: RECEIPT.files,
          bundleHash: RECEIPT.bundleHash
        })
    })
    expect(msg._tag).toBe("ExportVerified")
    if (msg._tag === "ExportVerified") expect(msg.receipt.bundleHash).toBe("bundle-hash-xyz")
  })

  it("an interpreter failure becomes ExportFailed, not a crash", async () => {
    const msg = await runWith({
      run: (_destination) => Effect.fail(new ExportError({ reason: "export:memory:list-sessions:SomeError" }))
    })
    expect(msg._tag).toBe("ExportFailed")
    if (msg._tag === "ExportFailed") expect(msg.reason).toContain("export:memory")
  })
})
