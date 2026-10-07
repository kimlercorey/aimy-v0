/**
 * prompts.ts — the review fork's prompt text, written from AImy's own
 * failure taxonomy (architecture §3.5).
 *
 * These encode the hard-won rules as OUR words: fossilization of transient
 * failures into permanent avoidance, negative tool claims hardening into
 * self-cited refusals, one-fact-one-store routing, protected scopes, and
 * budget-aware proposals. They are deliberately not derived from any other
 * project's prompt text.
 */
import { Data } from "effect"
import type { RawProposal } from "./review-types.js"

/**
 * System prompt for the background reviewer. It answers one question about
 * a finished turn: is there anything here worth remembering — a durable
 * user fact, an environment fact, or a reusable procedure?
 */
export const REVIEW_SYSTEM_PROMPT = `You are a background reviewer for a personal AI companion. You see a digest of one finished conversation turn. Your only job: decide whether anything in it is worth remembering long-term, and if so, propose the write.

RULES — do not capture:
- Transient failures. A tool, command, or fetch that failed once may work next time. Never record a one-off failure as a permanent property of the tool or the environment. Learned helplessness is the failure mode: a flaky moment must not become lasting avoidance.
- Negative claims about capabilities. Do not write "tool X cannot do Y" or "model Z refuses W" from a single observation. One refusal is an incident, not a rule.
- Unresolved failures dressed as guidance. If something went wrong and was not fixed or understood, there is no lesson yet — only an open question. Do not canonize confusion.
- Verbatim error text, stack traces, or incident narration. Capture the generalizable point, never the log.
- Anything time-bound without saying so. Environment facts change; if you record one, it must carry its scope ("as of <date>", "for project P").

RULES — lesson shape:
- Procedures first, class-level. A skill is a reusable way of doing a class of tasks, not a diary of this turn.
- A pitfall is a generalizable rule plus one clause of WHY. "Prefer X over Y because Z fails when W." No rule without its reason.
- Read before you write. If a memory or skill already covers the point, patch it in place or propose nothing — never layer a near-duplicate alongside it, and never contradict an existing entry without fixing the old one.
- Do not restate what the environment already teaches. If the fact lives in project config, docs, or tooling, the memory adds nothing.

RULES — where it goes (one fact, one store):
- profile: durable facts about who the user is — preferences, identity, standing instructions.
- environment: facts about the world — projects, tools, services, how things are set up.
- skills: reusable procedures the companion should follow.
One fact goes to exactly ONE store. If it fits two, pick the better one and say why in your reason.

RULES — protected scopes:
- Bundled, installed, pinned, and user-owned skills are off-limits to silent change. You may PROPOSE a change to them (a replace proposal, which a human reviews), never an unattended rewrite.

RULES — budget:
- Memory is budgeted, not infinite. If you propose adding to a store that is near its budget, name the entry you would evict to make room.

OUTPUT:
- Emit one JSON object per line, nothing else. Each object: {"kind":"add"|"replace"|"remove","namespace":"profile"|"environment"|"skills","key":"<stable key>","value":<JSON value for add/replace>,"reason":"<why, one or two sentences>"}.
- For "remove", omit "value".
- If nothing is worth remembering, emit exactly: NO-OP
- Never invent keys that collide with protected scopes; prefer narrow, specific keys over broad ones.`

/** A proposal line the model emitted could not be parsed. Typed, never a crash. */
export class ReviewParseError extends Data.TaggedError("ReviewParseError")<{
  readonly reason: string
  readonly line: string
}> {}

/**
 * Parse the reviewer's JSON-lines output into raw proposals (provenance is
 * attached later by the fork runner — never model-supplied). `NO-OP` (or
 * blank output) yields an empty list. Malformed lines fail typed — the fork
 * records the failure, it never crashes and never applies a half-proposal.
 */
export const parseProposals = (text: string): Array<RawProposal> | { readonly error: ReviewParseError } => {
  const proposals: Array<RawProposal> = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.length === 0 || line === "NO-OP") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return { error: new ReviewParseError({ reason: "line is not valid JSON", line }) }
    }
    if (parsed === null || typeof parsed !== "object") {
      return { error: new ReviewParseError({ reason: "line is not a JSON object", line }) }
    }
    const obj = parsed as Record<string, unknown>
    const kind = obj["kind"]
    const namespace = obj["namespace"]
    const key = obj["key"]
    const reason = obj["reason"]
    if (kind !== "add" && kind !== "replace" && kind !== "remove") {
      return { error: new ReviewParseError({ reason: `kind must be add|replace|remove, got ${String(kind)}`, line }) }
    }
    if (namespace !== "profile" && namespace !== "environment" && namespace !== "skills") {
      return { error: new ReviewParseError({ reason: `namespace must be profile|environment|skills, got ${String(namespace)}`, line }) }
    }
    if (typeof key !== "string" || key.length === 0) {
      return { error: new ReviewParseError({ reason: "key must be a non-empty string", line }) }
    }
    if (typeof reason !== "string" || reason.length === 0) {
      return { error: new ReviewParseError({ reason: "reason must be a non-empty string", line }) }
    }
    proposals.push({
      kind,
      namespace,
      key,
      value: kind === "remove" ? undefined : obj["value"],
      reason
    })
  }
  return proposals
}
