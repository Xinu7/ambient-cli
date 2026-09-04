import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { THINKING_GLOBE } from "../globe.js";
import type { Activity } from "../state.js";
import { AmbientTheme } from "../theme.js";

/** Format seconds as m:ss (Codex-style elapsed). */
function elapsedLabel(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The one live line, shown ONLY while a run is active: the Ambient globe SPINNING (a real rotating braille
 * orb, INLINE on one row) + what the agent is doing right now (Thinking / Reading / Editing / Running …) +
 * the running elapsed time. `frame` advances on a steady timer so the globe turns even between tokens. The
 * verb + phase clock always stay on-screen; the volatile detail shrinks + truncates in the middle.
 */
export function ActivityLine({
  activity,
  elapsed,
  phaseElapsed,
  frame,
  width = 80,
}: {
  activity?: Activity;
  elapsed: number;
  /** Time in the CURRENT phase (this verb) — shown next to the verb; the run total sits after it. */
  phaseElapsed?: number;
  frame: number;
  width?: number;
}): ReactNode {
  if (!activity) return null;
  const globe =
    THINKING_GLOBE[
      ((frame % THINKING_GLOBE.length) + THINKING_GLOBE.length) % THINKING_GLOBE.length
    ] ??
    THINKING_GLOBE[0] ??
    "";
  const globeW = globe.length + 1; // globe cells + a 1-col gap before the verb
  const phase = phaseElapsed !== undefined ? phaseElapsed : elapsed;
  const rowW = Math.max(0, Math.min(width - 2, 120));
  const textW = Math.max(6, rowW - globeW);
  const showRun = elapsed - phase > 1 && textW >= 40;
  // Bound the verb STRING (when there's no shrinkable detail) to what's left after the clock, so a long verb
  // like "Fixing failed verification" can't clip the priority phase clock on a narrow row.
  const clockW =
    `  ·  ${elapsedLabel(phase)}`.length +
    (showRun ? `  (run ${elapsedLabel(elapsed)})`.length : 0);
  const verbBudget = activity.detail ? undefined : Math.max(3, textW - clockW);
  const verb =
    verbBudget !== undefined && activity.verb.length > verbBudget
      ? `${activity.verb.slice(0, Math.max(1, verbBudget - 1))}…`
      : activity.verb;
  return (
    <Box marginTop={1} width={rowW}>
      {/* The spinning Ambient globe — a real rotating braille orb, inline, brand signal blue. */}
      <Box flexShrink={0}>
        <Text color={AmbientTheme.signal}>{`${globe} `}</Text>
        <Text color={AmbientTheme.fg} bold wrap="truncate">
          {verb}
        </Text>
      </Box>
      {activity.detail ? (
        <Box flexShrink={1} minWidth={0}>
          <Text color={AmbientTheme.dim} wrap="truncate-middle">
            {`  ${activity.detail}`}
          </Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text color={AmbientTheme.dim}>{`  ·  ${elapsedLabel(phase)}`}</Text>
        {showRun ? (
          <Text color={AmbientTheme.dim}>{`  (run ${elapsedLabel(elapsed)})`}</Text>
        ) : null}
      </Box>
    </Box>
  );
}
