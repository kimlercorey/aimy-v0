/**
 * asc-channels/speakable.ts — markdown-ish assistant text → speakable prose.
 * Pure.
 *
 * The chat channel shows the full text; the voice channel speaks a version
 * a human can listen to. Code blocks, tables, URLs, and formatting markers
 * don't survive speech — they're dropped or reduced to their words.
 * Deterministic; no model call, no latency.
 */
export const toSpeakable = (text: string): string => {
  let s = text

  // Fenced code blocks → dropped (speech can't render code).
  s = s.replace(/```[\s\S]*?```/g, " ")
  // Inline code → keep the words.
  s = s.replace(/`([^`]*)`/g, "$1")
  // Images → alt text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  // Links → link text.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  // Headings → plain text.
  s = s.replace(/^#{1,6}\s+/gm, "")
  // Bold/italic markers.
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2")
  s = s.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2")
  s = s.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1$2")
  // Blockquotes → plain text.
  s = s.replace(/^>\s?/gm, "")
  // Table separator rows → dropped; cell pipes → commas.
  s = s.replace(/^\|?[\s:|-]+\|?$/gm, "")
  s = s.replace(/\|/g, ", ")
  // List markers → sentence flow.
  s = s.replace(/^\s*[-*+]\s+/gm, "")
  s = s.replace(/^\s*\d+[.)]\s+/gm, "")
  // Horizontal rules → dropped.
  s = s.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "")
  // HTML tags → dropped.
  s = s.replace(/<[^>]+>/g, " ")
  // Bare URLs → dropped.
  s = s.replace(/https?:\/\/\S+/g, " ")

  // Reflow: single newlines within a paragraph become spaces; blank lines
  // stay as paragraph breaks (natural speech pauses).
  const paragraphs = s.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim())
  return paragraphs.filter((p) => p !== "").join("\n\n")
}
