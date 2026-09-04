/**
 * Ambient logomark + wordmark for the terminal.
 *
 * BRAILLE_GLOBE is the REAL Ambient orbital globe (logos/ambient-mark.png) rendered as braille art —
 * braille packs 2x4 dots per cell, so the wireframe sphere reads faithfully in a monospace grid. It is
 * rendered in Ambient Cyan. The wordmark evokes Oswald's heavy condensed caps via a 5-row block alphabet.
 */

/** The real Ambient globe as braille art (20 columns wide). Render in Ambient Cyan. */
export const BRAILLE_GLOBE: readonly string[] = [
  "⠀⠀⠀⠀⠀⠀⢀⣠⣤⣤⣤⣤⣄⡀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⢠⡶⢋⣡⣼⠿⣷⣦⣌⡙⢶⡄⠀⠀⠀⠀",
  "⠀⠀⠀⣰⠏⣰⣯⡵⢾⠛⢻⡉⠉⠹⣟⠻⣆⠀⠀⠀",
  "⠀⠀⠀⣟⣴⡏⠁⠀⢸⡄⢸⡇⠀⠀⢸⣆⣿⠀⠀⠀",
  "⠀⠀⠀⣿⠹⡇⠀⠀⢸⡇⠘⡇⠀⢀⣸⠟⣽⠀⠀⠀",
  "⠀⠀⠀⠹⣦⣽⣆⣀⣈⣧⣤⡷⢞⣻⠏⣰⠏⠀⠀⠀",
  "⠀⠀⠀⠀⠘⠷⣌⡙⠻⢿⣶⡟⢋⣡⠾⠃⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠈⠙⠛⠛⠛⠛⠋⠁⠀⠀⠀⠀⠀⠀",
];
export const GLOBE_WIDTH = 20;

const BLOCK: Record<string, readonly string[]> = {
  A: [" ██ ", "█  █", "████", "█  █", "█  █"],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  B: ["███ ", "█  █", "███ ", "█  █", "███ "],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  E: ["████", "█   ", "███ ", "█   ", "████"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
};

/** Render a word (letters present in BLOCK only) as 5 rows of block type. */
export function blockWordmark(word: string, gap = " "): string[] {
  const glyphs = word
    .toUpperCase()
    .split("")
    .map((ch) => BLOCK[ch])
    .filter((g): g is readonly string[] => Boolean(g));
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    rows.push(glyphs.map((g) => g[r] ?? "").join(gap));
  }
  return rows;
}

/** The full "AMBIENT" block banner (5 rows). */
export const AMBIENT_BANNER = blockWordmark("AMBIENT");

/** A single-line lockup for narrow terminals / status contexts. */
export const LOCKUP_COMPACT = "◉ AMBIENT";

/**
 * The Ambient globe, SPINNING — rendered in the SAME braille medium as the brand globe (BRAILLE_GLOBE), so
 * the live indicator reads as the orbital sphere turning, not a generic moon-phase circle. Each frame rotates
 * the lit arc around the orb; on the activity line it advances on a steady timer, and after a streamed token
 * in the transcript. Freeze to GLOBE_IDLE (the resting logomark) when nothing flows / NO_COLOR.
 */
export const GLOBE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const GLOBE_IDLE = "◉";

/** The globe frame for a given token count (or the idle mark when not streaming). */
export function globeFrame(tokenTicks: number, streaming: boolean): string {
  if (!streaming) return GLOBE_IDLE;
  const f = GLOBE_SPINNER[tokenTicks % GLOBE_SPINNER.length];
  return f ?? GLOBE_IDLE;
}
