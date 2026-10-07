/**
 * ui/src/commands.ts — effects as data (architecture §3.3).
 *
 * The update function never performs effects; it returns these Commands, which
 * the Effect runtime interprets at the shell boundary. Every command carries a
 * correlation id back to the Message that produced it (requestId /
 * correlationId), so the DevTools timeline shows cause -> effect. Failed
 * commands produce failure Messages, never silent drops.
 *
 * The real service APIs are read from source, not reimplemented:
 * - `SendToInference` — the turn's *intent*; the live token pump is the
 *   `inferenceStream` Subscription in app.ts, which runs `AgentLoop.chat`
 *   (itself routed through the InferencePool — no direct model calls).
 *   The command is interruptible (name-keyed): sending a new message while a
 *   turn streams cancels the old one; the interrupted effect's messages are
 *   guaranteed never to dispatch, and stale chunks are ignored by update.
 * - `RequestPermission` — via `SafetyKernel`. The prompt is UI, the gate is
 *   the kernel (Pi #10426). Interruptible, keyed by requestId.
 * - `PersistMemory` — via `MemoryService.append` (JSONL session tree).
 *
 * INTEGRATION CONTRACT (for the later foldChild pass): a `PermissionGranted`
 * decision in the Model means the user approved; the command *interpreter* at
 * the shell boundary must call `SafetyKernel.approve(intent)` for the matching
 * requestId before the agent loop's `execute()` proceeds. The kernel — not
 * the UI — remains the enforcement point, and denial stays terminal there.
 */
import { Cause, Effect, Schema } from "effect"
import { define as defineCommand, type CommandDefinitionWithArgs } from "foldkit/command"
import { MemoryService } from "../../memory/service.js"
import { SafetyKernel } from "../../permission-kernel/index.js"
import type { JsonValue, ToolName } from "../../substrate/types.js"
import { Message } from "./messages.js"

/**
 * Nameable message-instance types for the command annotations below.
 * `defineCommand` with `interrupt: true` infers `DefinitionWithArgsNameKeyed`,
 * which is not reachable through foldkit's public exports, so declaration
 * emit (TS2883) needs these explicit annotations. The annotations are
 * behavior-identical: same names, same args, same effects.
 */
type StreamStartedMsg = ReturnType<typeof Message.StreamStarted>
type PermissionMsg =
  | ReturnType<typeof Message.PermissionRequested>
  | ReturnType<typeof Message.PermissionAutoAllowed>
  | ReturnType<typeof Message.PermissionCheckFailed>

/** Shared tier schema, named so `typeof` captures its exact literal type. */
const TierSchema = Schema.Literals(["T0", "T1", "T2", "T3"])

/* ------------------------------------------------------------------ */
/* SendToInference                                                     */
/* ------------------------------------------------------------------ */

/**
 * The user sent a message; arm the streaming state and let the
 * `inferenceStream` subscription pump `AgentLoop.chat` chunks into
 * StreamChunkReceived / StreamSettled / StreamFailed.
 */
export const SendToInference: CommandDefinitionWithArgs<
  "SendToInference",
  {
    correlationId: typeof Schema.String
    sessionId: typeof Schema.String
    input: typeof Schema.String
  },
  Effect.Effect<StreamStartedMsg, never, never>
> = defineCommand("SendToInference", {
  args: {
    /** Correlation id: the UserSentMessage id, reused as the streamId. */
    correlationId: Schema.String,
    sessionId: Schema.String,
    input: Schema.String,
  },
  messages: [Message.StreamStarted, Message.StreamFailed],
  interrupt: true,
  execute: ({ correlationId, sessionId, input }) =>
    Effect.succeed(
      Message.StreamStarted({ streamId: correlationId, sessionId, input, at: Date.now() }),
    ),
})

/* ------------------------------------------------------------------ */
/* RequestPermission                                                   */
/* ------------------------------------------------------------------ */

/**
 * Consult the SafetyKernel about a tool intent. The kernel's answer drives
 * the UI: "allow" is recorded silently, "ask" raises the prompt surface,
 * "deny" fails typed and is recorded as a terminal denial. The args travel
 * as a JSON string because command args must be Schema-plain; they are
 * parsed back to JsonValue at the boundary — the kernel, not the UI,
 * canonicalizes them for the fingerprint.
 */
export const RequestPermission: CommandDefinitionWithArgs<
  "RequestPermission",
  {
    requestId: typeof Schema.String
    tool: typeof Schema.String
    tier: typeof TierSchema
    argsSummary: typeof Schema.String
    provenance: typeof Schema.String
  },
  Effect.Effect<PermissionMsg, never, SafetyKernel>
> = defineCommand("RequestPermission", {
  args: {
    /** Correlation id: the permission request id, reused in every message. */
    requestId: Schema.String,
    tool: Schema.String,
    tier: TierSchema,
    /** JSON-encoded JsonValue of the canonicalized args. */
    argsSummary: Schema.String,
    /** Who/why this intent exists, e.g. "agent-loop:turn-42". */
    provenance: Schema.String,
  },
  messages: [Message.PermissionRequested, Message.PermissionAutoAllowed, Message.PermissionCheckFailed],
  interrupt: {
    keyFields: ["requestId"],
    toKey: ({ requestId }) => requestId,
  },
  execute: ({ requestId, tool, tier, argsSummary, provenance }) =>
    Effect.gen(function* () {
      const kernel = yield* SafetyKernel
      const at = Date.now()
      let args: JsonValue
      try {
        args = JSON.parse(argsSummary) as JsonValue
      } catch {
        // Fail closed on unparseable args: the kernel sees an empty object,
        // which the policy denies unless explicitly allowed.
        args = {}
      }
      const decision = yield* kernel
        .check({ tool: tool as ToolName, tier, args, provenance })
        .pipe(
          Effect.catchTag("PermissionDenied", (e) =>
            Effect.succeed(
              Message.PermissionCheckFailed({
                requestId,
                denied: true,
                reason: e.reason,
                at,
              }),
            ),
          ),
        )
      // `decision` is either the failure message or the kernel's Decision.
      if (typeof decision !== "string") return decision
      return decision === "allow"
        ? Message.PermissionAutoAllowed({ requestId, at })
        : Message.PermissionRequested({
            requestId,
            tool,
            argsSummary,
            riskTier: tier,
            context: provenance,
            at,
          })
    }),
})

/* ------------------------------------------------------------------ */
/* PersistMemory                                                       */
/* ------------------------------------------------------------------ */

/**
 * Append one transcript entry to the JSONL session tree. Fire-and-forget by
 * design: success and failure both surface as Messages for the timeline.
 */
export const PersistMemory = defineCommand("PersistMemory", {
  args: {
    /** Correlation id back to the Message that produced this command. */
    correlationId: Schema.String,
    sessionId: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String,
  },
  messages: [Message.MemoryPersisted, Message.MemoryPersistFailed],
  execute: ({ correlationId, sessionId, role, text }) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService
      yield* memory.append(sessionId, {
        parentId: null,
        kind: "message",
        payload: { role, text },
      })
      return Message.MemoryPersisted({ correlationId })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          Message.MemoryPersistFailed({
            correlationId,
            reason: Cause.pretty(cause).slice(0, 300),
          }),
        ),
      ),
    ),
})
