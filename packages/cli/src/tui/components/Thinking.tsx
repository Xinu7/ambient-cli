import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AmbientTheme } from "../theme.js";

/**
 * The live model-reasoning view — a dim, bounded tail of the model's thinking for the CURRENT step, shown
 * only while `show` is on and there is reasoning to display. Transient: the reducer clears it the moment the
 * model starts acting (a tool call) or answering, so it never lingers or clutters. Toggle: /thinking or Ctrl+T.
 */
export function Thinking({
  text,
  show,
  width,
}: {
  text: string;
  show: boolean;
  width: number;
}): ReactNode {
  if (!show || text.trim().length === 0) return null;
  const boxW = Math.max(0, Math.min(width - 2, 120));
  const inner = Math.max(1, boxW - 2);
  // The last few lines of the rolling reasoning tail — enough to see the current thought, not a wall of text.
  const lines = text.replace(/\s+$/, "").split("\n").slice(-6);
  return (
    // Same furniture as the Approval preview (header · ┄ rule · │-gutter) so "the model's own text" reads as
    // one bounded object across both surfaces. Casing matches the ActivityLine verb ("Thinking").
    <Box flexDirection="column" width={boxW} marginTop={1}>
      <Text color={AmbientTheme.dim}>Thinking</Text>
      <Text color={AmbientTheme.dim}>{"┄".repeat(inner)}</Text>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a transient rolling tail; index is stable per render
        <Box key={i}>
          <Text color={AmbientTheme.dim}>│ </Text>
          <Text color={AmbientTheme.dim} wrap="truncate-end">
            {l.trim()}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
