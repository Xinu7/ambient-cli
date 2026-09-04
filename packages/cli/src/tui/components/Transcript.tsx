import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { globeFrame } from "../logo.js";
import type { TranscriptItem } from "../state.js";
import { AmbientTheme } from "../theme.js";
import { Subagent } from "./Subagent.js";

/** Flatten newlines + truncate one line to `max` cols so nothing wraps the borderless column (Approval bar). */
function clip(text: string, max: number): string {
  const t = text.replace(/\s*\n\s*/g, " ");
  if (max <= 1) return t.length > 0 ? "…" : "";
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Status glyph for a tool call (geometric marks — never emoji). Settled SUCCESS is GREEN (conventional), not
 *  the cyan accent — a run fills the transcript with ✓ rows, so cyan there would blow the ~10% budget. Only a
 *  LIVE tool carries the signal accent. */
function toolGlyph(status: "running" | "ok" | "fail"): { glyph: string; color: string } {
  if (status === "running") return { glyph: "◐", color: AmbientTheme.signal };
  if (status === "ok") return { glyph: "✓", color: AmbientTheme.add };
  return { glyph: "✗", color: AmbientTheme.bad };
}

/**
 * Render a unified diff with restrained, CONVENTIONAL color: additions green, deletions muted-red,
 * context dim. Diff green/red are semantic (not the Ambient Cyan accent) so a big edit can't blow the
 * ~10% cyan budget. Each line is truncated to the interior so a long/minified edit line can't wrap and
 * shatter the marginLeft gutter.
 */
function Diff({ diff, width }: { diff: string; width: number }): ReactNode {
  const lines = diff.split("\n");
  const shown = lines.slice(0, 40);
  const hidden = lines.length - shown.length;
  const inner = Math.max(1, width - 2); // marginLeft:2
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((l, i) => {
        let color: string = AmbientTheme.dim;
        if (l.startsWith("+") && !l.startsWith("+++")) color = AmbientTheme.add;
        else if (l.startsWith("-") && !l.startsWith("---")) color = AmbientTheme.bad;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff snapshot within one render never reorders
          <Text key={i} color={color} wrap="truncate">
            {clip(l || " ", inner)}
          </Text>
        );
      })}
      {hidden > 0 ? <Text color={AmbientTheme.dim}>{`  … ${hidden} more lines`}</Text> : null}
    </Box>
  );
}

/** A bounded, dimmed preview of a tool's OUTPUT (read contents / grep hits / bash stdout). */
function Output({ text, width }: { text: string; width: number }): ReactNode {
  const lines = text.split("\n");
  const shown = lines.slice(0, 6);
  const hidden = lines.length - shown.length;
  const inner = Math.max(1, width - 2);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a preview snapshot never reorders within a render
        <Text key={i} color={AmbientTheme.dim} wrap="truncate">
          {clip(l || " ", inner)}
        </Text>
      ))}
      {hidden > 0 ? <Text color={AmbientTheme.dim}>{`  … ${hidden} more lines`}</Text> : null}
    </Box>
  );
}

function Item({ item, width }: { item: TranscriptItem; width: number }): ReactNode {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={AmbientTheme.cyan}>{"› "}</Text>
          <Text color={AmbientTheme.fg} wrap="truncate">
            {item.text}
          </Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginTop={1}>
          <Text color={AmbientTheme.fg}>{item.text}</Text>
          {item.streaming ? (
            <Text color={AmbientTheme.cyan}>{` ${globeFrame(item.spin, true)}`}</Text>
          ) : null}
        </Box>
      );

    case "tool": {
      // Skills get a FRIENDLY, prominent treatment (user: "how do I know it used the skill correctly?"):
      // a clear "using skill: X" / "searched skills: X" line with the brand ◆ (the same mark the /skills
      // browser puts on a pinned skill) — no raw JSON dump. This is the visible proof a skill was loaded.
      if (item.name === "skill" || item.name === "search_skills") {
        const isLoad = item.name === "skill";
        const running = item.status === "running";
        const failed = item.status === "fail";
        const mark = running ? "◐" : failed ? "✗" : "◆";
        const markColor = running
          ? AmbientTheme.signal
          : failed
            ? AmbientTheme.bad
            : AmbientTheme.cyan;
        const label = isLoad
          ? running
            ? "loading skill"
            : "using skill"
          : running
            ? "searching skills"
            : "searched skills";
        return (
          <Box marginTop={1}>
            <Text color={markColor}>{`${mark} `}</Text>
            <Text color={AmbientTheme.fg}>{label}</Text>
            {item.preview ? (
              <Text color={AmbientTheme.cyan} bold>
                {`: ${clip(item.preview, Math.max(4, width - label.length - 6))}`}
              </Text>
            ) : null}
            {item.error ? (
              <Text color={AmbientTheme.bad} wrap="truncate">
                {`  ${clip(item.error, Math.max(1, width - label.length - 8))}`}
              </Text>
            ) : null}
          </Box>
        );
      }
      const { glyph, color } = toolGlyph(item.status);
      const timing = item.durationMs != null ? ` ${item.durationMs}ms` : "";
      const exit = item.exitCode != null && item.exitCode !== 0 ? ` exit ${item.exitCode}` : "";
      // Budget the preview so the header (glyph + name + preview + timing + exit) never wraps — exit is a
      // priority suffix (you need to see it), so reserve its width here. When there's no real room left,
      // DROP the preview rather than floor it at 8 (a floor would just overflow the row and split the
      // exit suffix onto a second line on a very narrow terminal); name/timing/exit are the priority.
      const previewBudget = width - item.name.length - timing.length - exit.length - 6;
      const showPreview = Boolean(item.preview) && previewBudget >= 8;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={color}>{`${glyph} `}</Text>
            <Text color={AmbientTheme.fg} wrap="truncate">
              {item.name}
            </Text>
            {showPreview ? (
              <Text color={AmbientTheme.dim}>{`  ${clip(item.preview, previewBudget)}`}</Text>
            ) : null}
            {timing ? <Text color={AmbientTheme.dim}>{timing}</Text> : null}
            {exit ? <Text color={AmbientTheme.bad}>{exit}</Text> : null}
          </Box>
          {item.diff ? <Diff diff={item.diff} width={width} /> : null}
          {item.resultPreview ? <Output text={item.resultPreview} width={width} /> : null}
          {item.error ? (
            <Box marginLeft={2}>
              <Text color={AmbientTheme.bad} wrap="truncate">
                {clip(item.error, Math.max(1, width - 2))}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }

    case "subagent":
      return <Subagent item={item} width={width} />;

    case "handoff":
      // A role handoff (planner→executor→…) — distinct glyph ⇢ from the ↪ substitution receipt below.
      return (
        <Box marginTop={1}>
          <Text color={AmbientTheme.dim} wrap="truncate">
            {clip(`⇢ ${item.from} → ${item.to} (${item.reason ?? item.role})`, width)}
          </Text>
        </Box>
      );

    case "receipt":
      // A calm, honest receipt (warm-model substitution) — never an alarm.
      return (
        <Box marginTop={1}>
          <Text color={AmbientTheme.signal}>↪ </Text>
          <Text color={AmbientTheme.dim} wrap="truncate">
            {clip(item.text, Math.max(1, width - 2))}
          </Text>
        </Box>
      );

    case "notice": {
      const color =
        item.level === "error"
          ? AmbientTheme.bad
          : item.level === "warn"
            ? AmbientTheme.signal
            : AmbientTheme.dim;
      const mark = item.level === "info" ? "·" : "⚠";
      return (
        <Box marginTop={1}>
          <Text color={color} wrap="truncate">
            {clip(`${mark} ${item.text}`, width)}
          </Text>
        </Box>
      );
    }

    default:
      return null;
  }
}

/**
 * The transcript — a calm, borderless column. Ink reflows the whole tree each render; we render the
 * last `window` items so a very long run stays responsive (older lines have scrolled off anyway). `width`
 * is threaded down so every volatile line truncates instead of wrapping (matching the Approval bar).
 */
export function Transcript({
  items,
  window = 200,
  width = 80,
}: { items: TranscriptItem[]; window?: number; width?: number }): ReactNode {
  const shown = items.length > window ? items.slice(items.length - window) : items;
  return (
    <Box flexDirection="column">
      {shown.map((item) => (
        <Item key={item.id} item={item} width={width} />
      ))}
    </Box>
  );
}
