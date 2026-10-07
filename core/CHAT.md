# AImy chat — run it on your Mac

The first runnable piece of AImy: a terminal chat that streams from your
local model through the whole stack (permissions → memory → inference pool →
agent loop → honesty judges).

## 1. Clone and install

```sh
git clone git@github.com:kimlercorey/aimy-v0.git
cd aimy-v0/core
npm install
```

Requires Node 20+ (built and verified on Node 24).

## 2. Start your local model

**Ollama** (default endpoint `http://127.0.0.1:11434`):

```sh
ollama serve
ollama pull llama3.1   # or whatever model you want, in another terminal
```

**llama.cpp** (endpoint `http://127.0.0.1:8080`):

```sh
llama-server -m <model.gguf>
```

## 3. Chat

```sh
# Ollama:
npm run chat -- --model llama3.1

# llama.cpp (note the base-url):
npm run chat -- --model default --base-url http://127.0.0.1:8080

# resume a named session later:
npm run chat -- --model llama3.1 --session work
```

Type a message, watch the tokens stream. Tool calls print as they execute
(`🔧 clock.now → …`), and every turn ends with the honesty summary:
per-claim badges (`✓ verified` / `? unverified` / `✗ failed`) plus the
executable-judge verdicts. Commands: `/new` · `/quit` · `/help`.

Conversations persist across restarts in `~/.aimy/memory/sessions/`.

## 4. Verify the build (optional)

```sh
npm test        # 919 tests, all green
npm run build   # typecheck, clean
```

If the model server isn't running when you start the chat, you'll get a
plain-English message telling you how to start it — not a stack trace.
