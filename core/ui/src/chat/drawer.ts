/**
 * ui/src/chat/drawer.ts — the right-hand drawer: collaboration spaces.
 *
 * Phase I (2026-10-12): vertical stacked panes, NOT tabs.
 * - 1 space: 100% of drawer height
 * - 2 spaces: 50%/50%, both visible
 * - 3 spaces: 33%/33%/33%, all visible
 * - Each pane is resizable via drag handles (like drawer width)
 * - Height preferences retained until space count changes
 * - Scroll position retained when drawer is hidden/shown (DOM persistence)
 *
 * Space header (2026-10-12): title, out-of-sync dot, and icon actions —
 * history (version list + restore), download, save to disk, close.
 * Restoring a version loads it into the preview AND writes it to disk
 * (handled in update.ts). History is session-scoped: every content state
 * is retained until the session closes.
 *
 * The drawer shell doesn't know what's inside — it renders spaces via
 * their kind. Currently only "preview" (markdown) exists.
 */
import type { Html, HtmlBuilder } from "foldkit/html"
import { type DrawerSpace, type DrawerState, spaceDirty } from "../model.js"
import { Message } from "../messages.js"
import { renderMarkdown } from "../markdown.js"
import { icon } from "../icons.js"

type H = HtmlBuilder<Message>

const formatTime = (at: number): string => {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  } catch {
    return ""
  }
}

/** First non-empty line of a document, for history list snippets. */
const firstLine = (content: string): string => {
  const line = content.split("\n").find((l) => l.trim() !== "") ?? ""
  const clean = line.replace(/^#+\s*/, "").trim()
  return clean.length > 64 ? clean.slice(0, 64) + "…" : clean
}

/** The history dropdown for one space: versions newest-first. */
const historyView = (h: H, space: DrawerSpace): Html => {
  const history = space.history ?? []
  if (history.length === 0) {
    return h.div([h.Class("drawer-history")], [
      h.div([h.Class("drawer-history-empty")], ["No history yet this session."]),
    ])
  }
  const items = history
    .map((v, i) => ({ v, i }))
    .reverse()
    .map(({ v, i }) => {
      const isCurrent = v.content === space.content
      return h.button(
        [
          h.Class(isCurrent ? "drawer-history-item current" : "drawer-history-item"),
          h.Title(isCurrent ? "Current version" : "Restore this version (also updates the file on disk)"),
          h.OnClick(Message.DrawerVersionRestored({ id: space.id, index: i })),
        ],
        [
          h.span([h.Class("drawer-history-meta")], [
            `${formatTime(v.at)} · ${v.label}${isCurrent ? " · current" : ""}`,
          ]),
          h.span([h.Class("drawer-history-snippet")], [firstLine(v.content)]),
        ]
      )
    })
  return h.div([h.Class("drawer-history")], items)
}

/** When a recent document was last touched: time today, date otherwise. */
const formatWhen = (at: number): string => {
  try {
    const d = new Date(at)
    const today = new Date()
    const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
    return sameDay
      ? formatTime(at)
      : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + formatTime(at)
  } catch {
    return ""
  }
}

/**
 * The drawer home panel (2026-10-12): what an open-but-empty drawer
 * shows. Three sections rendered from the user's own stores (loaded
 * via HomeIpc when the drawer opens) — Continue (recent documents,
 * click to open), Needs you (pending capability requests: open one as a
 * build brief, or dismiss it), What she knows (knowledge cards with
 * their proven counts). Disk
 * truth rendered by the UI; the model generates none of it.
 */
/** The inline new-project form (2026-10-12, project UI). */
const projectFormView = (h: H, drawer: DrawerState): Array<Html> =>
  drawer.projectFormOpen === true
    ? [
        h.div([h.Class("drawer-home-form")], [
          h.input([
            h.Class("drawer-home-input"),
            h.Placeholder("Project name"),
            h.Value(drawer.projectDraftName ?? ""),
            h.OnInput((value: string) => Message.HomeProjectDraftNameChanged({ value })),
          ]),
          h.input([
            h.Class("drawer-home-input"),
            h.Placeholder("Purpose (what is this work for?)"),
            h.Value(drawer.projectDraftPurpose ?? ""),
            h.OnInput((value: string) => Message.HomeProjectDraftPurposeChanged({ value })),
          ]),
          h.div([h.Class("drawer-home-actions")], [
            h.button(
              [
                h.Class("drawer-home-request-action"),
                h.Title("Create the project and switch to it"),
                h.OnClick(Message.HomeProjectCreateSubmitted()),
              ],
              ["Create project"]
            ),
            h.button(
              [
                h.Class("drawer-home-request-action"),
                h.OnClick(Message.HomeProjectFormCancelled()),
              ],
              ["Cancel"]
            ),
          ]),
        ]),
      ]
    : []

const homeView = (h: H, drawer: DrawerState): Html => {
  const home = drawer.homeData
  if (home === undefined) {
    return h.div([h.Class("drawer-empty")], [
      "No documents open. Ask AImy to show you something.",
    ])
  }
  const sections: Array<Html> = []
  // Project (active project: purpose, goals, research runs, assets)
  if (home.project !== null) {
    const p = home.project
    const fmtDur = (ms: number): string => {
      const s = Math.max(0, Math.round(ms / 1000))
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      if (m < 60) return `${m}m`
      return `${Math.floor(m / 60)}h ${m % 60}m`
    }
    const runRows = p.runs.map((r) => {
      const startedMs = Date.parse(r.startedAt)
      const finishedMs = r.finishedAt !== undefined ? Date.parse(r.finishedAt) : undefined
      const elapsed = Number.isFinite(startedMs)
        ? fmtDur((finishedMs ?? Date.now()) - startedMs)
        : ""
      const live = r.status === "running" || r.status === "scheduled"
      const eta = live
        ? r.etaMs !== null
          ? ` · ~${fmtDur(r.etaMs)} left (estimate)`
          : " · estimating…"
        : ""
      // Progressive disclosure (2026-10-12): at rest a run row answers
      // only what was asked and how it ended, in plain words. Every
      // counter, the stage, and the deliverable path live in the
      // hover tooltip — available, not displayed.
      const statusText =
        r.status === "running"
          ? "Running"
          : r.status === "scheduled"
            ? "Scheduled"
            : r.status === "failed"
              ? "Failed"
              : r.termination === "no-gaps" || r.termination === "answered"
                ? "Complete"
                : r.termination === "budget-exhausted"
                  ? "Partial — budget exhausted"
                  : r.termination === "no-sources"
                    ? "No sources found"
                    : r.termination === "timeout"
                      ? "Timed out"
                      : "Done"
      const detail = [
        r.query,
        `Status: ${statusText} (${r.mode} · ${r.depth} · stage ${r.stage || "—"})`,
        `${r.counters.searches} searches · ${r.counters.fetches} read · ${r.counters.claims} claims · ${r.counters.clusters} clusters · ${r.counters.rounds} round(s) · ${elapsed} elapsed${eta}`,
        r.deliverablePath !== null
          ? `Deliverable: ${r.deliverableTitle} → ${r.deliverablePath}`
          : `Deliverable: ${r.deliverableTitle} (in chat)`,
      ].join("\n")
      return h.div([h.Class("drawer-home-run"), h.Title(detail)], [
        h.div([h.Class("drawer-home-card-top")], [
          h.span([h.Class("drawer-home-row-title")], [r.query]),
          h.span([h.Class(live ? "drawer-home-proven" : "drawer-home-proven zero")], [statusText]),
        ]),
        h.span([h.Class("drawer-home-row-meta")], [
          `${r.mode === "paper" ? "Paper" : "Answer"} · ${elapsed} · ${r.counters.claims} claims${eta}`,
        ]),
      ])
    })
    const assetRows = p.assets.map((a) => {
      const key = `${a.kind}|${a.title}`
      const moveOpen = drawer.assetMoveFor === key
      const targets = home.projectList.filter((t) => t.id !== p.id)
      return h.div(
        [h.Class("drawer-home-card"), ...(a.path !== undefined ? [h.Title(a.path)] : [])],
        [
        h.div([h.Class("drawer-home-card-top")], [
          // A file asset's title IS its open action (2026-10-12):
          // examine before you move — the title opens the document
          // in the drawer, exactly like a Continue row. Pathless
          // assets (run references) stay plain text; only openable
          // things look clickable.
          ...(a.path !== undefined
            ? [
                h.button(
                  [
                    h.Class("drawer-home-open-btn"),
                    h.Title(`Open in the drawer — ${a.path}`),
                    h.OnClick(Message.HomeRecentClicked({ path: a.path })),
                  ],
                  [h.span([h.Class("drawer-home-row-title")], [a.title]), icon.panelRight(h)]
                ),
              ]
            : [h.span([h.Class("drawer-home-row-title")], [a.title])]),
          h.span([h.Class(a.role === "deliverable" ? "drawer-home-proven" : "drawer-home-proven zero")], [`${a.kind} · ${a.role}`]),
        ]),
        ...(targets.length > 0
          ? [
              h.div([h.Class(moveOpen ? "drawer-home-actions" : "drawer-home-actions reveal")], [
                h.button(
                  [
                    h.Class("drawer-home-request-action"),
                    h.Title("Move this asset to another project (the file itself never moves)"),
                    h.OnClick(Message.HomeAssetMoveMenuToggled({ key })),
                  ],
                  [moveOpen ? "Cancel" : "Move to…"]
                ),
              ]),
            ]
          : []),
        ...(moveOpen
          ? [
              h.div([h.Class("drawer-home-actions")], [
                h.span([h.Class("drawer-home-row-meta")], ["Move to:"]),
                ...targets.map((t) =>
                  h.button(
                    [
                      h.Class("drawer-home-chip"),
                      h.OnClick(
                        Message.HomeAssetMoveTargetClicked({
                          fromId: p.id,
                          toId: t.id,
                          kind: a.kind,
                          title: a.title,
                          ...(a.path !== undefined ? { path: a.path } : {}),
                        })
                      ),
                    ],
                    [t.name]
                  )
                ),
              ]),
            ]
          : []),
      ])
    })
    // Switcher (2026-10-12): every project as a chip, the active one
    // marked; New project opens the inline form below.
    const switcherRow = h.div([h.Class("drawer-home-actions")], [
      ...home.projectList.map((t) =>
        h.button(
          [
            h.Class(t.id === p.id ? "drawer-home-chip active" : "drawer-home-chip"),
            h.Title(t.id === p.id ? "Active project" : `Switch to ${t.isDefault ? "Default project" : t.name}`),
            h.OnClick(Message.HomeProjectSwitchClicked({ id: t.id })),
          ],
          [t.isDefault ? "Default project" : t.name]
        )
      ),
      h.button(
        [
          h.Class("drawer-home-chip new"),
          h.Title("Create a new project and make it active"),
          h.OnClick(Message.HomeProjectNewClicked()),
        ],
        [icon.plus(h), "New project"]
      ),
    ])
    const projectForm = projectFormView(h, drawer)
    sections.push(
      h.div([h.Class("drawer-home-section")], [
        h.div([h.Class("drawer-home-heading")], [`Project — ${p.isDefault ? "Default project" : p.name}`]),
        switcherRow,
        ...projectForm,
        ...(p.purpose !== ""
          ? [h.div([h.Class("drawer-home-section-note")], [p.purpose])]
          : p.isDefault
            ? [h.div([h.Class("drawer-home-section-note")], ["The Default project — where unfiled work lands until a project is declared for it. Ask AImy to start one when a body of work deserves its own container."])]
            : []),
        ...p.goals.map((g) => h.div([h.Class("drawer-home-row-meta")], [`Goal: ${g}`])),
        ...(runRows.length > 0 ? [h.div([h.Class("drawer-home-subheading")], ["Research"]), ...runRows] : []),
        ...(assetRows.length > 0 ? [h.div([h.Class("drawer-home-subheading")], ["Assets"]), ...assetRows] : []),
      ])
    )
  }
  // No store yet: still offer project creation (the first project is
  // what brings the store into existence).
  if (home.project === null) {
    sections.push(
      h.div([h.Class("drawer-home-section")], [
        h.div([h.Class("drawer-home-heading")], ["Project"]),
        h.div([h.Class("drawer-home-section-note")], [
          "No project yet. Create one to give a body of work its own container — assets made while it is active land inside it.",
        ]),
        h.div([h.Class("drawer-home-actions")], [
          h.button(
            [
              h.Class("drawer-home-chip new"),
              h.Title("Create a new project and make it active"),
              h.OnClick(Message.HomeProjectNewClicked()),
            ],
            [icon.plus(h), "New project"]
          ),
        ]),
        ...projectFormView(h, drawer),
      ])
    )
  }
  // Continue
  const recentRows = home.recents.length === 0
    ? [h.div([h.Class("drawer-home-empty")], ["No documents yet — saved documents will appear here."])]
    : home.recents.map((r) =>
        h.div([h.Class("drawer-home-request")], [
          h.button(
            [
              h.Class("drawer-home-row grow"),
              h.Title(`Open ${r.path}`),
              h.OnClick(Message.HomeRecentClicked({ path: r.path })),
            ],
            [
              h.span([h.Class("drawer-home-row-title")], [r.title]),
              h.span([h.Class("drawer-home-row-meta")], [`${r.path} · ${formatWhen(r.at)}`]),
            ]
          ),
          ...(home.project !== null
            ? [
                h.button(
                  [
                    h.Class("icon-btn"),
                    h.Title(`Add to project "${home.project.name}"`),
                    h.OnClick(Message.HomeRecentAddToProjectClicked({ path: r.path, title: r.title })),
                  ],
                  [icon.plus(h)]
                ),
              ]
            : []),
        ])
      )
  sections.push(
    h.div([h.Class("drawer-home-section")], [
      h.div([h.Class("drawer-home-heading")], ["Continue"]),
      ...recentRows,
    ])
  )
  // Needs you
  const requestRows = home.requests.length === 0
    ? [h.div([h.Class("drawer-home-empty")], ["Nothing pending. A missing capability lands here when one is requested."])]
    : home.requests.map((req) =>
        h.div([h.Class("drawer-home-request")], [
          h.div([h.Class("drawer-home-request-main")], [
            h.span([h.Class("drawer-home-request-cap")], [req.capability]),
            h.span([h.Class("drawer-home-request-why")], [req.why]),
            h.button(
              [
                h.Class("drawer-home-request-action"),
                h.Title("Open the full request as a build brief"),
                h.OnClick(Message.HomeRequestBuildBriefClicked({ capability: req.capability, at: req.at })),
              ],
              ["Use as build brief"]
            ),
          ]),
          h.button(
            [
              h.Class("icon-btn"),
              h.Title("Dismiss — do not build this capability"),
              h.OnClick(Message.HomeRequestDismissClicked({ capability: req.capability, at: req.at })),
            ],
            [icon.x(h)]
          ),
        ])
      )
  sections.push(
    h.div([h.Class("drawer-home-section")], [
      h.div([h.Class("drawer-home-heading")], ["Needs you"]),
      ...(home.requests.length > 0
        ? [
            h.div([h.Class("drawer-home-section-note")], [
              "Capability requests — AImy is blocked. This is a request to build what's missing, not an approval.",
            ]),
          ]
        : []),
      ...requestRows,
    ])
  )
  // What she knows
  const cardRows = home.cards.length === 0
    ? [h.div([h.Class("drawer-home-empty")], ["No cards yet — one is written when a topic gets researched."])]
    : home.cards.map((c) =>
        h.div([h.Class("drawer-home-card")], [
          h.div([h.Class("drawer-home-card-top")], [
            h.span([h.Class("drawer-home-row-title")], [c.title]),
            h.span([h.Class(c.proven > 0 ? "drawer-home-proven" : "drawer-home-proven zero")], [`proven: ${c.proven}`]),
          ]),
          h.span([h.Class("drawer-home-row-meta")], [c.whenToUse]),
        ])
      )
  sections.push(
    h.div([h.Class("drawer-home-section")], [
      h.div([h.Class("drawer-home-heading")], ["Knowledge"]),
      ...cardRows,
    ])
  )
  sections.push(
    h.div([h.Class("drawer-home-foot")], ["Or ask AImy to show you something."])
  )
  return h.div([h.Class("drawer-home")], sections)
}

/** Render a preview space: markdown content with header and scrollable body. */
const previewSpaceView = (
  h: H,
  space: DrawerSpace,
  heightRatio: number,
  historyOpen: boolean,
  editing: boolean,
  draft: string
) => {
  const raw = space.showRaw === true
  const body = editing
    ? h.textarea([
        h.Class("drawer-space-editor"),
        h.Value(draft),
        h.Placeholder("Markdown…"),
        h.OnInput((value: string) => Message.DrawerEditDraftChanged({ text: value })),
      ])
    : raw
      ? // NOTE: a <pre>, NOT a <div> — the rendered body is a div whose
        // children are managed by InnerHTML. Same-tag patching between
        // the raw text-child div and the InnerHTML div crashed foldkit
        // (removeChild on a node innerHTML had already wiped,
        // 2026-10-12). A different tag forces wholesale replacement.
        h.pre([h.Class("drawer-space-body drawer-space-raw")], [space.content])
      : h.div(
          [h.Class("drawer-space-body"), h.InnerHTML(renderMarkdown(space.content))],
          []
        )
  // Encode space ID in a data attribute via the class name.
  // Format: "space-id-<id>" — subscription parses the ID.
  // (Foldkit's HtmlBuilder has no generic Attr method.)
  // Note: IDs must be simple (alphanumeric, dash, underscore) for this to work.
  const idClass = `space-id-${space.id}`
  const dirty = spaceDirty(space)
  const headerChildren: Array<Html> = [
    // Leading type icon (2026-10-12): the eye marks a Preview space and
    // doubles as the rendered/raw toggle — accent-colored while raw.
    h.button(
      [
        h.Class(raw ? "icon-btn drawer-type-btn active" : "icon-btn drawer-type-btn"),
        h.Title(raw ? "Raw view — click for rendered preview" : "Preview document — click to view raw markdown"),
        h.OnClick(Message.DrawerRawToggled({ id: space.id })),
      ],
      [icon.eye(h)]
    ),
    h.span([h.Class("drawer-space-title")], [space.title]),
  ]
  if (space.saveError !== undefined) {
    headerChildren.push(
      h.span([h.Class("drawer-sync-dot error"), h.Title(`Save failed: ${space.saveError}`)], [""])
    )
  } else if (dirty) {
    headerChildren.push(
      h.span([h.Class("drawer-sync-dot"), h.Title("Out of sync with disk — not saved")], [""])
    )
  } else {
    headerChildren.push(
      h.span(
        [
          h.Class("drawer-sync-dot synced"),
          h.Title(space.savedAt !== undefined ? `In sync — saved ${formatTime(space.savedAt)}` : "In sync with disk"),
        ],
        [""]
      )
    )
  }
  // In edit mode the actions collapse to apply/cancel; otherwise the
  // normal set (history / edit / copy / download / save / close). The
  // copy and download buttons have NO foldkit message on purpose
  // (2026-10-12): both are delegated DOM ops in desktop main.ts (the
  // copy-button pattern) — a no-message DOM command crashes this app
  // ("Schema validation failed"). Copy reads the same hidden
  // .drawer-space-source span as download, so it always copies the
  // space's current raw markdown, including unsaved edits.
  const actions = editing
    ? [
        h.button(
          [
            h.Class("icon-btn"),
            h.Title("Apply edits"),
            h.OnClick(Message.DrawerEditApplied({ id: space.id })),
          ],
          [icon.check(h)]
        ),
        h.button(
          [
            h.Class("icon-btn"),
            h.Title("Cancel editing"),
            h.OnClick(Message.DrawerEditCancelled({ id: space.id })),
          ],
          [icon.x(h)]
        ),
      ]
    : [
        h.button(
          [
            h.Class(historyOpen ? "icon-btn active" : "icon-btn"),
            h.Title("History — every version this session"),
            h.OnClick(Message.DrawerHistoryToggled({ id: space.id })),
          ],
          [icon.history(h)]
        ),
        h.button(
          [
            h.Class("icon-btn"),
            h.Title("Edit this document"),
            h.OnClick(Message.DrawerEditStarted({ id: space.id })),
          ],
          [icon.pencil(h)]
        ),
        h.button(
          [
            h.Class("icon-btn drawer-copy-btn"),
            h.Title("Copy — click for rich text, long-click for markdown"),
          ],
          [icon.copy(h)]
        ),
        h.button(
          [
            h.Class("icon-btn drawer-download-btn"),
            h.Title("Download this markdown file"),
          ],
          [icon.download(h)]
        ),
        h.button(
          [
            h.Class(dirty ? "icon-btn" : "icon-btn dim"),
            h.Title(dirty ? "Save to disk" : "Saved to disk"),
            h.OnClick(Message.DrawerSaveRequested({ id: space.id })),
          ],
          [icon.save(h)]
        ),
        h.button(
          [
            h.Class("icon-btn"),
            h.Title("Close document"),
            h.OnClick(Message.DrawerSpaceClosed({ id: space.id })),
          ],
          [icon.x(h)]
        ),
      ]
  headerChildren.push(h.div([h.Class("drawer-space-actions")], actions))
  const children: Array<Html> = [
    h.div([h.Class("drawer-space-header")], headerChildren),
    // Hidden raw-markdown source for the delegated copy/download (main.ts).
    h.span([h.Class("drawer-space-source")], [space.content]),
  ]
  if (space.saveError !== undefined) {
    children.push(
      h.div([h.Class("drawer-space-error")], [`Save failed: ${space.saveError}`])
    )
  }
  if (historyOpen) {
    children.push(historyView(h, space))
  }
  children.push(body)
  return h.div(
    [
      h.Class(`drawer-space ${idClass}`),
      h.Style({ "flex-grow": String(heightRatio), "flex-basis": "0", "min-height": "80px" }),
    ],
    children
  )
}

/** Render a space by kind. */
const spaceView = (h: H, space: DrawerSpace, heightRatio: number, historyOpen: boolean, editing: boolean, draft: string) => {
  switch (space.kind) {
    case "preview":
      return previewSpaceView(h, space, heightRatio, historyOpen, editing, draft)
    default:
      return h.div(
        [h.Class("drawer-space"), h.Style({ "flex-grow": String(heightRatio), "flex-basis": "0" })],
        [
          h.div([h.Class("drawer-unknown")], [
            `Unknown space kind: ${space.kind}`,
          ]),
        ]
      )
  }
}

/**
 * The drawer panel. Returns null (renders nothing) when closed.
 * Pure: identical drawer state in -> identical tree out.
 *
 * Layout: vertical flex column. Each space is a flex child with
 * flex-grow set from heightRatios (default 1 = equal split).
 * Resize handles between spaces allow drag-to-resize.
 *
 * Width: controlled by --drawer-width CSS var (default 400px). The resize
 * handle updates it via the drawer-resize subscription in subscriptions.ts.
 *
 * Note: Space IDs for resize are identified by DOM order, not data attributes.
 * The subscription finds the spaces by their position relative to the handle.
 */
/**
 * The Projects destination (UI workplan Part 1A, 2026-10-12): the
 * project as a place, rendered by the composed shell from the same
 * home data and the same shell messages as the drawer's home panel —
 * switcher, create form, purpose, goals, research runs, assets. One
 * project UI, two doors (here and the drawer home); the drawer's home
 * additionally carries Continue / Needs you and asset moving.
 */
export const projectsPanelView = (h: H, drawer: DrawerState): Html => {
  const home = drawer.homeData
  if (home === undefined) {
    return h.div([h.Class("drawer-home-section")], [
      h.div([h.Class("drawer-home-section-note")], [
        "Projects load with the home data — they will appear here in a moment.",
      ]),
    ])
  }
  const fmtDur = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    return `${Math.floor(m / 60)}h ${m % 60}m`
  }
  const displayName = (name: string, isDefault: boolean): string => (isDefault ? "Default project" : name)
  if (home.project === null) {
    return h.div([h.Class("drawer-home-section")], [
      h.div([h.Class("drawer-home-section-note")], [
        "No project yet. Create one to give a body of work its own container — assets made while it is active land inside it.",
      ]),
      h.div([h.Class("drawer-home-actions")], [
        h.button(
          [
            h.Class("drawer-home-chip new"),
            h.Title("Create a new project and make it active"),
            h.OnClick(Message.HomeProjectNewClicked()),
          ],
          [icon.plus(h), "New project"]
        ),
      ]),
      ...projectFormView(h, drawer),
    ])
  }
  const p = home.project
  return h.div([h.Class("drawer-home-section")], [
    h.div([h.Class("drawer-home-actions")], [
      ...home.projectList.map((t) =>
        h.button(
          [
            h.Class(t.id === p.id ? "drawer-home-chip active" : "drawer-home-chip"),
            h.Title(t.id === p.id ? "Active project" : `Switch to ${displayName(t.name, t.isDefault)}`),
            h.OnClick(Message.HomeProjectSwitchClicked({ id: t.id })),
          ],
          [displayName(t.name, t.isDefault)]
        )
      ),
      h.button(
        [
          h.Class("drawer-home-chip new"),
          h.Title("Create a new project and make it active"),
          h.OnClick(Message.HomeProjectNewClicked()),
        ],
        [icon.plus(h), "New project"]
      ),
    ]),
    ...projectFormView(h, drawer),
    ...(p.purpose !== ""
      ? [h.div([h.Class("drawer-home-section-note")], [p.purpose])]
      : p.isDefault
        ? [
            h.div([h.Class("drawer-home-section-note")], [
              "The Default project — where unfiled work lands until a project is declared for it.",
            ]),
          ]
        : []),
    ...p.goals.map((g) => h.div([h.Class("drawer-home-row-meta")], [`Goal: ${g}`])),
    ...(p.runs.length > 0
      ? [
          h.div([h.Class("drawer-home-subheading")], ["Research"]),
          ...p.runs.map((r) => {
            const startedMs = Date.parse(r.startedAt)
            const finishedMs = r.finishedAt !== undefined ? Date.parse(r.finishedAt) : undefined
            const elapsed = Number.isFinite(startedMs) ? fmtDur((finishedMs ?? Date.now()) - startedMs) : ""
            const live = r.status === "running" || r.status === "scheduled"
            // Same progressive disclosure as the drawer home rows:
            // plain-word outcome at rest, everything else on hover.
            const statusText =
              r.status === "running"
                ? "Running"
                : r.status === "scheduled"
                  ? "Scheduled"
                  : r.status === "failed"
                    ? "Failed"
                    : r.termination === "no-gaps" || r.termination === "answered"
                      ? "Complete"
                      : r.termination === "budget-exhausted"
                        ? "Partial — budget exhausted"
                        : r.termination === "no-sources"
                          ? "No sources found"
                          : r.termination === "timeout"
                            ? "Timed out"
                            : "Done"
            const eta = live
              ? r.etaMs !== null
                ? ` · ~${fmtDur(r.etaMs)} left (estimate)`
                : " · estimating…"
              : ""
            const detail = [
              r.query,
              `Status: ${statusText} (${r.mode} · ${r.depth} · stage ${r.stage || "—"})`,
              `${r.counters.searches} searches · ${r.counters.fetches} read · ${r.counters.claims} claims · ${r.counters.clusters} clusters · ${r.counters.rounds} round(s) · ${elapsed} elapsed${eta}`,
              r.deliverablePath !== null
                ? `Deliverable: ${r.deliverableTitle} → ${r.deliverablePath}`
                : `Deliverable: ${r.deliverableTitle} (in chat)`,
            ].join("\n")
            return h.div([h.Class("drawer-home-run"), h.Title(detail)], [
              h.div([h.Class("drawer-home-card-top")], [
                h.span([h.Class("drawer-home-row-title")], [r.query]),
                h.span([h.Class(live ? "drawer-home-proven" : "drawer-home-proven zero")], [statusText]),
              ]),
              h.span([h.Class("drawer-home-row-meta")], [
                `${r.mode === "paper" ? "Paper" : "Answer"} · ${elapsed} · ${r.counters.claims} claims${eta}`,
              ]),
            ])
          }),
        ]
      : []),
    ...(p.assets.length > 0
      ? [
          h.div([h.Class("drawer-home-subheading")], ["Assets"]),
          ...p.assets.map((a) =>
            h.div([h.Class("drawer-home-card"), ...(a.path !== undefined ? [h.Title(a.path)] : [])], [
              h.div([h.Class("drawer-home-card-top")], [
                ...(a.path !== undefined
                  ? [
                      h.button(
                        [
                          h.Class("drawer-home-open-btn"),
                          h.Title(`Open in the drawer — ${a.path}`),
                          h.OnClick(Message.HomeRecentClicked({ path: a.path })),
                        ],
                        [h.span([h.Class("drawer-home-row-title")], [a.title]), icon.panelRight(h)]
                      ),
                    ]
                  : [h.span([h.Class("drawer-home-row-title")], [a.title])]),
                h.span([h.Class(a.role === "deliverable" ? "drawer-home-proven" : "drawer-home-proven zero")], [
                  `${a.kind} · ${a.role}`,
                ]),
              ]),
            ])
          ),
        ]
      : []),
  ])
}

export const drawerView = (h: H, drawer: DrawerState | undefined) => {
  if (!drawer || !drawer.open) return null
  if (drawer.spaces.length === 0) {
    return h.div([h.Class("drawer")], [
      h.div(
        [h.Class("drawer-resize-handle"), h.Title("Drag to resize, double-click to reset")],
        []
      ),
      homeView(h, drawer),
    ])
  }

  // Height ratios: default to 1 (equal split) for each space.
  const ratios = drawer.spaces.map((s) =>
    drawer.heightRatios?.[s.id] ?? 1
  )

  // Build the stacked layout: space, handle, space, handle, space...
  // The handles are identified by their position in the DOM — the
  // subscription finds the sibling spaces by traversing the DOM.
  const children: ReturnType<H["div"]>[] = []
  drawer.spaces.forEach((space, i) => {
    const isEditing = drawer.editingId === space.id
    children.push(spaceView(h, space, ratios[i] ?? 1, drawer.historyOpenFor === space.id, isEditing, isEditing ? (drawer.editDraft ?? space.content) : space.content))
    // Add resize handle between spaces (not after the last one).
    if (i < drawer.spaces.length - 1) {
      children.push(
        h.div(
          [
            h.Class("drawer-space-resize-handle"),
            h.Title("Drag to resize documents"),
          ],
          []
        )
      )
    }
  })

  return h.div([h.Class("drawer")], [
    // Drawer width resize handle (existing).
    h.div(
      [
        h.Class("drawer-resize-handle"), h.Title("Drag to resize, double-click to reset")],
      []
    ),
    // Stacked spaces container.
    h.div([h.Class("drawer-spaces")], children),
  ])
}
