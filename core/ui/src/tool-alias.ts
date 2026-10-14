/**
 * tool-alias.ts — user-meaningful display names for tools (2026-10-12).
 *
 * Kimler's rules: the tool tags under chat bubbles show a plain-language
 * ALIAS — exactly ONE word — never the raw function name. The real name
 * stays in the data (toolsUsed, traces) and in troubleshooting surfaces;
 * the tag's hover tooltip carries the tool's conclusion (see view.ts).
 *
 * Every tool AImy can call has an entry here. An unknown name falls back
 * to the first word of its humanized last segment ("acme.fetchRows" ->
 * "Fetch"), so a future tool can never leak a raw dotted name — or a
 * multi-word label — into the chat UI before its alias lands.
 */

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  // Builtin tools (agent-loop/src/tools.ts registry).
  "clock.now": "Time",
  "session.info": "Session",
  "job.spawn": "Delegated",
  "narrate": "Spoke",
  "journal.write": "Journaled",
  "capability.correct": "Corrected",
  "capability.request": "Requested",
  "drawer.preview": "Shown",
  "drawer.edit": "Edited",
  "drawer.close": "Closed",
  "drawer.getState": "Inspected",
  "drawer.reorder": "Reordered",
  "knowledge.list": "Browsed",
  "knowledge.read": "Recalled",
  "knowledge.write": "Learned",
  "project.list": "Projects",
  "project.create": "Created",
  "project.declare": "Switched",
  "project.link": "Linked",
  "project.move": "Moved",
  "research.status": "Progress",
  "doc.list": "Listed",
  "doc.read": "Read",
  "doc.write": "Saved",
  // Module tools (installed via the module seam as extraTools).
  "retrieval.query": "Search",
  "retrieval.news": "News",
  "retrieval.images": "Images",
  "retrieval.videos": "Videos",
  "research.query": "Research",
}

/** Humanize one name segment: "fetchRows" / "fetch_rows" -> "Fetch Rows". */
const humanizeSegment = (segment: string): string =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")

/** The one-word display alias for a tool name; never a raw dotted name. */
export const toolAlias = (name: string): string => {
  const known = TOOL_ALIASES[name]
  if (known !== undefined) return known
  const last = name.split(".").pop() ?? name
  const first = humanizeSegment(last).split(" ")[0] ?? ""
  return first !== "" ? first : "Tool"
}
