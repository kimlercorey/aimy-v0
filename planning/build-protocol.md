# Build Protocol v0.1 (DRAFT — 2026-10-07)

The typed contract for predictable software builds: `[problem | spec] → documentation → code → evidence`.
One protocol, many clients: the AImy software-builder module, Forge2 Studio's Generate stage, open-code, and any future builder.

Status: **draft for review.** Nothing here is implemented; this document exists so the implementations converge instead of drifting.

## 1. Why a protocol, not a module

A module is code that runs inside one host. A protocol is a contract many hosts can speak. Kimler's goal — AImy instances, Forge2, and open-code all building software through the *same* predictable process — requires the contract first. The implementations (AImy module, Forge2 integration, open-code adapter) are then conformance work, not design work.

## 2. Principles

1. **Contract-first.** Every stage consumes a typed input and produces a typed output. No stage reads another stage's mind; no free-text handoffs between stages.
2. **Evidence-backed.** Every factual claim a stage makes (a requirement is satisfied, a gate passed, code matches spec) carries evidence or is labeled unverified. Borrowed from AImy's honesty layer: badges are `verified` / `unverified` / `failed`, derived from the ledger, never asserted.
3. **Deterministic where it matters.** Spec → documentation is derivation, not improvisation (cf. Forge2 Paper 3: specification-derived architecture). Nondeterminism (model generation) is confined to the code stage and fenced by verification.
4. **Fail-closed.** A stage that cannot verify its output does not pass it on. A failed gate is a finding, never silently repaired (Forge2's standing rule).
5. **Versioned.** The protocol is `build-protocol/0.1`. Clients declare the version they speak. Breaking changes bump the version; the old version keeps working.

## 3. The pipeline

```
┌─────────┐    ┌──────────────┐    ┌──────┐    ┌──────────────┐    ┌────────┐
│ problem │    │     spec     │    │ docs │    │     code     │    │ bundle │
│   or    ├─┬─►│  (contract)  ├─┬─►│(arch) ├─┬─►│  (generated) ├─┬─►│(shipp- │
│  spec   │ │  │              │ │  │      │ │  │              │ │  │ able)  │
└─────────┘ │  └──────────────┘ │  └──────┘ │  └──────────────┘ │  └────────┘
            │                   │           │                   │
            ▼                   ▼           ▼                   ▼
       spec.validate       docs.derive  code.generate     evidence.seal
```

### Stage 1 — `spec.validate`: problem → contract

- **Input:** a problem statement (free text) or a spec document (typed).
- **Output:** a `Spec` — typed, with requirements, constraints, acceptance criteria, and explicit non-goals. Every requirement has an id; every acceptance criterion is machine-checkable or labeled `human-check`.
- **Rules:** ambiguity is resolved by asking, not by guessing. An unresolvable ambiguity fails the stage with the question attached — it does not guess forward.
- **Evidence:** the spec itself is evidence for everything downstream; it is hashed and pinned (cf. AImy's PinRegistry — byte-identity across transforms).

### Stage 2 — `docs.derive`: contract → documentation

- **Input:** a validated `Spec`.
- **Output:** architecture/design documentation derived from the spec: component boundaries, data flows, interface definitions, dependency direction.
- **Rules:** derivation, not invention. Every doc section cites the spec requirement(s) it serves. A section with no parent requirement is flagged, not shipped.
- **Evidence:** each doc claim links to its spec requirement id (verified) or is marked unverified.

### Stage 3 — `code.generate`: documentation → code

- **Input:** derived docs + the pinned spec.
- **Output:** source code, contract-first: interfaces/types before implementations.
- **Rules:** this is the only stage where model nondeterminism is allowed, and its output is *always* treated as unverified until Stage 4. The generator may not skip the docs — code must trace to doc sections, which trace to spec requirements.
- **Evidence:** generation provenance (model, prompt hash, timestamp) is recorded. The code itself carries no badge until verified.

### Stage 4 — `evidence.seal`: code → verified bundle

- **Input:** generated code + docs + spec.
- **Output:** a `Bundle` — code, docs, and an evidence ledger.
- **The gate cascade** (Forge2's, adopted): contract gates → static gates → behavior gates → runtime gates. Plus AImy's executable judges as an independent verification arm: deterministic checks over final state, side effects, and claim resolution.
- **Rules:** a failed gate is a finding recorded in the ledger, never silently repaired. The bundle ships with its failures visible if the client accepts them explicitly — nothing is hidden.
- **Evidence:** the ledger. Every claim `verified` (evidence attached), `unverified` (no evidence), or `failed` (evidence contradicts). The bundle includes a `verifyBundle` procedure so a third party can check it independently (cf. AImy's one-click export).

## 4. The typed API

Version: `build-protocol/0.1`. Transport-agnostic — the same operations work in-process (AImy module), over the first-party LAN (paired instances), or over HTTPS (Forge2 Studio, open-code).

| Operation | Input | Output |
|---|---|---|
| `build.submit` | `Spec` (or problem text for Stage 1) | `buildId`, stage cursor |
| `build.status` | `buildId` | stage, per-stage state, gate results so far |
| `build.artifacts` | `buildId`, stage | typed artifacts for that stage |
| `build.verify` | `buildId` | re-run the gate cascade; full ledger |
| `build.cancel` | `buildId` | terminal state; partial artifacts preserved |

All operations are idempotent except `build.submit`. All errors are typed (`SpecInvalid`, `GateFailed`, `StageSkipped`, `BuildNotFound`) — never free-text failures.

## 5. Client bindings

- **AImy module (`software-builder`).** The in-process binding: a SKILL.md manifest declaring `tools: [build.submit, build.status, build.artifacts, build.verify, build.cancel]`, `subprocess: true` (T2/T3 — sandboxed execution), `network: {}` (no egress needed; the builder is local). This is the reference implementation.
- **Forge2 Studio.** Its Generate stage is re-pointed at the protocol: Formulate/Optimize/Roadmap produce the `Spec`; `build.submit` replaces the string-patch repair fabric; Execute/Evidence consume the bundle's ledger. The failed-gate-is-a-finding rule is already Forge2's — the protocol just gives it a typed home.
- **open-code.** An API client binding: open-code drives `build.submit` / `build.status` like any other client. No fork of open-code required if the transport is HTTP; a plugin if deeper integration is wanted.
- **Other AImy instances.** Over the first-party network (§4.11: paired instances, UUID identity). Same operations, same types.

## 6. Execution environment

Code execution (Stage 3 generation harnesses, Stage 4 gate runs) happens inside the sandbox backend — the honest-stub area (MoSCoW #10). Until real backends land, `code.generate` and `evidence.seal` run in-process with the capability manifest enforced and network denied; the bundle's ledger records the sandbox level honestly (`sandbox: none (stub)` vs `sandbox: seatbelt/macos`, etc.). The IronProxy pattern (opaque tokens in-sandbox, real keys swapped at the boundary) is adopted for when execution needs network-adjacent resources.

## 7. Open decisions

1. **Transport for cross-instance/cross-tool use.** HTTP+JSON is the default candidate; the operations are transport-agnostic by design, but one transport must be chosen for v0.1.
2. **Spec schema versioning.** The `Spec` type will evolve; the protocol version covers the operations, but the spec schema needs its own versioning story.
3. **Human-check criteria.** Acceptance criteria labeled `human-check` need a defined handoff (who checks, where the verdict lands in the ledger).
4. **Deterministic docs derivation.** Stage 2's "derivation, not invention" needs teeth — likely a structural check that every doc section cites a requirement id. The exact mechanism is open.
5. **Relationship to AImy's learning loop.** Successful builds are experience; the quarantine→verification→trusted pipeline could promote build patterns to skills. Explicitly out of v0.1, noted for later.

## 8. What v0.1 does NOT include

- The sandbox backends themselves (MoSCoW #10 — separate work).
- First-party LAN pairing (MoSCoW Could — separate work).
- The AImy module implementation, Forge2 integration, or open-code adapter (conformance work after the protocol is accepted).
- Training or shipping model weights (Won't — the builder is model-agnostic; the model is a parameter, not the product).
