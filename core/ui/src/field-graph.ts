/**
 * field-graph.ts — the Mirror Field's inner world, v2 (2026-10-13).
 *
 * Pure derivation: the drawer's home data → the typed node/edge
 * graph the renderer draws below the horizon as her living mind
 * map. Node kinds follow the product's own taxonomy — project,
 * asset, job, subject, chat, memory — each with the recency the
 * layout's time-gravity needs, a one-line conclusion (`sub`), and
 * where the data honestly supports it, a `preview`. NO invented
 * content: every node is something she actually holds. Before any
 * home data exists, a seed graph of doors stands in.
 *
 * Structural input types (not the store's own) keep this module
 * decoupled; the call site passes session.drawer.homeData.
 */

export type FieldKind =
  | "hub"
  | "project"
  | "asset"
  | "job"
  | "knowledge"
  | "subject"
  | "chat"
  | "memory"
  | "journal"
  | "recent"
  | "door"

export interface FieldNode {
  readonly id: string
  readonly kind: FieldKind
  readonly label: string
  readonly sub: string
  readonly weight: number
  /** Epoch ms of the thing itself — drives the layout's time gravity. */
  readonly atMs: number
  readonly preview?: string | undefined
  readonly path?: string | undefined
  readonly projectId?: string | undefined
  /** Clicking routes to this panel (chat/memory nodes). */
  readonly panelTarget?: string | undefined
  /** Jobs only: live state, and the run's own ETA estimate. */
  readonly jobState?: "active" | "done" | undefined
  readonly etaMs?: number | null | undefined
}

export interface FieldEdge {
  readonly a: string
  readonly b: string
  /** solid = belongs-to; dotted = association. The whole grammar. */
  readonly style: "solid" | "dotted"
}

export interface FieldGraph {
  readonly nodes: ReadonlyArray<FieldNode>
  readonly edges: ReadonlyArray<FieldEdge>
}

export interface FieldHomeInput {
  readonly project: {
    readonly id: string
    readonly purpose: string
    readonly assets: ReadonlyArray<{
      readonly kind: string
      readonly title: string
      readonly role: string
      readonly path?: string | undefined
      readonly addedAt: string
    }>
    readonly runs: ReadonlyArray<{
      readonly runId: string
      readonly query: string
      readonly status: string
      readonly stage: string
      readonly startedAt: string
      readonly finishedAt?: string | undefined
      readonly etaMs: number | null
      readonly deliverablePath: string | null
      readonly counters: { readonly claims: number; readonly fetches: number }
      readonly termination?: string | undefined
    }>
  } | null
  readonly projectList: ReadonlyArray<{ readonly id: string; readonly name: string; readonly isDefault: boolean }>
  readonly cards: ReadonlyArray<{ readonly title: string; readonly whenToUse: string; readonly proven: number; readonly updated: string }>
  readonly recents: ReadonlyArray<{ readonly path: string; readonly title: string; readonly at: number }>
  readonly chats: ReadonlyArray<{ readonly id: string; readonly subject: string; readonly at: number; readonly messages: number }>
  readonly memories: ReadonlyArray<{
    readonly sessionId: string
    readonly summary: string
    readonly messageCount: number
    readonly archivedAt: number
  }>
  /** Journal metadata (existence + freshness), or null. Never content. */
  readonly journal: { readonly updatedAt: number; readonly chars: number } | null
}

const MAX_NODES = 54
/** A finished job stays visible as a green check for this long. */
const DONE_JOB_WINDOW_MS = 15 * 60_000
const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/**
 * A job's remaining time as the user reads it: "~2m", "~45s", or
 * "…" when no honest estimate exists. Shared by the MindMap engine
 * and the WorkOn widget (moved here from the renderer, 2026-10-13).
 */
export const formatEta = (remainingMs: number | null): string =>
  remainingMs === null || remainingMs <= 0
    ? "…"
    : remainingMs < 90_000
      ? `~${Math.max(1, Math.round(remainingMs / 1000))}s`
      : `~${Math.round(remainingMs / 60_000)}m`

/** Plain-words freshness for captions: "within the hour", "3h ago", "2d ago". */
const agoText = (atMs: number, nowMs: number): string => {
  const d = Math.max(0, nowMs - atMs)
  if (d < 3_600_000) return "within the hour"
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  return `${Math.round(d / 86_400_000)}d ago`
}
const parseMs = (iso: string | undefined): number => {
  if (iso === undefined) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/** Plain-word run outcome — same vocabulary as the project panel. */
const runStatusWord = (status: string, termination: string | undefined): string =>
  status === "running"
    ? "Running"
    : status === "scheduled"
      ? "Scheduled"
      : status === "failed"
        ? "Failed"
        : termination === "no-gaps" || termination === "answered"
          ? "Complete"
          : termination === "budget-exhausted"
            ? "Partial — budget exhausted"
            : termination === "no-sources"
              ? "No sources found"
              : termination === "timeout"
                ? "Timed out"
                : "Done"

export const buildFieldGraph = (home: FieldHomeInput | undefined, nowMs: number = Date.now()): FieldGraph => {
  const hub: FieldNode = {
    id: "hub",
    kind: "hub",
    label: "AImy",
    sub: "Start here",
    weight: 4,
    atMs: nowMs,
    panelTarget: "presence",
  }
  if (home === undefined) {
    const doors: ReadonlyArray<FieldNode> = [
      { id: "door:projects", kind: "door", label: "Projects", sub: "Start a project", weight: 2, atMs: nowMs, panelTarget: "projects" },
      { id: "door:knowledge", kind: "door", label: "Knowledge", sub: "What is proven", weight: 2, atMs: nowMs, panelTarget: "memory" },
      { id: "door:research", kind: "door", label: "Research", sub: "Ask a question", weight: 2, atMs: nowMs },
      { id: "door:journal", kind: "door", label: "Journal", sub: "Kept private", weight: 2, atMs: nowMs, panelTarget: "memory" },
    ]
    return {
      nodes: [hub, ...doors],
      edges: doors.map((d) => ({ a: "hub", b: d.id, style: "solid" as const })),
    }
  }
  const nodes: Array<FieldNode> = [hub]
  const edges: Array<FieldEdge> = []
  const solid = (a: string, b: string): void => {
    edges.push({ a, b, style: "solid" })
  }
  const dotted = (a: string, b: string): void => {
    edges.push({ a, b, style: "dotted" })
  }
  const activeId = home.project?.id
  for (const p of home.projectList) {
    const id = `project:${p.id}`
    nodes.push({
      id,
      kind: "project",
      label: p.isDefault ? "Default project" : p.name,
      sub: p.id === activeId ? "Active project" : "Project",
      weight: 3,
      atMs: nowMs,
      projectId: p.id,
      ...(p.id === activeId && home.project !== null && home.project.purpose !== ""
        ? { preview: trunc(home.project.purpose, 110) }
        : {}),
    })
    solid("hub", id)
  }
  if (home.project !== null) {
    const p = home.project
    const pid = `project:${p.id}`
    // Jobs first — hearts before artifacts. Active jobs always make
    // the cut; finished jobs only while their green check is fresh.
    const runs = [...p.runs].sort((a, b) => parseMs(b.startedAt) - parseMs(a.startedAt))
    for (const r of runs) {
      const active = r.status === "running" || r.status === "scheduled"
      const finishedMs = parseMs(r.finishedAt)
      const freshDone = !active && r.status === "done" && finishedMs > 0 && nowMs - finishedMs < DONE_JOB_WINDOW_MS
      if (!active && !freshDone) continue
      nodes.push({
        id: `job:${r.runId}`,
        kind: "job",
        label: trunc(r.query, 52),
        sub: active
          ? `Research — ${runStatusWord(r.status, r.termination)} · ${r.counters.claims} claims`
          : `Research — ${runStatusWord(r.status, r.termination)}`,
        weight: active ? 4 : 3,
        atMs: parseMs(r.startedAt),
        jobState: active ? "active" : "done",
        etaMs: r.etaMs,
        // Clicking a job goes to its paper when one exists, else to
        // the Projects panel where its run card lives.
        ...(!active && r.deliverablePath !== null ? { path: r.deliverablePath } : { panelTarget: "projects" }),
      })
      solid(pid, `job:${r.runId}`)
    }
    for (const a of p.assets.slice(0, 10)) {
      const id = `asset:${a.kind}:${a.title}`
      nodes.push({
        id,
        kind: "asset",
        label: trunc(a.title, 52),
        sub: `${a.kind} · ${a.role}`,
        weight: 1.4,
        atMs: parseMs(a.addedAt),
        // A file asset opens; a reference asset goes to its project.
        ...(a.path !== undefined ? { path: a.path } : { panelTarget: "projects" }),
      })
      solid(pid, id)
    }
  }
  if (home.cards.length > 0) {
    nodes.push({
      id: "knowledge",
      kind: "knowledge",
      label: "Knowledge",
      sub: `${home.cards.length} knowledge card${home.cards.length === 1 ? "" : "s"}`,
      weight: 2.5,
      // The knowledge hub is as fresh as its freshest card.
      atMs: Math.max(0, ...home.cards.map((c) => parseMs(c.updated))),
      panelTarget: "memory",
    })
    solid("hub", "knowledge")
    for (const c of home.cards.slice(0, 6)) {
      const id = `subject:${c.title}`
      nodes.push({
        id,
        kind: "subject",
        label: trunc(c.title, 52),
        sub: c.proven > 0 ? `Proven ${c.proven}×` : "Not yet proven",
        weight: 1 + Math.min(c.proven, 5) * 0.15,
        // A subject's recency is its card's last update — a card
        // proven long ago sits with the older things (2026-10-13).
        atMs: parseMs(c.updated),
        preview: trunc(c.whenToUse, 110),
        panelTarget: "memory",
      })
      solid("knowledge", id)
    }
  }
  for (const c of home.chats.slice(0, 6)) {
    const id = `chat:${c.id}`
    nodes.push({
      id,
      kind: "chat",
      label: trunc(c.subject, 52),
      sub: `Chat · ${c.messages} messages`,
      weight: 1.6,
      atMs: c.at,
      panelTarget: "memory",
    })
    dotted("hub", id)
  }
  for (const m of home.memories.slice(0, 5)) {
    const id = `memory:${m.sessionId}`
    const first = m.summary.split(" — ")[0] ?? m.summary
    nodes.push({
      id,
      kind: "memory",
      label: trunc(first, 48),
      sub: `Memory · ${m.messageCount} messages`,
      weight: 1.3,
      atMs: m.archivedAt,
      preview: trunc(m.summary, 110),
      panelTarget: "memory",
    })
    dotted("hub", id)
  }
  if (home.journal !== null) {
    nodes.push({
      id: "journal",
      kind: "journal",
      label: "Journal",
      sub: `Private · updated ${agoText(home.journal.updatedAt, nowMs)} · ${home.journal.chars} chars`,
      weight: 2,
      atMs: home.journal.updatedAt,
      panelTarget: "presence",
    })
    dotted("hub", "journal")
  }
  for (const r of home.recents.slice(0, 5)) {
    const id = `recent:${r.path}`
    nodes.push({
      id,
      kind: "recent",
      label: trunc(r.title, 52),
      sub: "Recent document",
      weight: 1,
      atMs: r.at,
      path: r.path,
    })
    dotted("hub", id)
  }
  const kept = nodes.slice(0, MAX_NODES)
  const keptIds = new Set(kept.map((n) => n.id))
  return { nodes: kept, edges: edges.filter((e) => keptIds.has(e.a) && keptIds.has(e.b)) }
}
