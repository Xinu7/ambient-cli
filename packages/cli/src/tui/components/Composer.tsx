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

export function Composer({
  value,
  running,
  width,
  planReady = false,
  attachments = [],
}: {
  value: string;
  running: boolean;
  width: number;
  /** BUILD mode with a saved plan and idle → Enter on an empty line executes the plan. */
  planReady?: boolean;
  /** Pending image attachments shown as chips above the input (Ctrl+V / drag-drop / /attach). */
  attachments?: { bytes: number }[];
}): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 120));
  const placeholder = running
    ? "Queue a follow-up for the next run…"
    : planReady
      ? "Enter to build the plan · or describe a task · type / for commands"
      : "Describe a coding task · type / for commands";
  const hint = running
    ? "enter queues · esc cancels"
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
        {/* the prompt ▸ is dim chrome; the signal ▋ caret is the one live mark. When empty the caret LEADS the
            placeholder and the START stays (truncate-end); while typing the caret trails your text and the END
            stays visible (truncate-start) — so a long line never hides what you're currently typing. */}
        {value.length === 0 ? (
          <Text wrap="truncate-end">
            <Text color={AmbientTheme.dim}>▸ </Text>
            <Text color={AmbientTheme.signal}>▋</Text>
            <Text color={AmbientTheme.dim}>{placeholder}</Text>
          </Text>
        ) : (
          <Text wrap="truncate-start">
            <Text color={AmbientTheme.dim}>▸ </Text>
            <Text color={AmbientTheme.fg}>{value}</Text>
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
