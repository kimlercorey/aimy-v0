import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  AscError,
  ConfigError,
  ExportError,
  IdentityError,
  InferenceError,
  MemoryStoreError,
  ModuleError,
  PermissionDenied,
  SandboxViolation,
} from "./errors.js"

describe("substrate error taxonomy", () => {
  it("every error class carries its _tag", () => {
    expect(new PermissionDenied({ tool: "exec", tier: "T2", reason: "denied" })._tag)
      .toBe("PermissionDenied")
    expect(new SandboxViolation({ reason: "no backend" })._tag).toBe("SandboxViolation")
    expect(new SandboxViolation({ reason: "no backend", backend: "seatbelt" }).backend)
      .toBe("seatbelt")
    expect(new MemoryStoreError({ store: "session", reason: "io" })._tag)
      .toBe("MemoryStoreError")
    expect(new InferenceError({ provider: "ollama", reason: "down" })._tag)
      .toBe("InferenceError")
    expect(new ExportError({ reason: "disk full" })._tag).toBe("ExportError")
    expect(new ConfigError({ reason: "bad json" })._tag).toBe("ConfigError")
    expect(new IdentityError({ reason: "no keypair" })._tag).toBe("IdentityError")
    expect(new ModuleError({ module: "web-retrieval", reason: "crash" })._tag)
      .toBe("ModuleError")
    expect(new AscError({ reason: "dial out of range" })._tag).toBe("AscError")
  })

  it("errors are Effect Data — structural equality holds", () => {
    const a = new ConfigError({ reason: "x" })
    const b = new ConfigError({ reason: "x" })
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it("errors flow through Effect typed channels instead of being thrown", async () => {
    const err = new PermissionDenied({ tool: "exec", tier: "T0", reason: "no" })
    const recovered = await Effect.runPromise(
      Effect.flip(Effect.fail(err) as Effect.Effect<never, PermissionDenied>),
    )
    expect(recovered).toBe(err)
    expect(recovered._tag).toBe("PermissionDenied")
  })
})
