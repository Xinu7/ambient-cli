import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AmbientTheme } from "../theme.js";

/**
 * The input box — ALWAYS visible (idle and in-flight), so there's never any doubt where you type.
 * A clean rounded frame (like Claude Code / Codex) that grows as the text wraps. While a run is active,
 * typing queues a follow-up for the next run; the placeholder + hint say so. App owns the keystrokes.
 */
/** Human-readable byte size for an attachment chip. */
function kb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The FLOOR for the composer's height (rows). The App passes a larger `maxRows` when there's free vertical
 *  space (a fresh screen), so a big paste can expand into it; it stays here while a run is active or on a
 *  short terminal, so the live region never reaches the terminal height (the CSI-3J strobe + scrollback erase). */
const MIN_INPUT_ROWS = 6;

/**
 * Bound a long single-line value to at most `maxRows` wrapped rows by showing its TAIL (where the caret is —
 * what you're currently typing) prefixed with "…". A normal message fits whole; only a pathological one-liner
 * (a long pasted URL/JSON with no newlines) collapses — which keeps the composer legible AND bounded.
 */
function boundInput(value: string, boxW: number, maxRows: number): string {
  const usable = Math.max(8, boxW - 4); // "▸ " + caret + interior padding
  const maxChars = maxRows * usable;
  return value.length > maxChars ? `…${value.slice(-(maxChars - 1))}` : value;
}

function Line({
  text,
  first,
  caret,
}: { text: string; first?: boolean; caret?: boolean }): ReactNode {
  return (
    <Text wrap="truncate-end">
      <Text color={AmbientTheme.dim}>{first ? "▸ " : "  "}</Text>
      <Text color={AmbientTheme.fg}>{text}</Text>
      {caret ? <Text color={AmbientTheme.signal}>▋</Text> : null}
    </Text>
  );
}

/**
 * Render a MULTI-LINE buffer (a paste, or text with newlines). It EXPANDS to use the height it's given:
 * - fits within `maxRows` → show the whole buffer (the box grows into the free space, like a normal input);
 * - taller but there's ROOM (maxRows grew past the floor) → show the HEAD of the paste + a "[pasted N lines]"
 *   count + the last line (where the caret is), filling the budget so you can actually SEE what you pasted;
 * - taller and space is TIGHT (a run is active / a short terminal) → a single clean "[pasted N lines]" chip
 *   plus a short trailing line, so it can never overflow. The full buffer is always what gets sent.
 */
function MultilineValue({
  value,
  boxW,
  maxRows,
}: {
  value: string;
  boxW: number;
  maxRows: number;
}): ReactNode {
  const lines = value.replace(/\n+$/, "").split("\n"); // ignore trailing blank lines in the count/preview
  if (lines.length <= maxRows) {
    return (
      <Box flexDirection="column">
        {lines.map((ln, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line list within one render never reorders
          <Line key={i} text={ln} first={i === 0} caret={i === lines.length - 1} />
        ))}
      </Box>
    );
  }
  const tail = lines[lines.length - 1] ?? "";
  // ROOM to expand → show the head of the paste + a count + the caret line (fills the free space).
  if (maxRows > MIN_INPUT_ROWS) {
    const headCount = Math.max(1, maxRows - 2);
    return (
      <Box flexDirection="column">
        {lines.slice(0, headCount).map((ln, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line list within one render never reorders
          <Line key={i} text={ln} first={i === 0} />
        ))}
        <Text wrap="truncate-end" color={AmbientTheme.cyan}>
          {`  … [pasted ${lines.length} lines — showing first ${headCount}]`}
        </Text>
        <Line text={tail} caret />
      </Box>
    );
  }
  // TIGHT → a single clean chip; a SHORT trailing line (typed prose) still shows so it can never overflow.
  const shortTail = tail.trim();
  const showTail = shortTail.length > 0 && shortTail.length <= Math.max(8, boxW - 6);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={AmbientTheme.dim}>▸ </Text>
        <Text color={AmbientTheme.cyan}>{`[pasted ${lines.length} lines]`}</Text>
        {showTail ? null : <Text color={AmbientTheme.signal}>{" ▋"}</Text>}
      </Text>
      {showTail ? <Line text={shortTail} caret /> : null}
    </Box>
  );
}

export function Composer({
  value,
  running,
  width,
  maxRows = MIN_INPUT_ROWS,
  planReady = false,
  planReview = false,
  attachments = [],
}: {
  value: string;
  running: boolean;
  width: number;
  /** How many rows of content the composer may show — the App raises this when there's free vertical space
   *  (a fresh screen) so a big paste expands; it stays at the floor while running / on a short terminal. */
  maxRows?: number;
  /** BUILD mode with a saved plan and idle → Enter on an empty line executes the plan. */
  planReady?: boolean;
  /** PLAN mode just produced a plan and is waiting for the user → Enter approves & builds; typing revises. */
  planReview?: boolean;
  /** Pending image attachments shown as chips above the input (Ctrl+V / drag-drop / /attach). */
  attachments?: { bytes: number }[];
}): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 120));
  const rows = Math.max(MIN_INPUT_ROWS, maxRows);
  const placeholder = running
    ? "Steer the agent — type to redirect it, it picks it up next turn…"
    : planReview
      ? "↵ approve the plan · or describe what to change to revise it…"
      : planReady
        ? "Enter to build the plan · or describe a task · type / for commands"
        : "Describe a coding task · type / for commands";
  const hint = running
    ? "enter steers the agent · esc cancels"
    : "tab plan/build · shift+tab permission · enter runs · ctrl+c quits";

  return (
    <Box flexDirection="column">
      {attachments.length > 0 ? (
        // ◫ = an attached image (geometric mark, no emoji); cyan is the one live accent. Backspace on an empty
        // line removes the most recent.
        <Box paddingX={1}>
          <Text color={AmbientTheme.cyan}>◫ </Text>
          <Text color={AmbientTheme.dim} wrap="truncate-end">
            {attachments.length === 1
              ? `image attached · ${kb(attachments[0]?.bytes ?? 0)} · ⌫ removes`
              : `${attachments.length} images attached · ⌫ removes the last`}
          </Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={AmbientTheme.dim} paddingX={1} width={boxW}>
        {/* the prompt ▸ is dim chrome; the signal ▋ caret is the one live mark. When empty the caret leads the
            placeholder; while typing the input WRAPS (grows down, up to `rows`) so you can READ the whole
            message you're sending — never truncated off the right edge ("I can't read what I am sending"). */}
        {value.length === 0 ? (
          <Text wrap="truncate-end">
            <Text color={AmbientTheme.dim}>▸ </Text>
            <Text color={AmbientTheme.signal}>▋</Text>
            <Text color={AmbientTheme.dim}>{placeholder}</Text>
          </Text>
        ) : value.includes("\n") ? (
          // A paste / multi-line buffer — show it so it's never "lost off the right edge".
          <MultilineValue value={value} boxW={boxW} maxRows={rows} />
        ) : (
          <Text wrap="wrap">
            <Text color={AmbientTheme.dim}>▸ </Text>
            <Text color={AmbientTheme.fg}>{boundInput(value, boxW, rows)}</Text>
            <Text color={AmbientTheme.signal}>▋</Text>
          </Text>
        )}
      </Box>
      <Box paddingX={1}>
        <Text color={AmbientTheme.dim} wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
