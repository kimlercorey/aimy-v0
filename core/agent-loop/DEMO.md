# M1 demo — the wired stack, running

Real transcript from an actual run of the production-shape M1 stack, captured
by `m1-wiring.test.ts` ("writes agent-loop/DEMO.md…") — nothing here is
hand-transcribed. The stack: real `SafetyKernel` →
kernel-backed `PermissionGate` → `MemoryService` → `InferencePool` with
one registered `LocalHttpProvider` → `ModuleHooks` (real kernel behind the
seam + a recording hook) → `AgentLoop`.

> Environment note: the HTTP endpoint below is a `node:http` mock
> implementing the OpenAI-ish `/v1/chat/completions` wire shape — JSON when
> `stream: false`, SSE `data:` chunks when `stream: true`. It stands in
> for a `llama.cpp-server` or Ollama endpoint (no local model server was
> available in this environment). The provider speaks the same wire shape
> both target servers expose, so swapping the mock for
> `http://127.0.0.1:8080` (`llama.cpp-server`) or
> `http://127.0.0.1:11434` (Ollama) is a `baseUrl` change only.

## Beat 1 — streaming chat

`AgentLoop.chat("demo", "what time is it")` — token deltas streamed live
through the provider's `stream()` surface and re-emitted as `Token`
chunks in order:

```
  Token  "The current time is:\n`"
  Token  "``aimy-tool\n{\"tool\":\"c"
  Token  "lock.now\",\"args\":{}}\n```"
  ToolCall  tool=clock.now result="2026-10-07T14:10:12.538Z"
  Done  text="The current time is:\n```aimy-tool\n{\"tool\":\"clock.now\",\"args\":{}}\n```"
          executed=1 blocked=0 parseFailures=0 terminated=false
```

## Beat 2 — tool call executes through the hooks

The model emitted an `aimy-tool` fenced block for `clock.now`. The hook
gate fired around the execution and the real kernel allowed it (T0):

```
hook trace: before:clock.now -> after:clock.now:Ok
```

The `ToolCall` chunk above carries the tool's real result — the actual
system clock at run time (`2026-10-07T14:10:12.538Z`) — and the turn report records
`executed.length === 1`, `blocked === []`. The loop never executes tools
itself; `ModuleHooks.runTurn` owns the gate.

## Beat 3 — network killed mid-turn

The mock server wrote one SSE chunk, then destroyed the socket with no
`[DONE]`. The chat stream terminated with the typed error — no hang, no
raw exception:

```
InferenceError { provider: "m1-http", reason: "transport failure [UND_ERR_SOCKET]: http://127.0.0.1:45325: fetch failed" }
```

This is the architecture §12 M1 demo contract: streaming chat with a local
model, tool calls executing through hooks, and a mid-turn network kill
surfacing a clean typed error.
