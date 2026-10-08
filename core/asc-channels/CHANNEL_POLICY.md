# Channel Content Policy: Presented vs. Spoken vs. Emoted

How AImy decides what goes to each output channel when a turn fans out.

## The three channels

| Channel | Medium | Source | Purpose |
|---------|--------|--------|---------|
| **Presented** | Chat text | Full model output, unmodified | Archival record. Everything the user can re-read, copy, click. |
| **Spoken** | TTS audio | `toSpeakable(text)` | What a human can listen to. Conversational prose only. |
| **Emoted** | FACS timeline | ASC dials at turn time | The agent's affective state made visible. Not a mirror of content. |

## Presented: everything

The chat channel shows the model's full text exactly as generated: markdown,
code blocks, tables, links, tool-call residues, all of it. This is the source
of truth. If the user wants to copy code, click a link, or re-read a table,
it's here.

No filtering. No summarization. What the model said is what the user sees.

## Spoken: human-listenable prose

The voice channel speaks a version a human can *listen to*. This is not the
same as the displayed text.

### Mechanical layer (`toSpeakable`, deterministic)

Already implemented in `speakable.ts`. Strips or reduces:

- Fenced code blocks → dropped entirely (speech can't render code)
- Inline code → kept as words (`` `foo` `` → "foo")
- Tables → cell pipes become commas, separator rows dropped
- URLs → dropped (bare) or reduced to link text
- Markdown formatting → stripped (bold, italic, headings, blockquotes)
- Images → alt text only
- HTML tags → dropped

Paragraph breaks are preserved as natural speech pauses.

### Semantic layer (policy, not yet implemented)

Beyond mechanical stripping, the spoken channel should differ in *what*
information it carries:

1. **Length cap.** Don't speak a 2000-word response. If `toSpeakable` output
   exceeds ~500 words, speak a summary lead ("Here's the summary — full
   details are in chat.") This needs a summarization step (model call or
   extractive).

2. **No tool residue.** If the model emits ```aimy-tool blocks or system-ish
   text, the spoken channel must never include it. `toSpeakable` strips code
   fences, which covers fenced tool blocks, but bare JSON should also be
   filtered.

3. **Numbers and data.** "Revenue was $1.2M in Q2" speaks fine. A 10-row
   table does not — the mechanical layer reduces it to comma-separated
   values, which is still bad. Long data → "see chat for the full table."

### What the model controls

The model can influence the spoken channel through its word choice, but it
does not explicitly tag "speak this" / "don't speak this." The channel split
is deterministic and post-hoc. This is deliberate: it keeps the model prompt
simple and the behavior predictable.

If we later want model-directed channel hints (e.g., `[nospeak]` tags), that's
an additive change to `toSpeakable`, not a redesign.

## Emoted: affective state, not content illustration

The face channel is driven by the ASC dials (warmth, playfulness, intensity,
vulnerability) — the agent's *computed affective state*, not a literal
illustration of the words.

This is a principled choice: the face shows how AImy "feels," not what it's
"saying." When Zen shares an exciting idea ("I found a cool project on
GitHub..."), the dials should already reflect elevated warmth/playfulness
from the engagement itself, and the face follows.

### What the face does NOT do

- It does not "act out" content (no sad face because the text says "sorry").
- It does not lip-sync (that's a separate problem — visemes, not FACS).
- It does not change per-sentence based on sentiment analysis of the text.

### When content should influence the face

If the ASC dials don't capture something the face should show, that's a gap
in the ASC engine, not in the channel policy. Fix it there. The channel
policy stays: dials in, expressions out.

## Worked example

Model output:
```
Good morning! I've been thinking about the Desert Bricks project.

Here's what I found on cold-press brick companies:

| Company | Location | Capacity |
|---------|----------|----------|
| EcoBrick Co | Tucson | 10k/day |
| DesertBlock | Phoenix | 25k/day |

The market looks promising — I estimate $2M initial investment for a starter operation.
```

**Presented:** Full text above, rendered with table.

**Spoken:** "Good morning! I've been thinking about the Desert Bricks project. Here's what I found on cold-press brick companies. The market looks promising — I estimate $2M initial investment for a starter operation." (Table dropped; would add "Full details are in chat" if longer.)

**Emoted:** Warm, moderately engaged baseline from dials. No specific "table face."

## Open questions

1. Should long responses trigger a model-generated spoken summary, or a fixed
   "see chat" cutoff? (Cost vs. quality tradeoff.)
2. Should the user be able to set a "voice verbosity" preference (terse vs.
   full)?
3. When the model outputs *only* a code block (no prose), what should the
   voice channel do? (Current: silence. Alternative: "I've put the code in
   chat.")
