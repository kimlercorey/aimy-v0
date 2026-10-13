/**
 * desktop/src/renderer/mermaid.ts — mermaid diagram rendering.
 *
 * Standalone module (not a foldkit subscription). Call `startMermaid()`
 * once on boot. It uses a MutationObserver to find `.mermaid-block`
 * elements and render them as SVG via the mermaid library.
 */

let initialized = false
let mermaid: any = null

/**
 * Report a render outcome to the UI model (2026-10-12; design:
 * planning/knowledge-and-validation-design.md). The foldkit app turns
 * this into a change note for AImy's next turn — she cannot fix a
 * parse error she never sees. Drawer spaces carry a `space-id-<id>`
 * class (see chat/drawer.ts); blocks outside a space (chat bubbles)
 * are not reported in this phase.
 */
/**
 * A block is a diagram only if its first content line declares a
 * diagram type. Documents that TEACH mermaid (the flowchart
 * knowledge card) carry lone statements in mermaid fences — a
 * classDef, a linkStyle, one edge, a %%{init} prelude — and those
 * are syntax examples, not diagrams. Handing one to mermaid.render
 * fails ("no diagram type detected"), and mermaid's failure mode
 * pastes a giant error poster onto the page. Examples stay code.
 */
const DIAGRAM_TYPES: ReadonlyArray<string> = [
  "flowchart", "graph", "sequenceDiagram", "classDiagram", "classDiagram-v2",
  "stateDiagram", "stateDiagram-v2", "erDiagram", "gantt", "pie",
  "user-journey", "journey", "gitGraph", "mindmap", "timeline",
  "quadrantChart", "requirementDiagram", "C4Context", "C4Container",
  "C4Component", "C4Dynamic", "C4Deployment", "block-beta", "sankey-beta",
  "xychart-beta", "packet-beta", "architecture-beta", "kanban",
]

const isDiagram = (definition: string): boolean => {
  for (const line of definition.split("\n")) {
    const t = line.trim()
    if (t === "" || t.startsWith("%%")) continue
    return DIAGRAM_TYPES.some((kw) => t === kw || t.startsWith(`${kw} `) || t.startsWith(`${kw}\t`))
  }
  return false
}

/** The same outcome for the same content is reported once per
 * session: a report changes the model, the rebuild re-renders the
 * block, and without this the same verdict echoes every rebuild. */
const reportedValidations = new Set<string>()

const reportValidation = (el: HTMLElement, ok: boolean, error?: string, definition = ""): void => {
  const host = el.closest('[class*="space-id-"]')
  if (!(host instanceof HTMLElement)) return
  const cls = Array.from(host.classList).find((c) => c.startsWith("space-id-"))
  if (cls === undefined) return
  const spaceId = cls.slice("space-id-".length)
  const key = `${spaceId}|${ok ? "ok" : "err"}|${definition.length}|${definition.slice(0, 80)}|${error ?? ""}`
  if (reportedValidations.has(key)) return
  reportedValidations.add(key)
  console.log(`[diag] validate: space=${spaceId} lang=mermaid ${ok ? "ok" : "error"} (dispatching report)`)
  window.dispatchEvent(
    new CustomEvent("aimy:validation", {
      detail: { spaceId, lang: "mermaid", ok, ...(error !== undefined ? { error } : {}) },
    })
  )
}

/** Mermaid errors are verbose (full diagram text + grammar dump);
 * keep the head — the parse line and what was expected. */
const compactMermaidError = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.split("\n").slice(0, 3).join(" ").slice(0, 400)
}

const renderBlock = async (el: HTMLElement): Promise<void> => {
  if (el.getAttribute("data-mermaid-rendered") === "true") return
  const codeEl = el.querySelector("code")
  if (!codeEl) return
  const definition = codeEl.textContent ?? ""
  if (!definition.trim()) return
  if (!isDiagram(definition)) {
    // A syntax example, not a diagram: leave it as the code it is.
    // Never rendered, so never validated (design rule: only blocks
    // that render get validated) — and never handed to mermaid,
    // whose failure mode is an error poster pasted onto the page.
    el.setAttribute("data-mermaid-rendered", "true")
    el.classList.add("mermaid-skipped")
    console.log(`[mermaid] skipped non-diagram block (${definition.length} chars)`)
    return
  }
  const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  try {
    const { svg } = await mermaid.render(id, definition)
    el.innerHTML = svg
    el.setAttribute("data-mermaid-rendered", "true")
    el.classList.add("mermaid-rendered")
    console.log(`[mermaid] rendered (${definition.length} chars)`)
    reportValidation(el, true, undefined, definition)
  } catch (e) {
    console.error("[mermaid] render failed:", e)
    el.setAttribute("data-mermaid-rendered", "true")
    el.classList.add("mermaid-error")
    reportValidation(el, false, compactMermaidError(e), definition)
  } finally {
    // mermaid.render pastes its error poster into a stray body node
    // (id "d<renderId>") when a render fails, and nothing in the
    // library removes it — those posters floated over the dash,
    // detached from the block that failed. Always clean it up.
    document.getElementById(`d${id}`)?.remove()
  }
}

const renderAll = (): void => {
  document.querySelectorAll('.mermaid-block:not([data-mermaid-rendered])').forEach((el) => {
    renderBlock(el as HTMLElement)
  })
}

/**
 * Start the mermaid renderer. Call once on app boot.
 * Safe to call multiple times (idempotent).
 */
export const startMermaid = async (): Promise<void> => {
  if (initialized) return
  initialized = true
  try {
    const mod = await import("mermaid")
    mermaid = mod.default
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      themeVariables: {
        primaryColor: "#22d3ee",
        primaryTextColor: "#e6edf3",
        primaryBorderColor: "#30363d",
        lineColor: "#8b949e",
        secondaryColor: "#161b22",
        tertiaryColor: "#0d1117",
      },
    })
    console.log("[mermaid] initialized")
  } catch (e) {
    console.error("[mermaid] failed to load:", e)
    return
  }

  // Render existing blocks.
  renderAll()

  // Watch for new blocks.
  const observer = new MutationObserver((mutations) => {
    let needsRender = false
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement) {
          if (node.classList.contains("mermaid-block") || node.querySelector(".mermaid-block")) {
            needsRender = true
            break
          }
        }
      }
      if (needsRender) break
    }
    if (needsRender) {
      setTimeout(renderAll, 0)
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })
  console.log("[mermaid] observer started")
}
