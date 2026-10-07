# Building AImy for macOS

> **Plain statement:** the macOS build was *configured* but **NOT executed here**.
> No Mac was available in the build environment (Linux container), so the
> `.dmg` / `.zip` targets below are untested. The Linux AppImage from the same
> `electron-builder.yml` was built and smoke-tested (see `smoke/`).

## Prerequisites

- macOS 12+ (Apple Silicon or Intel — `electron-builder` produces the arch
  it runs on; use `--x64` / `--arm64` to cross-build, see below)
- Node.js 20+ and npm 10+
- Xcode Command Line Tools (`xcode-select --install`) — needed for code signing

## Steps

```sh
# 1. Clone
git clone https://github.com/kimlercorey/aimy-v0.git
cd aimy-v0/core

# 2. Install (uses the npm overrides that pin foldkit's effect peer deps)
npm install

# 3. Build + package for macOS
npm run dist -- --mac
```

`npm run dist` runs, in order:

1. `npm run build` — `tsc -b` (emits `dist/`, must stay fully clean)
2. `npm run desktop:assets` — copies `web-retrieval/SKILL.md` into
   `dist/web-retrieval/` (the engine reads it at runtime; `tsc` does not copy
   non-TS files)
3. `npm run desktop:preload` — esbuild-bundles `desktop/src/preload.ts` to
   `dist/desktop/src/preload.cjs` (Electron does not support ESM in sandboxed
   preloads, hence the `.cjs`)
4. `vite build --config desktop/vite.config.ts` — the renderer bundle to
   `dist/desktop/src/renderer/`
5. `electron-builder --config desktop/electron-builder.yml --mac`

## Output

- Disk image: `core/desktop/release/AImy-<version>-mac-<arch>.dmg`
- Zip (for Sparkle-style/manual distribution): `core/desktop/release/AImy-<version>-mac-<arch>.zip`

(`<version>` comes from `core/package.json`; `<arch>` is `x64` or `arm64`.)

To build a specific arch explicitly:

```sh
npm run dist -- --mac --x64      # Intel
npm run dist -- --mac --arm64    # Apple Silicon
```

## Signing & notarization

The shipped `electron-builder.yml` sets `publish: null` (no auto-update, no
phoning home) and does **not** configure signing — the `.dmg` it produces is
**unsigned**. On first launch macOS Gatekeeper will block it; the user must
right-click → Open, or you must sign it.

### Ad-hoc signing (local testing only)

```sh
codesign --deep --force --sign - "desktop/release/AImy-<version>-mac-<arch>.dmg"
```

Ad-hoc signatures do **not** satisfy Gatekeeper on other machines.

### Developer ID (distribution)

1. Enroll in the Apple Developer Program; create a **Developer ID Application**
   certificate in Xcode.
2. Add to `desktop/electron-builder.yml` under `mac`:
   ```yaml
   mac:
     target: [dmg, zip]
     identity: "Developer ID Application: <Your Name> (<TEAMID>)"
     hardenedRuntime: true
     entitlements: desktop/entitlements.mac.plist
     entitlementsInherit: desktop/entitlements.mac.plist
   ```
   (The entitlements file does not exist yet — create it; the app needs no
   special entitlements beyond the hardened-runtime defaults.)
3. Notarize (required since macOS 10.15 for first-launch without a warning):
   ```sh
   xcrun notarytool submit "desktop/release/AImy-<version>-mac-<arch>.dmg" \
     --apple-id "<you@example.com>" --team-id "<TEAMID>" \
     --password "<app-specific-password>" --wait
   xcrun stapler staple "desktop/release/AImy-<version>-mac-<arch>.dmg"
   ```
   `electron-builder` can do this automatically via the `notarize` config
   with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars;
   that wiring is intentionally left out until someone with a Mac validates it.

## What was verified (Linux) vs not (macOS)

| Check | Linux | macOS |
|---|---|---|
| `npm run dist` produces an installer | ✅ AppImage + deb built | ❌ not run |
| App launches, window opens | ✅ under `xvfb-run` | ❌ not run |
| Chat streams end-to-end (stub model) | ✅ | ❌ not run |
| ASC dials render | ✅ | ❌ not run |
| Export wizard → verified receipt | ✅ | ❌ not run |
| Screenshot | ✅ `desktop/smoke/smoke.png` | ❌ |
| Code signing / notarization | n/a | ❌ not configured |

## First-run behavior (both platforms)

On first launch the main process creates `~/.aimy/desktop.json` with Splash
defaults (`baseUrl` → local model, `model` name). The onboarding slice
collects the endpoint URL and persists it via `config.set`; the model name is
preserved from the existing config. No network calls are made except to the
configured model endpoint (verified on Linux by sampling the app's TCP peers
during the smoke test — all loopback).
