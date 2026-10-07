# @aimy/export — DataExport: verified one-click full export (MUST #16)

"No one can take it from you" requires *you* can take all of you, trivially.
`DataExport` is a **composed capability**: a single Effect program that walks
the five sovereign services through their **public interfaces only** and
packages everything into a verified bundle directory.

It is not a service (nothing new to trust with its own layer) and not a
backdoor reader (no direct file reads around `MemoryService` — the export
reads memory *through* the service, like every other consumer).

## What goes in / what stays out

**In the bundle:**

| Bundle path | Source (public API) | Content |
|---|---|---|
| `identity/identity.json` | `IdentityService.document` | Versioned, secret-free identity document (UUID, public key, displayName) |
| `memory/sessions/<id>.jsonl` | `MemoryService.listSessions` + `read` | Every session tree, original JSONL |
| `memory/stores/{profile,environment,skills}.json` | `MemoryService.listKeys` + `get` | Every kv entry in every namespace |
| `timeline/timeline.json` | `LearningTimeline.query({includeArchived:true})` | Every learning node, archived ones included |
| `modules/modules.json` | `ModuleHost.installedModules` | Module records: id, name, version, state, capability manifest, staged/previous versions, trust decisions |
| `skills/skill-index.json` | `ModuleHost.skillIndex` | Budget-capped skill index |
| `locker/locker-manifest.json` | `SecretLocker.manifest()` | Entry names + scopes + created-at ONLY |
| `secrets-to-reenter.json` | derived from the manifest | Per-secret re-entry prompts (names, never values) |
| `banner/<log>.json` | optional `BannerLogProvider` | Comms-banner log, only when wired in |
| `manifest.json` | — | The integrity receipt (see below) |

**Explicitly NOT in the bundle:** secret values (the canary test proves
absence), private key material (the Ed25519 private key stays sealed in the
locker vault), the encrypted vault file itself, OS-keychain items, caches,
and runtime temp state. The identity document is structurally incapable of
holding secrets (separate structural test in the identity lib).

## Verify-before-package

Every item is checksummed (SHA-256) **before** it is written:
`writeBundleFile` hashes the bytes first, then writes. The bundle closes with
`manifest.json`, the integrity receipt:

```jsonc
{
  "version": 1,
  "exportedAt": "2026-10-07T…",
  "instanceId": "<uuid>",
  "exporterVersion": "aimy-export/1.0.0",
  "files": { "identity/identity.json": "<sha256 hex>", … },
  "bundleHash": "<sha256 over the canonical receipt body>"
}
```

`bundleHash` covers the canonical receipt body (file keys sorted, compact
JSON, fixed field order) — packager and verifier must agree byte-for-byte.

## Independent verification

`verifyBundle(dir)` re-verifies **from disk**: it re-reads `manifest.json`
and every listed file, recomputes every hash, and checks

- the receipt parses and is structurally valid;
- every listed file exists and matches its recorded hash;
- no unexpected extra files are present (the receipt enumerates the bundle
  exactly);
- the bundle-level hash matches the recomputed one;
- no listed path escapes the bundle directory.

It shares no state with the packager — it doesn't even import it. Every
failure is a typed `ExportError` (`export:file-hash-mismatch:<path>`,
`export:bundle-hash-mismatch`, `export:unexpected-file:<path>`,
`export:receipt-invalid`, …). Flip one byte anywhere and verification fails
typed (tested).

**Threat model note:** the receipt gives *tamper evidence* for a bundle you
produced, not authenticity against a malicious producer — a forged receipt is
self-consistent by construction. Authenticity (signing the receipt with the
instance key) is future work.

## Format decision: plain directory, not zip

The bundle is a **plain directory + `manifest.json`**, not a zip. Rationale:

- human-inspectable and diffable — the sovereignty thesis made visible;
- zero dependencies (a hand-rolled zip writer is exactly the kind of
  subtle-format code this codebase avoids);
- a zip is just this directory compressed — the user compresses it
  themselves when they need transport.

## Locker discipline (structural)

This module never calls `SecretLocker.retrieve` or `store`. The only locker
API it touches is `manifest()`, whose return type (`SecretManifestEntry`)
has no value field to read — there is no code path in this module that can
observe a secret value. Tests assert:

- a seeded canary value appears nowhere in the bundle bytes;
- the manifest entries are exactly `{name, scope, createdAt}`;
- `secrets-to-reenter.json` carries names + prompts only.

## Composing it

```ts
import { exportData, verifyBundle } from "./index.js"

const summary = yield* exportData(
  { outDir: "/tmp/aimy-export" },
  banner /* optional BannerLogProvider */
) // requires IdentityService, MemoryService, SecretLocker, ModuleHost, LearningTimeline

const receipt = yield* verifyBundle("/tmp/aimy-export") // independent, no services needed
```

The `BannerLogProvider` seam (`{ bundlePath, readLog }`) lets the export
include the comms-banner log without depending on the banner service. When
no provider is passed, the banner section is simply omitted.

## Interface extensions this track added

To let the export walk the services without bypassing them, three small
public-interface additions were made (all gate-checked, all documented at
the declaration site):

- `MemoryService.listSessions()` / `listKeys(ns)` — enumeration the export
  needs; reads go through the `PermissionGate` like every other op.
- `ModuleHost.installedModules()` — module records via the lifecycle's
  public `list()`, sorted by moduleId for deterministic bundles.
- `SecretLocker` manifest entries gained `createdAt` (unix-ms, set on first
  store, preserved across rotations; older vault entries read as `0`).
  The identity lib's manifest test was updated to the new shape.

## Tests

`export.test.ts` (9 tests): full round-trip against the real services over
temp dirs (identity stack + memory + locker + module host with an installed
module + timeline); independent receipt verification; tamper → typed failure
(flipped data byte, tampered file hash, tampered receipt body, added file);
canary-absent; manifest-only locker; re-entry prompts.
