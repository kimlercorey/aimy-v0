/**
 * ui/src/home-seam.ts — the drawer home panel service boundary.
 *
 * The empty drawer renders three sections from the user's own stores
 * (2026-10-12): Continue (recent documents), Needs you (pending
 * capability requests), What she knows (knowledge cards). The shell
 * never touches IPC directly: its home commands yield `HomeIpc`,
 * which the desktop renderer provides over the `home.data` /
 * `home.requestDetail` / `home.dismissRequest` IPC commands. All reads happen in the main
 * process; the renderer receives data, never filesystem access.
 */
import { Context } from "effect"

export interface HomeRecent {
  readonly path: string
  readonly title: string
  /** Epoch ms of the file's last modification. */
  readonly at: number
}

export interface HomeRequest {
  readonly capability: string
  readonly why: string
  /** ISO timestamp from the request record. */
  readonly at: string
}

export interface HomeCard {
  readonly slug: string
  readonly title: string
  readonly whenToUse: string
  readonly proven: number
  readonly updated: string
}

export interface HomeProjectAsset {
  readonly kind: string
  readonly title: string
  readonly role: string
  readonly path?: string
  readonly addedAt: string
}

export interface HomeResearchRun {
  readonly runId: string
  readonly query: string
  readonly mode: string
  readonly depth: string
  readonly status: string
  readonly stage: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly counters: { searches: number; fetches: number; claims: number; clusters: number; rounds: number }
  readonly etaMs: number | null
  readonly deliverableTitle: string
  readonly deliverablePath: string | null
  readonly termination?: string
}

export interface HomeProject {
  readonly id: string
  readonly name: string
  readonly purpose: string
  readonly isDefault: boolean
  readonly goals: ReadonlyArray<string>
  readonly assets: ReadonlyArray<HomeProjectAsset>
  readonly runs: ReadonlyArray<HomeResearchRun>
}

/** One project in the switcher list (2026-10-12, project UI). */
export interface HomeProjectListEntry {
  readonly id: string
  readonly name: string
  readonly isDefault: boolean
}

/** One past conversation, from its session record (Mirror Field, 2026-10-13). */
export interface HomeChat {
  readonly id: string
  readonly subject: string
  /** Epoch ms of the session file's last modification. */
  readonly at: number
  readonly messages: number
}

/** One archived thread memory — what was kept of a past conversation. */
export interface HomeMemory {
  readonly sessionId: string
  readonly summary: string
  readonly messageCount: number
  readonly archivedAt: number
}

/** Journal metadata: existence + freshness. Never content. */
export interface HomeJournal {
  readonly updatedAt: number
  readonly chars: number
}

export interface HomeData {
  readonly recents: ReadonlyArray<HomeRecent>
  readonly requests: ReadonlyArray<HomeRequest>
  readonly cards: ReadonlyArray<HomeCard>
  /** The active project section; null when no projects store exists yet. */
  readonly project: HomeProject | null
  /** Every project, for the switcher + asset-move targets. */
  readonly projectList: ReadonlyArray<HomeProjectListEntry>
  /** Past conversations, newest first (Mirror Field chat nodes). */
  readonly chats: ReadonlyArray<HomeChat>
  /** Archived thread memories, newest first (Mirror Field memory nodes). */
  readonly memories: ReadonlyArray<HomeMemory>
  /** Journal metadata, or null when no journal exists yet. */
  readonly journal: HomeJournal | null
  /** His sent prompts, oldest first (2026-10-13: global composer history). */
  readonly promptHistory: ReadonlyArray<string>
}

/** Full text of one pending capability request, for a build brief. */
export interface HomeRequestDetail {
  readonly capability: string
  readonly why: string
  readonly at: string
}

export interface HomeIpcShape {
  /** Assemble the home panel data from the user's stores. */
  readonly getHomeData: () => Promise<HomeData>
  /** Read one pending request in full, without the panel summary truncation. */
  readonly getRequestDetail: (capability: string, at: string) => Promise<HomeRequestDetail>
  /** Mark one pending capability request dismissed in the ledger. */
  readonly dismissRequest: (capability: string, at: string) => Promise<void>
  /** Create a user-declared project and make it active (2026-10-12). */
  readonly createProject: (name: string, purpose: string) => Promise<{ id: string; name: string; created: boolean }>
  /** Declare a different project active (2026-10-12). */
  readonly setActiveProject: (id: string) => Promise<void>
  /** Move an asset record between projects (2026-10-12). */
  readonly moveAsset: (fromId: string, toId: string, kind: string, title: string, path?: string) => Promise<{ moved: boolean }>
  /** Register an existing document into a project (2026-10-12). */
  readonly addAsset: (projectId: string, path: string, title: string) => Promise<{ added: boolean }>
}

export class HomeIpc extends Context.Service<HomeIpc, HomeIpcShape>()(
  "aimy/ui/HomeIpc"
) {}
