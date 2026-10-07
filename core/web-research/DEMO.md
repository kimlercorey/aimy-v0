# M4 Track 3 demo — `research <query>` through the module seam

**Date:** 2026-10-07 · **Harness:** `aimy-chat` (`chat/src/index.ts`) with the M4
Track 3 extension (`chat/src/research.ts`, `chat/src/stack.ts`,
`chat/src/render.ts`).

This is a **real transcript** from a live run — the only edits are stripping
readline ANSI escapes and trimming the 400-char claim excerpts (marked
`[…trimmed for readability…]`). Nothing else was altered.

**Network honesty:** this demo is the *only* place live network is used. The
research module hit the real DuckDuckGo HTML endpoint
(`https://html.duckduckgo.com`, the one static host its SKILL.md allowlists)
and fetched three real result pages. Every unit/integration test
(`m4-wiring.test.ts`, `chat/test/chat.test.ts`, `web-research/test/*`) uses a
mock HTTP layer — no test opens a socket.

**Model honesty:** no model server was running (see the preflight warning).
The `research <query>` command does not need the model — it routes through
the module seam directly (`ModuleHost.callTool`), which is exactly what this
demo proves.

## What the transcript proves

1. **`research X` → sourced answer with verification badges.** The module was
   installed from its real `SKILL.md` (`packageModule`, tier T1), enabled,
   and started at boot. Each query ran the full seam: manifest check →
   `beforeToolCall` (arg validation) → `DirectGate` execution → claims
   recorded in the shared `HonestyService` ledger → per-claim badges rendered
   inline (`✓ verified [source url]` / `? unverified`).
2. **True mid-run disable → hooks stop firing, no residue.** The first
   research ran in the background; `/research-off` was issued ~1.5s later,
   *while the module was fetching sources*. The in-flight research still
   completed (in-flight execution is not killed — only hook dispatch stops),
   but its trailing `afterToolCall` hook never fired:
   `beforeToolCall=1 afterToolCall=0`, and `runtime: []`. A subsequent
   `research` while disabled failed with a clean typed `ModuleError` — no
   hang, no silent no-op. `/research-on` restored the module and hooks fired
   again (`beforeToolCall=2 afterToolCall=1`).

## Transcript

```
AImy chat — booting the stack…
⚠️  nothing listening at http://127.0.0.1:11434
   start your local model first — `ollama serve` (Ollama) or `llama-server -m <model.gguf>` (llama.cpp)
   (you can start it in another terminal; this chat will keep trying)
connected: http://127.0.0.1:11434 · model m4demo · session "m4demo"
research module "web-research" installed+started (tier T1, egress: html.duckduckgo.com)
type a message, `research <query>`, or /help

you> research what is the Effect TypeScript library
🔍 researching "what is the Effect TypeScript library" through the module seam…
you> /research-off
research module disabled — hooks fired so far: beforeToolCall=1 afterToolCall=0; runtime: []
```

The disable landed **mid-run** — the research below was already in flight
(`beforeToolCall` had fired; sources were being fetched). It completed, but
note the hook counters after it: `afterToolCall` stayed at 0.

```
Research: "what is the Effect TypeScript library" — fetched 3 of 10 results
✓ verified [https://effect.website/] — According to "Effect | Production Grade TypeScript" (https://effect.website/): Effect | Production Grade TypeScript Skip to content Effect 4.0 is here. One ecosystem. Zero dependencies. Docs Play Blog Podcast Jobs Community Effect Days Men[…trimmed for readability…]
✓ verified [https://github.com/Effect-TS/effect] — According to "GitHub - Effect-TS/effect: Build production-ready applications in TypeScript" (https://github.com/Effect-TS/effect): GitHub - Effect-TS/effect: Build production-ready applications in TypeScript · GitHub Skip to content Navigation Menu Sign in Appearance settings Platform AI CO[…trimmed for readability…]
✓ verified [https://effect.plants.sh/] — According to "Effect v4 Documentation | Effect" (https://effect.plants.sh/): Effect v4 Documentation | Effect Skip to content Effect Search Ctrl K Cancel GitHub Discord X Select theme Dark Light Auto Effect v4 Documentation The missing s[…trimmed for readability…]
? unverified — Fetched 3 of 10 search results for "what is the Effect TypeScript library".
? unverified — Synthesis across 3 fetched source(s) for "what is the Effect TypeScript library" — see the sourced statements above; this synthesis itself is unverified.
[research] hooks fired: beforeToolCall=1 afterToolCall=0
```

Research while disabled → clean typed error (not a hang, not a silent no-op):

```
you> research what is the Effect TypeScript library
🔍 researching "what is the Effect TypeScript library" through the module seam…

⚠️  ModuleError: module is 'disabled', not active
```

Re-enable → the module recovers with no residue, hooks fire again:

```
you> /research-on
research module enabled — runtime: [web-research]
you> research what is the Effect TypeScript library
🔍 researching "what is the Effect TypeScript library" through the module seam…
Research: "what is the Effect TypeScript library" — fetched 3 of 10 results
✓ verified [https://effect.website/] — According to "Effect | Production Grade TypeScript" (https://effect.website/): Effect | Production Grade TypeScript Skip to content Effect 4.0 is here. One ecosystem. Zero dependencies. Docs Play Blog Podcast Jobs Community Effect Days Men[…trimmed for readability…]
✓ verified [https://github.com/Effect-TS/effect] — According to "GitHub - Effect-TS/effect: Build production-ready applications in TypeScript" (https://github.com/Effect-TS/effect): GitHub - Effect-TS/effect: Build production-ready applications in TypeScript · GitHub Skip to content Navigation Menu Sign in Appearance settings Platform AI CO[…trimmed for readability…]
✓ verified [https://effect.plants.sh/] — According to "Effect v4 Documentation | Effect" (https://effect.plants.sh/): Effect v4 Documentation | Effect Skip to content Effect Search Ctrl K Cancel GitHub Discord X Select theme Dark Light Auto Effect v4 Documentation The missing s[…trimmed for readability…]
? unverified — Fetched 3 of 10 search results for "what is the Effect TypeScript library".
? unverified — Synthesis across 3 fetched source(s) for "what is the Effect TypeScript library" — see the sourced statements above; this synthesis itself is unverified.
[research] hooks fired: beforeToolCall=2 afterToolCall=1
you> /quit
bye
```

## Reproduce

```sh
cd ~/workspace/aimy/core
npm run chat -- --model <name> [--base-url <url>] [--session <id>]
```

Then type `research <query>`. `/research-off` disables the module (mid-run
safe — in-flight hook dispatch stops immediately, runtime entry torn down);
`/research-on` re-enables and restarts it. `/help` lists all commands.

The scripted version of the transcript above (timed stdin via coproc) is not
checked in — it was a one-off driver; the behavior it demonstrates is covered
by `m4-wiring.test.ts` (mocked network) and `chat/test/chat.test.ts`.
