/**
 * Ambient brand tokens for the terminal (see docs/design/AMBIENT-BRAND.md for the full palette).
 * Restrained color: the screen is mostly neutral; CYAN marks only what is live / active / key. Only the
 * tokens the UI actually renders live here — the brand doc is the source of truth for the rest.
 */
export const AmbientTheme = {
  cyan: "#4A93B2", // Ambient Cyan — the accent (~10% of the screen)
  signal: "#1893EB", // Signal Blue — brighter interactive accent (streaming, focus)
  fg: "#FFFFFF", // dominant text
  dim: "gray", // secondary text (overlines, metadata, help)
  add: "green", // diff additions — conventional/semantic, deliberately NOT the cyan accent
  bad: "#C25B5B", // errors + diff deletions
} as const;
