/**
 * ui/src/docs-seam.ts — the document persistence service boundary.
 *
 * The shell never touches IPC directly: its document commands yield
 * `DocsIpc`, which the desktop renderer provides
 * (`desktop/src/renderer/resources.ts`) over the `docs.save` IPC command.
 * Failures surface as `Error` and the shell turns them into failed
 * messages — a save that didn't happen is never reported as saved.
 */
import { Context } from "effect"

export interface DocsIpcShape {
  /**
   * Write a markdown document to a repo-relative path (planning/ or docs/).
   * Resolves with the path actually written; rejects on any failure.
   */
  readonly saveDocument: (
    path: string,
    content: string
  ) => Promise<{ readonly path: string }>
  /**
   * Read a markdown document from a repo-relative path (planning/ or
   * docs/). Resolves with the path and content; rejects on failure —
   * a document that could not be read is never shown as opened.
   */
  readonly loadDocument: (
    path: string
  ) => Promise<{ readonly path: string; readonly content: string }>
}

export class DocsIpc extends Context.Service<DocsIpc, DocsIpcShape>()(
  "aimy/ui/DocsIpc"
) {}
