# Projects — the container model (design, 2026-10-12)

*Status: design for build. Kimler's directions (2026-10-12): Projects are user-declared containers holding related chats, assets, goals, requests, and research runs; one project is Default; declared intention binds assets; AImy may suggest a project, never create one unasked. Research binds to projects via Extension v0.3 of the deep-research charter.*

## Why now

Phase I deferred Projects for one reason: "the attribution problem ('one chat, three projects') is real and hard" (phase-i-workplan.md). The resolution is below: the chat was never the unit of attribution — the artifact is.

## Current state (survey, 2026-10-12)

No Project entity exists in AImy today: no type, store, IPC, panel, or `projectId` on any record. Identity is fragmented — chats are `sessionId`, drawer documents are space `id` + optional file `path`, capability requests are `capability + at` with one `sessionId`, knowledge cards are `slug`, background jobs carry `sessionId + turnId`. The curiosity lifecycle has a `project` status label, but it names no container.

## The model

Store — `~/.aimy/projects/` (travels with the user, like all AImy state):

```
~/.aimy/projects/
  index.json            { activeProjectId, projects: [{id, name, createdAt, status}], suggestions: [...] }
  <projectId>/project.json
  <projectId>/research/<runId>/...   (research run state — charter E14/E16)
```

```ts
interface Project {
  readonly id: string            // slug; "default" is reserved
  readonly name: string
  readonly purpose: string       // why this project exists — the reason work happens under it
  readonly isDefault: boolean
  readonly status: "active" | "archived"
  readonly createdAt: string     // ISO
  readonly chatSessionIds: ReadonlyArray<string>     // linked chats — many-to-many
  readonly assets: ReadonlyArray<ProjectAsset>
  readonly goals: ReadonlyArray<string>               // plain-language goal lines (v1: text, not a goal engine)
}
interface ProjectAsset {
  readonly kind: "document" | "paper" | "brief" | "research-run" | "request" | "card" | "file"
  readonly title: string
  readonly role: "precursor" | "deliverable" | "reference"
  readonly path?: string          // repo-relative file, when the asset is a file
  readonly runId?: string         // when the asset is / came from a research run
  readonly requestKey?: string    // capability + at, for request assets
  readonly addedAt: string
  readonly originSessionId?: string
}
```

Assets are **references, not copies** — a paper stays one file on disk; the project knows it as a deliverable. `role` carries the project home's precursors-vs-deliverables split.

## The rules

1. **User-declared only.** A project exists because the user declared it — in the UI, or in chat ("start a project called X"), where her `project.create` call records his declaration. She never creates one unasked.
2. **Default always exists.** `default` is seeded on first use, cannot be deleted, and is the active project whenever none is declared. No work is ever unbound.
3. **Declared intention = active project.** Exactly one active project at a time. Assets produced while it's active — documents saved, papers, research deliverables, capability requests filed — register into its assets automatically. Declaring another project redirects the flow; stepping out returns to Default.
4. **Attribution at the artifact; chats link freely.** A chat links to every project it touches. Nothing about a chat is exclusive.
5. **Suggestion, never creation.** When project-shaped work accumulates in Default (v1 trigger: a research run started, or a paper/brief produced, while Default is active), she may suggest declaring a project — once per work thread, recorded in `index.json.suggestions` so she doesn't nag. Dismissal is free and final for that thread.

## AImy's awareness and tools

The loop injects one compact line into the system prompt (knowledge-index idiom): active project name + purpose + asset/run counts. Tools: `project.list`, `project.create {name, purpose}` (declaration only), `project.declare {id}` (set active; `"default"` steps out), `project.link` (link the current chat). Asset registration is host-side (save flow, research runs, capability requests stamp the active project), not model bookkeeping.

## Surfaces (v1 scope)

The drawer home panel gains the active project: name/purpose, its assets (precursors and deliverables), its running research with progress (charter E16), and a project switcher. Continue / Needs you / What she knows become project-scoped when a non-Default project is active. A full Projects navigation panel is the Phase II surface and is not v1.

**Naming guard:** drawer *spaces* (document panes) and *Projects* (workspaces) are different concepts. UI copy always says "project" in full for the container and never calls a drawer pane a project.

## Build order

1. Store + tools + prompt injection (`agent-loop/src/projects.ts`, Default seeding) — harness-tested first.
2. Host-side asset registration: drawer save flow, capability requests, research runs stamp the active project.
3. Drawer home: active-project section + switcher + scoped sections.
4. Research binding (charter E13) rides the research build.
