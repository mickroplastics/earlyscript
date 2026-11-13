/**
 * The fixed examples the wizard shows on the right of each step: what a choice produces. They
 * come from the run of 11 November 2026 and do not change with the operator's data; the raw
 * label and the excluded trend are illustrative.
 */
export const EXAMPLE_TREND = {
  title: "Herramientas de terceros para Claude Code y Codex reportadas en Hacker News",
  shortTitle: "Herramientas de terceros para Claude Code y Codex",
  rawLabel: "claude code codex plugin tools",
  posts: 10,
  sources: "Hacker News, GitHub",
  /** The topic of the channel it entered by. */
  topic: "AI coding agents",
} as const;

/** A trend the channel's excluded topics leave out (Tu canal). */
export const EXAMPLE_EXCLUDED_TREND = {
  title: "Renuncia del presidente de un banco digital",
  topic: "politics… without a developer angle",
} as const;

/**
 * Trends a nightly review drafts at most: the engine's daily top. The monthly cap counts the
 * drafts, so a night never spends more than this.
 */
export const NIGHTLY_DRAFTS = 40;
