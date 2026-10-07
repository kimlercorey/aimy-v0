# M10 Track 1 — Desktop shell framework decision: Electron

**Date:** 2026-10-07 · **Status:** locked for M10 · **Author:** Track 1

## Decision

**Electron.** The M8 Foldkit shell becomes a real launchable app on Electron.

## The honest evaluation

The core question is where the AImy Effect engine runs. The engine is a
TypeScript+Effect program with zero-fork reuse mandated (`core/chat/src/stack.ts`
`buildChatStack` is used as-is, not reimplemented).

| Criterion | Electron | Tauri |
|---|---|---|
| Engine hosting | **Native.** The Electron main process *is* Node. The engine boots in-process: `Layer`s, `Stream`s, fibers, `fs`/`net`/SQLite usage all work unchanged. Zero re-architecture, zero engine fork. | **Hostile.** Tauri's backend is Rust. Hosting the engine means either (a) a Node sidecar process — in which case Tauri buys nothing, since we still ship, secure, and audit a Node runtime, *plus* a Rust backend to secure — or (b) porting the entire core to Rust — a full rewrite, explicitly out of scope. |
| IPC fidelity | Effect `Stream<ChatChunk>` adapts to `AsyncIterable` in-process; structured data crosses `ipcMain`/`contextBridge` with Electron's structured clone (real typed objects, not JSON strings). | A sidecar forces everything through stdout/JSON-RPC serialization: streaming tokens, interrupt signals, typed errors all become hand-rolled protocol work. |
| Trust boundaries | One host process: the main process owns the engine and the sandbox boundary; the renderer's only power is `contextBridge`-exposed, allowlisted calls. Auditable in one language. | Two runtimes (Rust backend + Node sidecar) = two trust boundaries, two sandboxes, two update stories. More moving parts, not fewer. |
| Attack surface | **Larger.** Chromium + Node in the shell. This is the real cost, mitigated by the posture below — acknowledged, not hand-waved. | **Smaller.** System webview + Rust backend is the honest win for Tauri. |
| Binary size / footprint | ~150 MB, higher idle memory. | ~10–20 MB, leaner. |
| Team velocity | One substrate end to end (TS+Effect: engine, IPC contract, preload, renderer). No FFI, no second build toolchain. | Rust knowledge required; sidecar debugging is two-process debugging. |
| Sovereignty posture (MUST 17, mvp-moscow.md) | No telemetry, no auto-updater, no remote content — enforced in `main.ts` by omission. We simply don't install `electron-updater` and don't add a network call. Local-first is a *non-feature* here: the default is already nothing. | Same posture achievable, but irrelevant once the engine can't live in the backend. |

## Why the Tauri advantages don't win

Tauri's smaller footprint and tighter attack surface are genuine. They lose
because they don't survive contact with the actual constraint: **the engine is
a Node program, full stop.** The whole AImy architecture (one Effect program,
composition-is-enforcement, `buildChatStack` reuse) is a bet on Node as the
runtime. A sidecar architecture would reintroduce exactly the kind of process-
boundary seam the architecture eliminated — and every Effect service would
need a serialization twin. That's not packaging; that's a rewrite with a
packaging label on it.

## Locked security posture (enforced in `src/main/main.ts`, not documented)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`
- Preload is the only bridge; `contextBridge` exposes only the IPC contract in `src/ipc/protocol.ts`
- Prod loads the local `file://` renderer bundle only; the dev server (`http://127.0.0.1:5173`) loads only when `AIMY_DEV=1` is explicitly set
- **No remote content ever** (CSP enforced via `onHeadersReceived`)
- **No auto-updater** (`electron-updater` is not installed — updates are staged, explicit, user-initiated per architecture §2.2)
- **No telemetry** — there is no network call in the shell; the only network the app makes is the model endpoint and declared module egress, both user-configured and local by default

## Open items (not Track 1)

- Renderer bundle build (vite → `dist/renderer/index.html`): Track 3 (scripts + electron-builder config)
- `src/preload.ts` (contextBridge against `src/ipc/protocol.ts`): Track 2
- IPC handler implementations (`src/ipc/handlers.ts`): Track 2
- Desktop config onboarding UI (collects the real model name into `~/.aimy/desktop.json`): Track 3
- XDG base dirs: architecture §1.2 mandates XDG dirs from day one; Track 1 uses `~/.aimy/desktop.json` per the M10 spec. **Follow-up: move desktop config to `XDG_CONFIG_HOME/aimy/desktop.json` (fallback `~/.config/aimy`)** — flagged here so it isn't lost (Pi #2870).
- Code signing / notarization for distributables: Track 3
