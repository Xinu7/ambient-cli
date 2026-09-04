import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AMBIENT_BANNER, BRAILLE_GLOBE, LOCKUP_COMPACT } from "../logo.js";
import { AmbientTheme } from "../theme.js";
import { Rule } from "./primitives.js";

/** One canonical tagline (capitalized), used in both the wide + compact lockups. */
const TAGLINE = "A terminal coding agent for the Ambient network.";

/**
 * A calm, DIM brand watermark for the empty upper region of a sparse running screen — the orbital globe +
 * wordmark, centered, so a fresh/near-empty session reads as a deliberate home screen instead of a blank
 * void. Dim (never the cyan accent) so it recedes behind the conversation as it grows.
 */
export function Watermark(): ReactNode {
  return (
    <Box flexDirection="column" alignItems="center">
      {BRAILLE_GLOBE.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed glyph rows never reorder
        <Text key={i} color={AmbientTheme.dim}>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={AmbientTheme.dim}>{LOCKUP_COMPACT}</Text>
      </Box>
    </Box>
  );
}
/** The wide lockup's true width: globe + a 3-col gap + the block wordmark. Drives the responsive breakpoint
 *  (measured, not a magic number) so the wordmark can never be forced to wrap on the very first screen. */
const LOCKUP_W = (BRAILLE_GLOBE[0]?.length ?? 20) + 3 + (AMBIENT_BANNER[0]?.length ?? 30);

/** The count of models ready to serve right now — the number is the point; the total is noise. */
function readyLine(fleet?: { ready: number }): { count: string; rest: string } {
  if (!fleet) return { count: "", rest: "connecting…" };
  if (fleet.ready === 0) return { count: "", rest: "no models ready" };
  return { count: String(fleet.ready), rest: ` model${fleet.ready === 1 ? "" : "s"} ready` };
}

/**
 * The splash lockup — the one place we spend the brand's "10% cyan" boldly. The real Ambient globe
 * (braille art) + the block "AMBIENT" wordmark (Oswald-condensed spirit) + a terse, anti-hype tagline.
 * Degrades to a compact single-line lockup on narrow terminals (the responsive rule).
 */
export function Banner({ width, fleet }: { width: number; fleet?: { ready: number } }): ReactNode {
  const compact = width - 2 < LOCKUP_W; // account for the App's paddingX:1 (≈ width < 63)
  const { count, rest } = readyLine(fleet);

  if (compact) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={AmbientTheme.cyan} bold>
          {LOCKUP_COMPACT}
        </Text>
        <Text color={AmbientTheme.dim} wrap="truncate">
          {TAGLINE}
        </Text>
        <Text>
          {count ? <Text color={AmbientTheme.cyan}>{count}</Text> : null}
          <Text color={AmbientTheme.dim}>{rest}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box alignItems="center">
        <Box flexDirection="column" marginRight={3}>
          {BRAILLE_GLOBE.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed glyph rows never reorder
            <Text key={i} color={AmbientTheme.cyan}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          {AMBIENT_BANNER.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed glyph rows never reorder
            <Text key={i} color={AmbientTheme.cyan} bold>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={AmbientTheme.fg}>{TAGLINE}</Text>
        <Box marginTop={1}>
          {count ? (
            <Text color={AmbientTheme.cyan} bold>
              {count}
            </Text>
          ) : null}
          <Text color={AmbientTheme.dim}>{rest}</Text>
        </Box>
        <Box marginTop={1}>
          {/* dim rule — thin-line depth without spending more cyan; the wordmark keeps the accent concentrated */}
          <Rule width={Math.min(width - 2, 60)} />
        </Box>
      </Box>
    </Box>
  );
}
