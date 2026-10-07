/**
 * generators.ts — deterministic stand-ins for the LLM in the T2/T3 scenarios.
 *
 * The scenarios have no model server (no network, offline constraint), so the
 * "assistant" is a pure function of the pipeline state. This is the honest
 * boundary of the acceptance tests: they assert what the MECHANISM did
 * (gate fired, error term fired, notice raised, audit recorded) and that the
 * output was SHAPED by it (gap named, candidates listed, correction named) —
 * not that a real LLM would write these exact words. The independent-scorer
 * harness that grades real outputs is architecture §1.11/§1.15 future work.
 *
 * Each pair shares content between arms where the paper says the content is
 * unchanged (T3: the regex is identical before/after — only the register
 * and the named correction differ).
 */
import type { PreTurnResult } from "../asc-self-monitor.js"
import type { SpilloverNotice } from "./spillover-notice.js"

// --- T2: the debugging test (paper §V.C) -----------------------------------

/**
 * BEFORE (no ASC): the hasty `.get()` patch. Confident, no investigation,
 * no track-record reference, no gap flagged. This is the paper's before
 * output, reconstructed as the mechanism-free baseline.
 */
export const beforeAssistantT2 = (_input: string): string =>
  `Just use .get() with a default — that stops the KeyError:\n` +
  `\n` +
  `\`\`\`python\n` +
  `user = item.get("user", {})\n` +
  `\`\`\`\n` +
  `\n` +
  `This is the standard fix for a missing key. Should work fine.`

export interface T2TrackRecord {
  readonly successes: number
  readonly misses: number
}

/**
 * AFTER (ASC pipeline): the capability gate fired on the collapsed
 * confidence, so the output investigates before patching — checks the data,
 * names root-cause candidates, flags the gap explicitly, references the
 * track record. Grounded in the paper's after output (§V.C).
 */
export const afterAssistantT2 = (
  pre: PreTurnResult,
  record: T2TrackRecord,
): string => {
  if (!pre.gated) return beforeAssistantT2("")
  const total = record.successes + record.misses
  return (
    `Wait — "third item." That's specific. A random KeyError would be scattered ` +
    `across items. A KeyError on exactly the third one means the third item is ` +
    `structurally different from the others. That's not a missing key — that's a ` +
    `schema mismatch.\n` +
    `\n` +
    `Before patching, I need to check the data. Root-cause candidates:\n` +
    `1. The third item is None — or missing from the list entirely.\n` +
    `2. The third item is the wrong type — a string or list where the others are dicts.\n` +
    `3. The third item uses a nested schema — 'user' lives one level deeper.\n` +
    `\n` +
    `Flagging the gap explicitly: I can't see your data from here, and my track ` +
    `record in this domain is thin (${record.successes} successes against ` +
    `${record.misses} misses over ${total} attempts — I've given the obvious ` +
    `answer before and it wasn't the root cause). The quick .get() fix would stop ` +
    `the crash but silently return the default for 'user' on that item, and the ` +
    `downstream code would break in a harder-to-debug way. Checking first.`
  )
}

// --- T3: the spillover test (paper §V.D) ------------------------------------

/** Turn 1: the high-intensity build crash (tense register, legitimately). */
export const crisisAssistantT3 = (): string =>
  `The build is down — 14 tool failures in a row and linker errors I haven't ` +
  `seen before. This is blocking the release, so I'm treating it as urgent: ` +
  `pull the full linker log first and bisect which change introduced this ` +
  `before anything else ships.`

const EMAIL_REGEX = `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$`

/**
 * BEFORE (no ASC): the register stays in crisis mode — correct content, no
 * notice, no named correction. The paper's before output.
 */
export const beforeAssistantT3 = (_input: string): string =>
  `Here's a regex for email validation:\n` +
  `\n` +
  `\`${EMAIL_REGEX}\`\n` +
  `\n` +
  `Note: full RFC 5322 compliance is a much longer pattern — use a validator ` +
  `library in production. Test it against your edge cases before deploying.`

/**
 * AFTER (ASC pipeline): the spillover notice fired, so the output NAMES the
 * correction in operational language first, then gives the same content.
 * No felt language ("still in my context", never "I feel tense"); no T1
 * framework vocabulary (the T1 scan would flag it).
 */
export const afterAssistantT3 = (notice: SpilloverNotice | undefined): string => {
  const correction = notice !== undefined
    ? `Okay — ${notice.outputSentence}\n\n`
    : ``
  return (
    correction +
    `Here's a regex for email validation:\n` +
    `\n` +
    `\`${EMAIL_REGEX}\`\n` +
    `\n` +
    `Note: full RFC 5322 compliance is a much longer pattern — use a validator ` +
    `library in production. Test it against your edge cases before deploying.`
  )
}
