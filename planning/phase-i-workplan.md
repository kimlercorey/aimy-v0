# PHASE I Workplan: Document Collaboration Harness

**Date:** 2026-10-12  
**Status:** Planned. Not yet implemented.  
**Goal:** Unblock creating research briefs, market analysis, proposals, and
capability charters TODAY.

## The Urgent Need

Say "research X, draft a brief" and get a document you can iterate on
together with AImy. That's it. Everything else is Phase II.

## Scope: Four Pieces, Nothing More

### 1. Preview Bundle (hardcoded)

No registry yet. Just a drawer panel that renders markdown. She calls
`drawer.preview` with the draft, you see it in the right-hand drawer.

### 2. Collaborative Editing (the 3rd space function)

Not preview (look). Not execute (run). **Co-evolve**: the document text
lives in a shared state proxy. You edit a paragraph in the drawer → she
sees it. She proposes a revision → you see the diff. Both parties shape
the artifact through the proxy.

### 3. Research → Draft → Iterate Workflow

She already has `retrieval.query` (web search) and `job.spawn` (long-running
research). The workflow:

1. You: "Research quantum sensors, draft a market brief"
2. She: researches (job.spawn), synthesizes, calls `drawer.preview` with draft
3. You: read in drawer, edit directly or say "expand section 3"
4. She: updates via state proxy, you see it live
5. Repeat until done, then save

### 4. Save

Final document goes to a file. Done.

## Deliberately Excluded from Phase I

- **Full bundle registry** — hardcode preview, generalize later
- **Projects navigation** — the attribution problem ("one chat, three
  projects") is real and hard. For now: save with manual filenames.
- **LoRAs** (communication, product, personality, domain) — future
- **tool.create gating** — needs the bundle harness first (see DESIGN.md)
- **The aspirational list** (technical writing excellence, scientific method,
  bias de-programming, entrepreneurship, etc.) — these are *content*, not
  infrastructure. Phase I provides the harness; domain knowledge fills it later.

## Phase II (Later)

Bundle registry, drawer spaces (configurable slots), tool.create gating,
projects with proper attribution, communication LoRA, domain LoRAs,
bundle marketplace.

## Success Criteria

You can say "research X, draft a brief" and within minutes have a document
in the drawer that you can edit together with AImy in real time, then save
the final version. That's the whole thing.
