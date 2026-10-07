# AImy

**The elephant in the room:** yes, another AI assistant — and the local-first premise isn't unique anymore. OpenClaw runs local. Hermes ran local. The idea that the model is interchangeable plumbing and the value is everything around it is shared with the best open projects.

AImy exists because those projects keep failing at the same things: agents that hallucinate without consequence, self-improvement loops that grade their own homework, personalities that are performed rather than computed, memory that silently corrupts. We spent the teardown phase studying exactly how Pi and Hermes failed — and built the mechanisms that answer each failure. That's the bet: not a different premise, different machinery.

## Who cares, and why

- **Technical enthusiasts** who want an all-purpose, deeply configurable desktop companion they can grow — not a chatbot, a platform.
- **Anyone burned by cloud AI**: the price hikes, the quiet model swaps, the "we've updated our privacy policy" emails, the features that vanish overnight.
- **People who've watched agents confidently hallucinate** and want the receipt, not the apology.

If none of that stings, this probably isn't for you. That's fine.

## What makes it different

**1. Local-first that's real, not marketing.**
Zero-socket boot — it runs fully offline. No account, no API key, no telemetry, no phone-home. Bring your own model (Ollama, llama.cpp, LM Studio). Air-gap it if you want. Sovereignty here means control and exit, not a slogan.

**2. Honesty is structural, not a prompt.**
Every claim the system makes carries a badge — *verified*, *unverified*, or *failed* — backed by an evidence ledger and executable judges. This isn't "please don't hallucinate" in a system prompt. It's architecture: there is no code path that produces a verified badge without evidence.

**3. Presence, not performance.**
The ASC engine computes four dials — warmth, playfulness, intensity, vulnerability — from actual conversation content and system state. Computed, never chosen; there is a test proving no code path can set them directly. An error term keeps the system's model of its own abilities calibrated against its real track record, and a guard flags impression management. No other assistant has this.

**4. Sovereignty = ownership + exit.**
One-click export of everything — memory, skills, identity, learning history — as a verified bundle with an integrity receipt you can check independently. "No one can take it from you" only means something if *you* can take all of you, trivially.

**5. It gets better without getting dangerous.**
The learning loop lets AImy improve from experience — but new skills clear a verification arm with executable evidence. Promoting a skill on a model's say-so alone isn't against policy; it's a *type error*. Structurally impossible, not discouraged.

## What it's not

- **Not a frontier-model competitor.** The model is borrowed; the soul is owned. AImy will happily run whatever weights you give it.
- **Not a cloud service.** There is no server to sign up for, no tier to subscribe to.
- **Not finished.** This is v0 — the engine is built and tested (723 tests, fully typechecked), the desktop shell is landing now.

## The stack

- `core/` — sovereign foundation libraries (TypeScript + Effect): substrate, permission-kernel, memory, inference-pool, asc-engine, module-seam, identity, agent-loop, honesty, learning, jobs, comms, export, web-research.
- `architecture/` — system architecture v1.0.
- `decomposition/` — Pi + Hermes agent teardown: harvest map + pitfalls checklist.
- `planning/` — MVP MoSCoW v1.0 (locked scope contract).

## Run it

```sh
git clone git@github.com:kimlercorey/aimy-v0.git
cd aimy-v0/core
npm install
npm run chat -- --model <your-model> --base-url http://127.0.0.1:11434
```

Bring your own local model server (Ollama, llama.cpp, LM Studio, or anything serving OpenAI-style `/v1/chat/completions`). See `core/CHAT.md` for details.

## Status

17 of 18 MVP Musts built and pushed. The desktop shell (the last one) is in progress. See `planning/mvp-moscow.md` for the scope contract.
