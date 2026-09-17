import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AmbientTheme } from "../theme.js";

/** Total terminal rows the banner occupies (1 content + 2 border + 1 margin) — the App subtracts this from
 *  the plan panel's height budget when the banner shows, so the idle stack can never reach the terminal
 *  height and trigger Ink's full-screen repaint (the CSI-3J "strobe" that also erases native scrollback). */
export const PLAN_REVIEW_ROWS = 4;

/**
 * The plan-ready PROMPT — a prominent, signal-coloured bordered banner shown the instant a PLAN-mode run
 * finishes with an actionable plan, so it's obvious the agent is DONE and waiting for you (the old dim
 * one-line notice was easy to miss). One line so it stays height-safe: it spells out the two choices —
 * approve & build, or type to revise — and is non-blocking (the composer below still accepts input). Enter on
 * an empty line approves; typing a message revises the plan (the agent reads your feedback + the pinned plan).
 */
export function PlanReview({ steps, width }: { steps: number; width: number }): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 120));
  return (
    <Box
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={1}
      width={boxW}
      marginTop={1}
    >
      <Text wrap="truncate-end">
        <Text color={AmbientTheme.signal}>◆ Plan ready</Text>
        <Text color={AmbientTheme.dim}>{` (${steps} step${steps === 1 ? "" : "s"}) — `}</Text>
        <Text color={AmbientTheme.fg}>{"↵ approve & build"}</Text>
        <Text color={AmbientTheme.dim}>{"  ·  "}</Text>
        <Text color={AmbientTheme.fg}>type to revise</Text>
        <Text color={AmbientTheme.dim}>{"  ·  tab keeps planning"}</Text>
      </Text>
    </Box>
  );
}
