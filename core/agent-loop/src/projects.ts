/**
 * projects.ts — Projects: user-declared containers for related work
 * (2026-10-12; design: planning/projects-design.md).
 *
 * A project holds related chats, assets, goals, requests, and research
 * runs. Rules (Kimler's spec): projects are USER-DECLARED only (AImy
 * never creates one unasked); one project — Default — always exists and
 * catches work done with nothing declared; the declared project is the
 * active intention, and assets produced while it is active register
 * into it; a chat links to as many projects as it touches (attribution
 * lives on the artifact, never exclusively on the conversation); when
 * work in Default looks like it deserves a project, she may SUGGEST one
 * — once per work thread, never twice (suggestions are recorded).
 *
 * Store: ~/.aimy/projects/ — index.json plus one directory per project
 * holding project.json (and research/<runId>/ state, charter E14).
 * Plain sync fs in the capabilities.ts / knowledge.ts idiom: defensive
 * reads (corrupt data degrades to Default, never a crash), logged
 * mutations, no silent failures.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface ProjectAsset {
  readonly kind: "document" | "paper" | "brief" | "research-run" | "request" | "card" | "file"
  readonly title: string
  readonly role: "precursor" | "deliverable" | "reference"
  readonly path?: string
  readonly runId?: string
  readonly requestKey?: string
  readonly addedAt: string
  readonly originSessionId?: string
}

export interface Project {
  readonly id: string
  readonly name: string
  readonly purpose: string
  readonly isDefault: boolean
  readonly status: "active" | "archived"
  readonly createdAt: string
  readonly chatSessionIds: ReadonlyArray<string>
  readonly assets: ReadonlyArray<ProjectAsset>
  readonly goals: ReadonlyArray<string>
}

export interface ProjectIndexEntry {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly status: "active" | "archived"
}

export interface ProjectSuggestion {
  readonly key: string
  readonly note: string
  readonly at: string
}

export interface ProjectsIndex {
  readonly version: 1
  readonly activeProjectId: string
  readonly projects: ReadonlyArray<ProjectIndexEntry>
  readonly suggestions: ReadonlyArray<ProjectSuggestion>
}

export const DEFAULT_PROJECT_ID = "default"

const projectsDir = (): string => path.join(os.homedir(), ".aimy", "projects")
const indexPath = (): string => path.join(projectsDir(), "index.json")
const projectDir = (id: string): string => path.join(projectsDir(), id)
const projectPath = (id: string): string => path.join(projectDir(id), "project.json")

/** Project ids are slugs; "default" is reserved for the Default project. */
export const isValidProjectId = (id: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(id)

/** Slugify a declared project name into an id stem. */
export const projectSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"

const defaultProject = (at: string): Project => ({
  id: DEFAULT_PROJECT_ID,
  name: "Default",
  purpose: "Work done with no project declared.",
  isDefault: true,
  status: "active",
  createdAt: at,
  chatSessionIds: [],
  assets: [],
  goals: [],
})

const emptyIndex = (at: string): ProjectsIndex => ({
  version: 1,
  activeProjectId: DEFAULT_PROJECT_ID,
  projects: [{ id: DEFAULT_PROJECT_ID, name: "Default", createdAt: at, status: "active" }],
  suggestions: [],
})

const writeJson = (file: string, value: unknown): boolean => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8")
    return true
  } catch (e) {
    console.error(`[aimy] projects: write failed for ${file} (${e instanceof Error ? e.message : e})`)
    return false
  }
}

/** Read the index; a missing/corrupt index degrades to a fresh Default-only index. */
export const readProjectsIndex = (): ProjectsIndex => {
  const at = new Date().toISOString()
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), "utf8")) as Partial<ProjectsIndex>
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return emptyIndex(at)
    const projects = parsed.projects.filter(
      (p): p is ProjectIndexEntry =>
        typeof p?.id === "string" && isValidProjectId(p.id) && typeof p?.name === "string"
    )
    if (!projects.some((p) => p.id === DEFAULT_PROJECT_ID)) {
      projects.unshift({ id: DEFAULT_PROJECT_ID, name: "Default", createdAt: at, status: "active" })
    }
    const activeProjectId =
      typeof parsed.activeProjectId === "string" && projects.some((p) => p.id === parsed.activeProjectId)
        ? parsed.activeProjectId
        : DEFAULT_PROJECT_ID
    return {
      version: 1,
      activeProjectId,
      projects,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    }
  } catch {
    return emptyIndex(at)
  }
}

/** Read one project record; undefined when missing or corrupt. */
export const readProject = (id: string): Project | undefined => {
  if (!isValidProjectId(id)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(projectPath(id), "utf8")) as Partial<Project>
    if (parsed.id !== id || typeof parsed.name !== "string") return undefined
    return {
      id,
      name: parsed.name,
      purpose: typeof parsed.purpose === "string" ? parsed.purpose : "",
      isDefault: id === DEFAULT_PROJECT_ID,
      status: parsed.status === "archived" ? "archived" : "active",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      chatSessionIds: Array.isArray(parsed.chatSessionIds) ? parsed.chatSessionIds.filter((s) => typeof s === "string") : [],
      assets: Array.isArray(parsed.assets) ? parsed.assets : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals.filter((g) => typeof g === "string") : [],
    }
  } catch {
    return undefined
  }
}

const writeProject = (project: Project): boolean => writeJson(projectPath(project.id), project)

const writeIndex = (index: ProjectsIndex): boolean => writeJson(indexPath(), index)

/**
 * Ensure the store exists: Default project + index seeded on first use.
 * Idempotent; safe to call every turn. Returns the current index.
 */
export const ensureProjectsStore = (): ProjectsIndex => {
  const at = new Date().toISOString()
  let index = readProjectsIndex()
  if (readProject(DEFAULT_PROJECT_ID) === undefined) {
    writeProject(defaultProject(at))
    console.warn("[aimy] projects: seeded Default project")
  }
  if (!fs.existsSync(indexPath())) {
    writeIndex(index)
    index = readProjectsIndex()
  }
  return index
}

/** All projects (index order), skipping corrupt records. */
export const listProjects = (): Project[] => {
  const index = readProjectsIndex()
  const out: Project[] = []
  for (const entry of index.projects) {
    const p = readProject(entry.id)
    if (p !== undefined) out.push(p)
  }
  return out
}

/** The active project: the declared intention, else Default. Never undefined. */
export const getActiveProject = (): Project => {
  const index = ensureProjectsStore()
  return readProject(index.activeProjectId) ?? readProject(DEFAULT_PROJECT_ID) ?? defaultProject(new Date().toISOString())
}

/**
 * Record a user-declared project. Dedupes by slugified name: re-declaring
 * an existing name returns the existing project (declared = true only
 * when a new record was created). Does NOT change the active project —
 * declaration of intention is setActiveProject's job.
 */
export const createProject = (
  name: string,
  purpose: string
): { project: Project; created: boolean } => {
  ensureProjectsStore()
  const base = projectSlug(name)
  let id = base
  let n = 2
  while (readProject(id) !== undefined && readProject(id)?.name !== name) {
    id = `${base}-${n}`
    n += 1
  }
  const existing = readProject(id)
  if (existing !== undefined) return { project: existing, created: false }
  const at = new Date().toISOString()
  const project: Project = {
    id,
    name,
    purpose,
    isDefault: false,
    status: "active",
    createdAt: at,
    chatSessionIds: [],
    assets: [],
    goals: [],
  }
  writeProject(project)
  const index = readProjectsIndex()
  writeIndex({
    ...index,
    projects: [...index.projects, { id, name, createdAt: at, status: "active" }],
  })
  console.warn(`[aimy] projects: declared project "${name}" (id=${id})`)
  return { project, created: true }
}

/** Set the active project (the declared intention). False when unknown. */
export const setActiveProject = (id: string): boolean => {
  const index = ensureProjectsStore()
  if (readProject(id) === undefined) {
    console.warn(`[aimy] projects: setActiveProject refused — unknown project ${id}`)
    return false
  }
  writeIndex({ ...index, activeProjectId: id })
  console.warn(`[aimy] projects: active project is now ${id}`)
  return true
}

/** Link a chat (session) to a project. Many-to-many; idempotent. */
export const linkChatToProject = (projectId: string, sessionId: string): boolean => {
  const project = readProject(projectId)
  if (project === undefined) return false
  if (project.chatSessionIds.includes(sessionId)) return true
  const ok = writeProject({ ...project, chatSessionIds: [...project.chatSessionIds, sessionId] })
  if (ok) console.warn(`[aimy] projects: linked chat ${sessionId} to ${projectId}`)
  return ok
}

/** The dedupe key for an asset: same kind + same identity = same asset. */
const assetKey = (a: ProjectAsset): string =>
  `${a.kind}|${a.path ?? ""}|${a.runId ?? ""}|${a.requestKey ?? ""}|${a.title}`

/** Register an asset into a project. Idempotent by asset key. */
export const registerAsset = (projectId: string, asset: Omit<ProjectAsset, "addedAt">): boolean => {
  const project = readProject(projectId)
  if (project === undefined) return false
  const full: ProjectAsset = { ...asset, addedAt: new Date().toISOString() }
  if (project.assets.some((a) => assetKey(a) === assetKey(full))) return true
  const ok = writeProject({ ...project, assets: [...project.assets, full] })
  if (ok) console.warn(`[aimy] projects: asset registered in ${projectId}: [${full.kind}] ${full.title}`)
  return ok
}

/**
 * Remove an asset from a project by kind + path (2026-10-12): the
 * counterpart of registerAsset, used by capability preflight probes to
 * clean up their scratch registrations so verification leaves no trace
 * in the project's asset list. Returns true when something was removed.
 */
export const unregisterAsset = (
  projectId: string,
  match: { kind: ProjectAsset["kind"]; path: string }
): boolean => {
  const project = readProject(projectId)
  if (project === undefined) return false
  const kept = project.assets.filter((a) => !(a.kind === match.kind && a.path === match.path))
  if (kept.length === project.assets.length) return false
  return writeProject({ ...project, assets: kept })
}

/** Register an asset into the ACTIVE project; returns the project id used. */
export const registerAssetInActiveProject = (asset: Omit<ProjectAsset, "addedAt">): string => {
  const active = getActiveProject()
  registerAsset(active.id, asset)
  return active.id
}

/**
 * Move an asset between projects (2026-10-12): binding is by record, so a
 * move is a record edit — the underlying file NEVER moves. Identified by
 * kind + title (+ path when given). Returns false when the source project
 * holds no such asset or either project is unknown. If the target already
 * holds the asset (same key), the source copy is still removed.
 */
export const moveAsset = (
  fromId: string,
  toId: string,
  match: { kind: ProjectAsset["kind"]; title: string; path?: string }
): boolean => {
  if (fromId === toId) return false
  const from = readProject(fromId)
  const to = readProject(toId)
  if (from === undefined || to === undefined) return false
  const idx = from.assets.findIndex(
    (a) => a.kind === match.kind && a.title === match.title && (match.path === undefined || a.path === match.path)
  )
  if (idx < 0) {
    console.warn(`[aimy] projects: moveAsset found no [${match.kind}] "${match.title}" in ${fromId}`)
    return false
  }
  const asset = from.assets[idx]!
  const rest = from.assets.filter((_, i) => i !== idx)
  if (!writeProject({ ...from, assets: rest })) return false
  const assetNoDate: Omit<ProjectAsset, "addedAt"> = {
    kind: asset.kind,
    title: asset.title,
    role: asset.role,
    ...(asset.path !== undefined ? { path: asset.path } : {}),
    ...(asset.runId !== undefined ? { runId: asset.runId } : {}),
    ...(asset.requestKey !== undefined ? { requestKey: asset.requestKey } : {}),
    ...(asset.originSessionId !== undefined ? { originSessionId: asset.originSessionId } : {}),
  }
  registerAsset(toId, assetNoDate)
  console.warn(`[aimy] projects: asset moved ${fromId} -> ${toId}: [${asset.kind}] ${asset.title}`)
  return true
}

/**
 * Register an existing document (by path) into a project as a reference
 * asset (2026-10-12): the end-user "add this to the project" operation.
 * References, never copies — the file stays where it is.
 */
export const addDocumentAsset = (projectId: string, path: string, title: string): boolean =>
  registerAsset(projectId, { kind: "document", title, role: "reference", path })

/** Record that a project was suggested for this work thread (anti-nag). */
export const recordProjectSuggestion = (key: string, note: string): void => {
  const index = ensureProjectsStore()
  if (index.suggestions.some((s) => s.key === key)) return
  writeIndex({
    ...index,
    suggestions: [...index.suggestions, { key, note, at: new Date().toISOString() }],
  })
  console.warn(`[aimy] projects: suggestion recorded (key=${key})`)
}

/** True when a project was already suggested for this work thread. */
export const wasProjectSuggested = (key: string): boolean =>
  readProjectsIndex().suggestions.some((s) => s.key === key)

// ── Research runs (written host-side by the chat adapter, E16) ───────

export interface ResearchRunSummary {
  readonly runId: string
  readonly query: string
  readonly mode: string
  readonly depth: string
  readonly status: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly finishedAt?: string
  readonly stage: string
  readonly counters: { searches: number; fetches: number; claims: number; clusters: number; rounds: number }
  readonly etaMs: number | null
  readonly deliverableTitle: string
  readonly deliverablePath: string | null
  readonly termination?: string
}

/**
 * Read a project's research run records (newest first). Defensive: a
 * corrupt or partial run.json yields a minimal summary rather than
 * hiding the run — a crashed run must stay visible (E12).
 */
export const listResearchRuns = (projectId: string): ResearchRunSummary[] => {
  if (!isValidProjectId(projectId)) return []
  const dir = path.join(projectDir(projectId), "research")
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const runs: ResearchRunSummary[] = []
  for (const name of names) {
    const file = path.join(dir, name, "run.json")
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      const counters = (raw["counters"] ?? {}) as Record<string, unknown>
      const deliverable = (raw["deliverable"] ?? {}) as Record<string, unknown>
      const num = (v: unknown): number => (typeof v === "number" ? v : 0)
      runs.push({
        runId: typeof raw["runId"] === "string" ? raw["runId"] : name,
        query: typeof raw["query"] === "string" ? raw["query"] : "(unknown query)",
        mode: typeof raw["mode"] === "string" ? raw["mode"] : "answer",
        depth: typeof raw["depth"] === "string" ? raw["depth"] : "standard",
        status: typeof raw["status"] === "string" ? raw["status"] : "unknown",
        startedAt: typeof raw["startedAt"] === "string" ? raw["startedAt"] : "",
        updatedAt: typeof raw["updatedAt"] === "string" ? raw["updatedAt"] : "",
        ...(typeof raw["finishedAt"] === "string" ? { finishedAt: raw["finishedAt"] } : {}),
        stage: typeof raw["stage"] === "string" ? raw["stage"] : "",
        counters: {
          searches: num(counters["searches"]),
          fetches: num(counters["fetches"]),
          claims: num(counters["claims"]),
          clusters: num(counters["clusters"]),
          rounds: num(counters["rounds"])
        },
        etaMs: typeof raw["etaMs"] === "number" ? raw["etaMs"] : null,
        deliverableTitle: typeof deliverable["title"] === "string" ? deliverable["title"] : "",
        deliverablePath: typeof deliverable["path"] === "string" ? deliverable["path"] : null,
        ...(typeof raw["termination"] === "string" ? { termination: raw["termination"] } : {})
      })
    } catch {
      runs.push({
        runId: name,
        query: "(unreadable run record)",
        mode: "answer",
        depth: "standard",
        status: "unknown",
        startedAt: "",
        updatedAt: "",
        stage: "",
        counters: { searches: 0, fetches: 0, claims: 0, clusters: 0, rounds: 0 },
        etaMs: null,
        deliverableTitle: "",
        deliverablePath: null
      })
    }
  }
  return runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

/**
 * One compact block for the system prompt (knowledge-index idiom): the
 * active project and its shape. She works FROM the declared intention —
 * she doesn't have to ask which project she's in.
 */
export const activeProjectSummary = (): string => {
  const active = getActiveProject()
  const all = listProjects()
  const counts = `${active.assets.length} asset${active.assets.length === 1 ? "" : "s"}, ${active.chatSessionIds.length} linked chat${active.chatSessionIds.length === 1 ? "" : "s"}`
  if (active.isDefault) {
    return (
      `ACTIVE PROJECT: Default (no project declared). Work produced now lands in Default. ` +
      `If this work is really a project of its own, you may SUGGEST declaring one — never create one unasked. ` +
      (all.length > 1
        ? `Declared projects: ${all.filter((p) => !p.isDefault).map((p) => `"${p.name}" (${p.id})`).join(", ")}.`
        : `No projects declared yet.`)
    )
  }
  return (
    `ACTIVE PROJECT: "${active.name}" (${active.id}) — ${active.purpose} · ${counts}. ` +
    `Assets you produce now are delivered into this project. Other projects: ${
      all.filter((p) => p.id !== active.id).map((p) => `"${p.name}" (${p.id})`).join(", ") || "none"
    }.`
  )
}
