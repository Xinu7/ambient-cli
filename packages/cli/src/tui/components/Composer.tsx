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

/** How many lines of a multi-line buffer are shown before it collapses to a "[pasted N lines]" chip. */
const MAX_VISIBLE_LINES = 8;
/** Cap the composer's own height (rows) — a long wrapped single line must never grow the box past the
 *  terminal (which reintroduces the CSI-3J strobe + scrollback erase). */
const MAX_INPUT_ROWS = 6;

/**
 * Bound a long single-line value to at most MAX_INPUT_ROWS wrapped rows by showing its TAIL (where the caret
 * is — what you're currently typing) prefixed with "…". A normal message fits whole (fully readable); only a
 * pathological one-liner (a long pasted URL/JSON) collapses — which keeps the composer legible AND bounded.
 */
function boundInput(value: string, boxW: number): string {
  const usable = Math.max(8, boxW - 4); // "▸ " + caret + interior padding
  const maxChars = MAX_INPUT_ROWS * usable;
  return value.length > maxChars ? `…${value.slice(-(maxChars - 1))}` : value;
}

/**
 * Render a MULTI-LINE buffer (a paste, or text with newlines). Up to MAX_VISIBLE_LINES render as a growing
 * block so a small paste is fully readable; a LARGE paste collapses to a single clean "[pasted N lines]" chip
 * — never a wall of truncated content, which looked broken. If the buffer's last line is SHORT (a message the
 * user typed alongside the paste), it's shown cleanly below the chip so they can still read what they're
 * adding; a long trailing line (more pasted code) is left to the chip. The full buffer is always what's sent.
 */
function MultilineValue({ value, boxW }: { value: string; boxW: number }): ReactNode {
  const lines = value.replace(/\n+$/, "").split("\n"); // ignore trailing blank lines in the count/preview
  if (lines.length <= MAX_VISIBLE_LINES) {
    return (
      <Box flexDirection="column">
        {lines.map((ln, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line list within one render never reorders
          <Text key={i} wrap="truncate-end">
            <Text color={AmbientTheme.dim}>{i === 0 ? "▸ " : "  "}</Text>
            <Text color={AmbientTheme.fg}>{ln}</Text>
            {i === lines.length - 1 ? <Text color={AmbientTheme.signal}>▋</Text> : null}
          </Text>
        ))}
      </Box>
    );
  }
  // Only surface a trailing line when it's short enough to fit ON ONE ROW (i.e. typed prose, not more code) —
  // so the composer can never render a truncated/overflowing content line for a big paste.
  const tail = (lines[lines.length - 1] ?? "").trim();
  const showTail = tail.length > 0 && tail.length <= Math.max(8, boxW - 6);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={AmbientTheme.dim}>▸ </Text>
        <Text color={AmbientTheme.cyan}>{`[pasted ${lines.length} lines]`}</Text>
        {showTail ? null : <Text color={AmbientTheme.signal}>{" ▋"}</Text>}
      </Text>
      {showTail ? (
        <Text wrap="truncate-end">
          <Text color={AmbientTheme.dim}>{"  "}</Text>
          <Text color={AmbientTheme.fg}>{tail}</Text>
          <Text color={AmbientTheme.signal}>{" ▋"}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

export function Composer({
  value,
  running,
  width,
  planReady = false,
  planReview = false,
  attachments = [],
}: {
  value: string;
  running: boolean;
  width: number;
  /** BUILD mode with a saved plan and idle → Enter on an empty line executes the plan. */
  planReady?: boolean;
  /** PLAN mode just produced a plan and is waiting for the user → Enter approves & builds; typing revises. */
  planReview?: boolean;
  /** Pending image attachments shown as chips above the input (Ctrl+V / drag-drop / /attach). */
  attachments?: { bytes: number }[];
}): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 120));
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
            placeholder; while typing the input WRAPS (grows down) so you can READ the whole message you're
            sending — never truncated off the right edge (the user: "I can't read what I am sending"). */}
        {value.length === 0 ? (
          <Text wrap="truncate-end">
            <Text color={AmbientTheme.dim}>▸ </Text>
            <Text color={AmbientTheme.signal}>▋</Text>
            <Text color={AmbientTheme.dim}>{placeholder}</Text>
          </Text>
        ) : value.includes("\n") ? (
          // A paste / multi-line buffer — show it so it's never "lost off the right edge".
          <MultilineValue value={value} boxW={boxW} />
        ) : (
          <Text wrap="wrap">
            <Text color={AmbientTheme.dim}>▸ </Text>
            <Text color={AmbientTheme.fg}>{boundInput(value, boxW)}</Text>
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
