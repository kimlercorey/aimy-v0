# Bundle Architecture — Design Document

**Date:** 2026-10-11  
**Status:** Design approved. Not yet implemented.  
**Target location:** `/Users/kc/aimy-v0/core/bundles/DESIGN.md`

## Problem

AImy needs more than skills. A skill is "she knows how to do X." But for
real collaboration, you need the full loop: she acts (tools), the user sees
(display), the user interacts (drawer), she responds (skill). The bundle
ties these together into a single unit.

The right-hand drawer serves as an all-purpose collaboration space — not just
a display, but a third participant where both parties shape shared artifacts.

## Bundle Hierarchy

Bundles are the parent. Tools, skills, and interfaces are children:

```
Bundle (the unit of capability)
├── Skill     — what she knows ("I can show you charts")
├── Tools     — what she can do (drawer.preview, drawer.execute)
└── Interface — how it displays (drawer widget, app, panel)
```

A skill alone is "she knows how to do X." A bundle is "she knows how to do
X, has the tools to do it, and there's a shared space where you both see
and touch the result."

## Build Order

1. **Bundle registry + types** (the contract) — nothing else has a shape
   without this
2. **Drawer + spaces** (the runtime) — bundles need somewhere to live
3. **tool.create gating** — last, because a created tool should land inside
   a bundle, not float free. Without the harness, dynamic tools have no
   display, no state proxy, no lifecycle.

Do not build tool.create gating until the bundle harness exists.

## Core Concept: The Bundle

A bundle is four things:

### 1. Manifest (the contract)

```typescript
interface BundleManifest {
  id: string;                 // "preview", "execute"
  name: string;               // Human-readable
  version: string;
  skills: string[];           // What she knows how to do with this
  tools: string[];            // Tool names this bundle provides
  render: Component;          // Drawer UI component

  preferredSlot?: number;     // Wants this slot, but flexible
  demandedSlot?: number;      // Must have this slot or won't run

  observesTopic: boolean;     // React to topic changes?
  preferences: Record<string, unknown>; // Persistent across sessions
}
```

### 2. State Proxy (the collaboration layer)

Shared mutable state. Neither party owns it; both affect it through the proxy.

```typescript
interface BundleState {
  get<T>(key: string): T;
  set(key: string, value: unknown): void;
  subscribe(listener: (change: StateChange) => void): Unsubscribe;
}
```

- User zooms a chart in the drawer → `proxy.set("zoom", 2.0)` → she sees it
- She highlights data → `proxy.set("highlight", "Q3")` → drawer updates
- Another widget reads the state → cross-widget collaboration

Changes propagate to all subscribers. The proxy is the collaboration mechanism.

### 3. Workspace Slots

Configurable number of simultaneous widgets. Starting with 2.

- Slot 0: Preview prefers here (visual content)
- Slot 1: Execute prefers here (code/output)
- `preferredSlot`: bundle wants this slot but can go elsewhere
- `demandedSlot`: bundle MUST be in this slot or it doesn't run
- If preferred slot occupied → next available
- If demanded slot occupied → bundle waits or replaces (configurable)

### 4. Lifecycle

- **Drawer closed** → hidden but still running (like minimizing a window).
  State preserved, subscriptions active.
- **Bundle closed** → terminated, state cleaned up (like quitting an app).
  Unless `persistent: true`.
- **Topic change** → if `observesTopic: true`, bundle receives
  `onTopicChange(newTopic)` and decides: update, reset, or ignore.
- **Preferences** → stored per bundle ID, survive across sessions.
  Widgets can have persistent variables and preferred/demanded workspace location.

## Starting Bundles

### Preview

- **Skill:** "I can show you visual content in the drawer"
- **Tools:** `drawer.preview` (args: `{ content, type: 'image'|'markdown'|'html'|'data' }`)
- **Display:** Renders content type appropriately
- **State:** `{ content, type, zoom, scrollPosition }`
- **Slot:** Flexible (any available)

### Execute

- **Skill:** "I can run code and show you the output"
- **Tools:** `drawer.execute` (args: `{ code, language }`), `drawer.repl`
- **Display:** Code editor + output panel
- **State:** `{ code, language, output, isRunning, history }`
- **Slot:** Prefers slot 1

## Directory Layout

```
core/bundles/
  ├── DESIGN.md           # This file
  ├── registry.ts         # Bundle registration, lookup, instantiation
  ├── state-proxy.ts      # Shared state proxy implementation
  ├── workspace.ts        # Slot management
  ├── types.ts            # BundleManifest, BundleInstance, etc.
  ├── preview/
  │   ├── manifest.ts
  │   ├── skill.md        # AI skill description
  │   ├── tools.ts        # drawer.preview implementation
  │   └── view.tsx        # Drawer render component
  └── execute/
      ├── manifest.ts
      ├── skill.md
      ├── tools.ts        # drawer.execute, drawer.repl
      └── view.tsx        # Editor + output
```

## The Collaboration Loop

1. User: "Show me that chart"
2. AImy (via skill): calls `drawer.preview` with chart data
3. Proxy: state set → drawer renders in slot 0
4. User: zooms into Q3 in the drawer → proxy updates
5. AImy (subscribed): sees the zoom change → "Want me to highlight the anomaly?"
6. AImy: `proxy.set("highlight", "Q3")` → drawer updates live

Neither party owns the artifact. Both shape it through the proxy.

## Design Decisions (Kimler-specified 2026-10-11)

- **State ownership:** Handled by a proxy that both parties (and other widgets)
  can affect. Not owned by either side.
- **Concurrency:** Configurable number of simultaneous widgets. Starting with 2 spaces.
- **Drawer close:** Only hidden, still running (like minimizing).
- **Bundle close:** Like closing an app — terminated.
- **Topic change:** If the bundle contract includes topic observation,
  it impacts the application. Otherwise ignored.
- **Persistence:** Widgets can have persistent preferences/variables and
  preferred or demanded workspace location.
- **Drawer is generic:** It knows the bundle contract (render, interact, state
  schema), not specific bundles. New bundles added without touching drawer code.

## Future (not in scope)

- LLM-generated tool summaries for the introspection tooltips
- More than 2 workspace slots (configurable)
- Bundle marketplace / user-installable bundles
- Cross-session bundle state restoration
