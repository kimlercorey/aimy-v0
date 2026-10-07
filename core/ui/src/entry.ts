/**
 * ui/src/entry.ts — boots the shell. Imported only by the desktop host;
 * never imported by app.ts or by tests (README pattern: entry boots,
 * app stays side-effect free).
 */
import { Runtime } from "foldkit"
import { makeShellApplication } from "./app.js"

// Minimal DOM-surface declaration: this package compiles without DOM lib
// types, and the entry point is the only place that touches the document.
declare const document:
  | { getElementById(id: string): unknown }
  | undefined

const container = document?.getElementById("root") ?? null

Runtime.run(makeShellApplication(container))
