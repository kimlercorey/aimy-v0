/**
 * update.test.ts — the pure update function.
 *
 * Covers: the rejection gate (dial-mutation attempts are logged, never
 * applied), the session lifecycle (send -> stream -> settle/fail), the
 * permission flow (deny drops the intent), streaming append-only semantics,
 * stale-chunk discipline, sibling-slice passthrough, and the bounded
 * rejections audit.
 */
import { describe, expect, it } from "@effect/vitest"
import { MAX_REJECTIONS, initialModel, type Model } from "./model.js"
import { Message } from "./messages.js"
import { update } from "./update.js"

const fresh = (): Model => initialModel()

/** Drive the model through a user message -> stream start. */
const startStream = (model: Model, id = "m1"): Model => {
  const sent = update(model, Message.UserSentMessage({ id, text: "hello", at: 1000 }))
  const started = update(
    sent.model,
    Message.StreamStarted({ streamId: id, sessionId: "session-1", input: "hello", at: 1001 }),
  )
  return started.model
}

describe("update: rejection gate (structural rule)", () => {
  it("rejects a DialsSetDirectly-shaped message: logged, never applied", () => {
    const model = fresh()
    const raw = { _tag: "DialsSetDirectly", dials: { W: 9, P: 1 } }
    const result = update(model, raw)
    // Never applied: session, permissions, and everything else identical…
    expect(result.model.session).toEqual(model.session)
    expect(result.model.permissions).toEqual(model.permissions)
    expect(result.commands).toBeUndefined()
    // …but logged with the dial-mutation reason.
    expect(result.model.rejections.records).toHaveLength(1)
    expect(result.model.rejections.records[0]).toMatchObject({
      tag: "DialsSetDirectly",
      reason: "dial-mutation-rejected",
    })
  })

  it("rejects unknown tags without applying them", () => {
    const model = startStream(fresh())
    const before = model.session.messages.length
    const result = update(model, { _tag: "EvilModuleMessage", x: 1 })
    expect(result.model.session.messages).toHaveLength(before)
    expect(result.model.session.streaming.text).toBe("")
    expect(result.model.rejections.records[0]).toMatchObject({
      tag: "EvilModuleMessage",
      reason: "unknown-tag",
    })
  })

  it("rejects non-objects and malformed variants as decode failures", () => {
    const r1 = update(fresh(), 42)
    expect(r1.model.rejections.records[0]?.reason).toBe("decode-failed")
    // Right tag, wrong payload shape: still rejected, never partially applied.
    const r2 = update(fresh(), { _tag: "UserSentMessage", text: 42 })
    expect(r2.model.session.messages).toHaveLength(0)
    expect(r2.model.rejections.records[0]?.reason).toBe("decode-failed")
  })

  it("bounds the rejections audit at MAX_REJECTIONS", () => {
    let model = fresh()
    for (let i = 0; i < MAX_REJECTIONS + 25; i++) {
      model = update(model, { _tag: `Nope${i}` }).model
    }
    expect(model.rejections.records).toHaveLength(MAX_REJECTIONS)
  })
})

describe("update: session lifecycle", () => {
  it("UserSentMessage appends, clears the draft, and emits inference + persist commands", () => {
    const withDraft: Model = {
      ...fresh(),
      session: { ...fresh().session, composer: { draft: "hello" } },
    }
    const result = update(withDraft, Message.UserSentMessage({ id: "m1", text: "hello", at: 7 }))
    expect(result.model.session.messages).toHaveLength(1)
    expect(result.model.session.messages[0]).toMatchObject({ id: "m1", role: "user", text: "hello", at: 7 })
    expect(result.model.session.composer.draft).toBe("")
    expect(result.commands).toHaveLength(2)
    expect(result.commands?.[0]?.name).toBe("SendToInference")
    expect(result.commands?.[0]?.args).toMatchObject({ correlationId: "m1" })
    expect(result.commands?.[1]?.name).toBe("PersistMemory")
  })

  it("blank messages are ignored: no row, no commands", () => {
    const result = update(fresh(), Message.UserSentMessage({ id: "m1", text: "   ", at: 7 }))
    expect(result.model.session.messages).toHaveLength(0)
    expect(result.commands).toBeUndefined()
  })

  it("StreamChunkReceived appends to the streaming text only", () => {
    let model = startStream(fresh())
    model = update(model, Message.StreamChunkReceived({ streamId: "m1", delta: "hel" })).model
    model = update(model, Message.StreamChunkReceived({ streamId: "m1", delta: "lo" })).model
    expect(model.session.streaming.text).toBe("hello")
    // The transcript gains no rows until settle: no per-chunk rebuild surface.
    expect(model.session.messages).toHaveLength(1)
  })

  it("stale chunks from an interrupted stream are ignored, never applied", () => {
    const model = startStream(fresh())
    const result = update(model, Message.StreamChunkReceived({ streamId: "old-stream", delta: "xx" }))
    expect(result.model.session.streaming.text).toBe("")
    expect(result.commands).toBeUndefined()
  })

  it("StreamSettled appends the assistant row, clears streaming, updates the meter", () => {
    let model = startStream(fresh())
    const result = update(
      model,
      Message.StreamSettled({
        streamId: "m1",
        text: "hi there",
        at: 2000,
        usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 40 },
      }),
    )
    model = result.model
    expect(model.session.messages).toHaveLength(2)
    expect(model.session.messages[1]).toMatchObject({ id: "m1", role: "assistant", text: "hi there" })
    expect(model.session.streaming.active).toBe(false)
    expect(model.session.contextMeter).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 40,
    })
    expect(result.commands).toHaveLength(1)
    expect(result.commands?.[0]?.name).toBe("PersistMemory")
  })

  it("StreamSettled without usage leaves the meter as unknown, never zeroed", () => {
    let model = startStream(fresh())
    model = update(model, Message.StreamSettled({ streamId: "m1", text: "t", at: 9 })).model
    expect(model.session.contextMeter.inputTokens).toBeNull()
  })

  it("StreamFailed records the failure as a message, never a silent drop", () => {
    let model = startStream(fresh())
    const result = update(model, Message.StreamFailed({ streamId: "m1", reason: "boom" }))
    expect(result.model.session.streaming.active).toBe(false)
    expect(result.model.session.messages[1]?.text).toContain("boom")
  })

  it("SessionBranched moves the session id and keeps history", () => {
    let model = startStream(fresh())
    model = update(model, Message.SessionBranched({ fromId: "session-1", newSessionId: "session-2" })).model
    expect(model.session.sessionId).toBe("session-2")
    expect(model.session.branchId).toBe("session-2")
    expect(model.session.messages).toHaveLength(1)
  })
})

describe("update: permissions", () => {
  const prompt = () =>
    Message.PermissionRequested({
      requestId: "r1",
      tool: "exec",
      argsSummary: '{"cmd":"rm -rf /tmp/x"}',
      riskTier: "T3",
      context: "agent-loop:turn-3",
      at: 5,
    })

  it("PermissionRequested raises the prompt (deduped by requestId)", () => {
    let model = update(fresh(), prompt()).model
    expect(model.permissions.pending).toHaveLength(1)
    model = update(model, prompt()).model
    expect(model.permissions.pending).toHaveLength(1)
  })

  it("PermissionDenied drops the intent and records a terminal decision", () => {
    let model = update(fresh(), prompt()).model
    const result = update(model, Message.PermissionDenied({ requestId: "r1", at: 6 }))
    expect(result.model.permissions.pending).toHaveLength(0)
    expect(result.model.permissions.decisions).toHaveLength(1)
    expect(result.model.permissions.decisions[0]).toMatchObject({
      requestId: "r1",
      decision: "denied",
    })
  })

  it("PermissionGranted records the scope and clears the prompt", () => {
    let model = update(fresh(), prompt()).model
    const result = update(model, Message.PermissionGranted({ requestId: "r1", scope: "always", at: 6 }))
    expect(result.model.permissions.pending).toHaveLength(0)
    expect(result.model.permissions.decisions[0]).toMatchObject({
      decision: "granted-always",
    })
  })

  it("PermissionCheckFailed with denied:true records a terminal denial", () => {
    const result = update(
      fresh(),
      Message.PermissionCheckFailed({ requestId: "r9", denied: true, reason: "policy", at: 1 }),
    )
    expect(result.model.permissions.decisions[0]).toMatchObject({ decision: "denied" })
  })

  it("PermissionAutoAllowed records a policy decision without prompting", () => {
    const result = update(fresh(), Message.PermissionAutoAllowed({ requestId: "r2", at: 3 }))
    expect(result.model.permissions.pending).toHaveLength(0)
    expect(result.model.permissions.decisions[0]).toMatchObject({
      decision: "allowed-by-policy",
    })
  })
})

describe("update: sibling slices pass through untouched", () => {
  it("never touches asc, jobs, banners, sovereignty, or any other track slice", () => {
    const model: Model = {
      ...fresh(),
      asc: { _tag: "asc", status: "track-owned" },
      jobs: { _tag: "jobs", status: "track-owned" },
    }
    const result = update(model, Message.UserSentMessage({ id: "m1", text: "hi", at: 1 }))
    expect(result.model.asc).toEqual({ _tag: "asc", status: "track-owned" })
    expect(result.model.jobs).toEqual({ _tag: "jobs", status: "track-owned" })
    const rejected = update(model, { _tag: "DialsSetDirectly" })
    expect(rejected.model.asc).toEqual({ _tag: "asc", status: "track-owned" })
  })
})
