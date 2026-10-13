# AImy UI Workplan — A Detail Language, Applied

Source: "A Detail Language for AImy" (research report, 2026-10-12) — principles §1, token spec §2, current-UI anti-patterns §3, fork recommendations §4. Section references below (§2.1 etc.) point at that report. AImy's own research paper on the same brief is in flight; Parts 2+ absorb its findings when it lands. Part 1 is buildable now and does not depend on it.

How to work this plan: parts run in order; each task names the change, where it lives, and its acceptance test. A task is done when its acceptance line passes in the running app, not when the code compiles.

---

## Part 1 — Left navigation and the complete icon treatment

**Status: BUILT 2026-10-12 (pending build + UAT).** F1 tokens landed as CSS variables; the rail is Chat / Projects / Memory + a labelled "Platform" group (Presence, Jobs, Banners, Messaging, Sovereignty, Permissions, Export as secondary rows) + Settings in the footer — the Settings-as-one-door shape, expressed as a group in this panel architecture, with every panel one click away and selection derived solely from the active panel. Projects is a real destination rendering the drawer's home-data project section (switcher, create, purpose, goals, research, assets) and refreshes home data on entry via a dedicated shell message. Memory's body is the Timeline panel today; Journal/Knowledge sections join it in a later pass. All rail rows carry Lucide icons from the registry (11 new icons, rail size class enforced in CSS); the `◫` drawer toggle is now a Lucide panel icon; drawer copy says "documents", and the seeded project reads "Default project" everywhere it is labelled. Deviations from the letter of the tasks below: N1's mapping table is realised as the Platform group rather than separate Settings sub-pages; Export is a demoted row rather than a pure action (its panel is a working export UI).

### 1.0 Foundation the rest of Part 1 consumes

- [ ] **F1 — Land the token constants.** Add the §2.1 spacing scale (`--space-1: 4px` … `--space-12: 48px`), the §2.3 radius steps (4 / 8 / 12 / 16 / full), and the §2.5 state steps (hover layer +8%, pressed +10%, selected accent layer 10–14%, disabled content 38–50%) as CSS variables in the renderer stylesheet. Part 1 uses only these values; no new literal pixel values in navigation or icon code.
  - Acceptance: navigation and icon styles reference variables throughout; a grep for raw `px` values in the nav/icon rules finds only the token definitions themselves.

### 1A — Left navigation: from org chart to user model (§3.1, §3.2, §4 Fork 3)

Today the rail lists platform subsystems — Chat, Presence, Timeline, Jobs, Banners, Messaging, Sovereignty, Permissions, Export — as equal peers. The rail becomes four destinations the user actually thinks in:

| Destination | Holds |
|---|---|
| Chat | the conversation (home — §4 Fork 1) |
| Projects | project rooms: chats, documents, research runs, decisions per project |
| Memory | Timeline + Journal + Knowledge, as sections of one place |
| Settings | one door for all platform machinery (below) |

Where every removed item goes:

| Removed from rail | New home |
|---|---|
| Presence | Settings → "AImy" section (her control surface). Live presence state moves to the header strip (Part 2) |
| Timeline | Memory section |
| Jobs | Settings → "Activity" for now; graduates to the permanent activity record in Part 4 |
| Banners | Settings → "Notices" |
| Messaging | Settings → "Messaging" |
| Sovereignty | Settings → "Sovereignty" |
| Permissions | Settings → "Permissions" |
| Export | Not a place — an action: a button in Settings and in document menus |

- [ ] **N1 — Four-destination rail.** Rebuild the rail to the table above; wire each removed destination to its new home so nothing becomes unreachable.
  - Acceptance: rail shows exactly Chat, Projects, Memory, Settings; every former rail destination is reachable from its new home in ≤2 clicks; no dead ends, no orphaned panels.
- [ ] **N2 — Single-selection invariant (§3.2).** Selection is derived from the current route — one source of truth — so exactly one rail item is ever shown selected. (Today Chat and Permissions can highlight simultaneously, and the "where am I" signal contradicts itself.)
  - Acceptance: click through every destination and every Settings section; at no point are two items highlighted, and at no point are zero highlighted while a destination is open.
- [ ] **N3 — Rail item anatomy (§2.5).** Every item: icon + label, fixed geometry. Selected = accent layer 10–14% **plus** a left bar (a non-colour cue — state is never colour alone). Hover = content layer +8%, pressed +10%, no layout shift in any state. Focus-visible ring identical to every other control in the app.
  - Acceptance: item height and label position are pixel-identical across rest/hover/pressed/selected; the selected item is identifiable with colour removed (greyscale screenshot test).
- [ ] **N4 — Rail metrics on tokens.** Item hit target ≥28 px tall; icon-to-label gap `--space-1`; item padding `--space-2`/`--space-3`; group separation `--space-6`; panel padding `--space-4`.
  - Acceptance: measured values in the running app match the tokens; no off-scale spacing anywhere in the rail.
- [ ] **N5 — Rail ↔ workspace project relationship.** The rail's Projects is the destination; the in-chat project switcher (right panel) stays as the *active project* control. Both render the same project icon and name so the two never read as different concepts.
  - Acceptance: switch the active project in the right panel; the Projects destination reflects the same active project; no second, divergent project list exists.
- [ ] **N6 — Naming collisions in nav copy (§3.7).** Drawer documents stop being called "spaces" in user-facing copy ("Documents"); the seeded project reads "Default project" with the caption "where unfiled work lands". Code names may stay; user-facing strings change.
  - Acceptance: no user-facing string in the navigation or drawer uses "space" for a document, and "Default" never appears without its qualifier.

### 1B — Icon treatment: every icon in the product (§3.6, §2.5 invariants 4–5)

- [ ] **I1 — Complete icon inventory.** Enumerate every icon surface and record it in the table in `ui/src/icons.ts` (the registry is the deliverable): rail destinations; header (presence, pause, settings); composer (microphone, send, stop, PTT states); drawer toggle; per-space header (raw/rendered eye, sync state, download, save, history, close, add); home panel sections and request cards (dismiss, act); project chips and forms (create, move, add-to-project); banners; tool-tag spinner; empty states. Each entry: surface → Lucide name → size class → states.
  - Acceptance: a screenshot sweep of every surface finds no icon that is not in the registry table.
- [ ] **I2 — One registry, no exceptions.** All icons render from `ui/src/icons.ts` Lucide paths. No inline SVGs elsewhere, no Unicode/text glyphs doing icon work, no emoji icons.
  - Acceptance: the known offender is gone — the drawer toggle's `◫` text glyph is replaced by a Lucide panel icon — and a grep over `ui/src` and the renderer for icon-position text glyphs comes back empty.
- [ ] **I3 — Size classes, fixed per component (§2.5 invariant 4).** Rail 20 px · header 18 px · buttons and list rows 16 px · space-header controls 15 px · inline-with-caption 14 px. One stroke width everywhere (Lucide's native 2 at the 24 viewBox); never mix stroke widths in one surface.
  - Acceptance: measured icon sizes in the running app match the class table; `icons.ts` exposes the size as part of each icon's registration, not per call-site.
- [ ] **I4 — Icon states from the matrix (§2.5).** Icons inherit their control's state treatment — hover/pressed layers, selected filled-or-accented **with** the non-colour cue from N3, disabled at the one disabled constant, focus ring identical to text controls. An icon never invents its own hover effect.
  - Acceptance: every icon-bearing control walks rest → hover → pressed → selected → disabled → focus-visible using only the shared constants.
- [ ] **I5 — Pairing, tooltips, labels.** Nav icons always pair with a visible label (gap `--space-1`). Icon-only controls (space header, header actions) always carry a tooltip and an aria-label; where the control reports state, the tooltip states the conclusion, not the request ("Saved · 2m ago", not "Save").
  - Acceptance: every icon-only control in the inventory shows a correct tooltip on hover and has an aria-label in the DOM.
- [ ] **I6 — One icon per concept.** The same concept uses the same icon everywhere: save, project, memory, research, settings, dismiss. Status marks are not icons: the three-state sync dot stays a mark, and gains its word on hover ("Saved" / "Editing" / "Out of sync") so its meaning is never colour-and-shape alone.
  - Acceptance: the inventory table shows exactly one Lucide name per concept; the sync dot's word appears on hover in all three states.

**Part 1 exit check:** four-destination rail with a single honest selection; every former destination reachable; every icon in the product registered, Lucide, one size per class, one icon per concept, state-treated by the shared matrix; zero text glyphs doing icon work.

---

## Part 2 — Presence and honest status (outline)

Header presence strip per §2.7: mark + **word** + detail line (Ready / Listening / Thinking + elapsed / Speaking / Working / Needs you / Failed / Done). Remove developer leakage from the chrome: the git build stamp becomes a human status line (voice ready · provider healthy · up to date). Brand spelling: "AImy" in title bar, header, and composer — "Almy" disappears (§3.3, §3.4).

## Part 3 — The workspace panel: decisions first (outline)

Needs You promoted above Continue as a decisions inbox (§3.5); Continue second; project context third. The three empties (§2.5) get distinct treatments — first-use, no-results, all-done — and the generic suggestion chips leave the prime empty-state slot.

## Part 4 — Receipts made permanent (outline)

The tool-tag receipt strip graduates into a durable activity record (§2.8): timestamp · actor in user words · provenance · outcome · reversibility · approver. Consequential actions pause for an approval card *before* running; reversible actions carry a timed undo (5 s default, configurable 5–30 s). The Settings → Activity placeholder from N1 is replaced by this surface.

## Part 5 — Token pass: type, spacing, radius (outline)

§2.1–§2.3 applied across chat, drawer, and composer: the type ramp with the 11 px caption floor, mono with tabular figures for numbers and timers, radius steps with the nested-radius rule, tonal elevation with shadow reserved for transient overlays.

## Part 6 — Motion and live indicators (outline)

§2.6 tokens applied: press 50 ms, hover 100 ms, default 200 ms, panels 300 ms, exits one step faster than entrances, transform/opacity only, everything interruptible, `prefers-reduced-motion` crossfades. Thinking and streaming indicators carry elapsed time and a cancel; they are status, never decoration.

## Part 7 — Conformance sweep (outline)

The §2.5 invariants run as a checklist over every surface: one constant per state; geometry stable across states; one focus ring; state never colour-alone; everything keyboard-operable with Esc as the universal back/close. Plus the vocabulary pass (§3.7) across all remaining user-facing strings.

## Part 8 — The HomeDash (Kimler design, 2026-10-13)

The home surface is a **dash of widgets on one layered stage** — not a fixed layout. Three widgets ship first:

- **WorkOn** — the actionable layer: the active project, running jobs with their ETAs, what needs you. (Today: the drawer home's content, promoted.)
- **GlobeNews** — the vector earth as an instrument: spin, grab, tilt — and, as the instrument rung lands, the world's events on it (research flares, news) with real counts and stylised geography, never surveillance.
- **MindMap** — the organism graph: projects, assets, jobs, subjects, chats, memories, journal (metadata only), edges as relationships, recency on the vertical axis. The **subjects map** — knowledge cards as a constellation with their proof state — is a first-class citizen of this widget, not a side cluster.

**Widget contract.** A widget is a folder with a manifest (`widget.json`: id, name, description, version, settings schema, default priority). Available widgets live in a pool (bundled with the app; user widgets under `~/.aimy/homedash/available/`). **Enablement is a link**: `~/.aimy/homedash/enabled/<id>` points into the pool, systemd-style; the dash loads only what is linked. A marker file of the same name is the portable equivalent where symlinks are unreliable. Widget code is a compiled-in registry keyed by manifest id until the bundle system can carry community code; the folder contract does not change when it does.

**Priority is depth.** Every widget carries a **priority, 1–1000**, and priority IS the screen depth: widgets composite as layers on the stage, higher priority on top where they overlap. WorkOn at 1000 is always on top; MindMap below GlobeNews falls behind the globe where the two cross. Priority is a per-widget **setting**, user-adjustable — widgets declare their settings in the manifest and the platform **transposes** them into the Settings UI generically (slider / toggle / select / number), values persisted platform-side in `~/.aimy/homedash/settings.json`, handed to the widget at start and on change. A widget's own knobs join the same mechanism (globe: spin, density, glow reach, tilt; mind map: breeze strength, labels).

**Wayfinding.** The header is the homedash glyph — the twin-tetrahedra mark, not a stock house icon (Kimler: "too dusty and overused") — plus the name of the current location. The glyph is a button home from every panel; in the shell it shows its active state. Home becomes a rail destination of its own; a new chat's empty state IS the dash.

**Status (2026-10-13, BUILT — pending Kimler's `./core/update` UAT):** the restructure is in place. Home is a rail destination (tetrahedra glyph) and a new chat's empty state renders the same dash. The stage composites widget layers by priority (inline z-index): WorkOn 1000 (HTML card: project, live jobs with ETAs, needs-you), GlobeNews 400 (engine split out of the old fused canvas; consumes spin/density/glow/tilt from its settings), MindMap 300 (its own engine file; breeze + labels settings; subjects constellation inside). Widget folders, manifests, and enable links are real: main seeds `~/.aimy/homedash/available/{workon,globenews,mindmap}/widget.json` + `enabled/` symlinks (marker-file fallback) on first `homedash.list`; values persist in `~/.aimy/homedash/settings.json`; priority validates 1–1000 in the setSetting handler. Settings gains a HomeDash section rendering every widget's declared controls generically plus the priority slider. Home data and dash state both load on cold start (the MindMap hook requests them) and on entering Home. The subjects map's inter-card edges still await a provenance source — cards do not yet record what produced them; edges are never fabricated. Known v1 roughness: slider drags round-trip through the store per input event (correct, chatty); widget code is still the compiled-in registry (the folder contract is ready for the bundle system).
