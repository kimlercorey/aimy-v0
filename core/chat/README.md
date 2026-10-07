# chat — the `aimy-chat` terminal harness

The first thing you can type into. Thin REPL over the production-shape stack:
`SafetyKernel → PermissionGate → MemoryService → InferencePool + LocalHttpProvider → ModuleHooks → AgentLoop (+ HonestyService)`.

No new product surface, no TUI framework. `tsx` runs the TypeScript directly.

## Run it

```sh
cd aimy-v0/core
npm install
npm run chat -- --model <name> [--base-url <url>] [--session <id>]
```

- `--model` (or `AIMY_MODEL` env): model name on your local server. Required.
- `--base-url`: chat-completions endpoint. Default `http://127.0.0.1:11434` (Ollama).
  llama.cpp-server listens on `http://127.0.0.1:8080` — pass `--base-url` for it.
- `--session`: resume a named session. Default `"default"` — conversations
  persist across restarts in `~/.aimy/memory/sessions/`.

If no model server is listening, you get a clean message telling you how to
start one (`ollama serve` / `llama-server -m <model.gguf>`) — never a stack trace.

## In the chat

```
you> what time is it
AImy: The time is:
```aimy-tool
{"tool":"clock.now","args":{}}
```
🔧 clock.now → 2026-10-07T12:15:40.601Z

[honesty] ✓ verified: "clock.now returned 2026-10-07T12:15:40.601Z"
[judge] tool-success-matches-side-effects@1.0.0: PASS
[judge] no-undeclared-side-effects@1.0.0: PASS
[judge] claim-has-evidence@1.0.0: PASS
```

Commands: `/new` (fresh session) · `/quit` · `/help` · `/research-off` · `/research-on`. Ctrl+D also exits cleanly.

## Research (M4)

Type `research <query>` for a sourced answer with per-claim verification
badges, routed through the module seam (`ModuleHost.callTool` → the
`web-research` module, tier T1): the module is installed from its real
`SKILL.md` at boot, its `beforeToolCall`/`afterToolCall` hooks fire through
the seam's dispatch, and every claim lands in the shared `HonestyService`
ledger — sourced claims badge `✓ verified [source url]`, the module's own
synthesis/coverage badge `? unverified`. `/research-off` disables the module
(mid-run safe: in-flight hook dispatch stops immediately, runtime entry torn
down); `/research-on` re-enables and restarts it. A research while disabled
fails with a clean typed `ModuleError`. See `../web-research/DEMO.md` for a
real transcript (live DuckDuckGo; tests always mock the network).

## Layout

| File | Contents |
|---|---|
| `src/index.ts` | Entry: arg parsing, preflight, REPL. |
| `src/stack.ts` | Production-shape Layer composition (additive wiring only). |
| `src/args.ts` | Pure arg parsing (`parseArgs`). |
| `src/render.ts` | Pure rendering: commands, honesty summary, friendly errors. |
| `test/chat.test.ts` | 14 tests: plumbing units + acceptance vs. a mock endpoint. |
