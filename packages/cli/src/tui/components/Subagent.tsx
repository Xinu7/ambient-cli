import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { globeFrame } from "../logo.js";
import type { SubagentChild, TranscriptItem } from "../state.js";
import { AmbientTheme } from "../theme.js";

type SubagentItem = Extract<TranscriptItem, { kind: "subagent" }>;

// Settled SUCCESS is green (conventional), LIVE is the signal accent — never spend cyan on a finished row.
function toolMark(status: "running" | "ok" | "fail"): { glyph: string; color: string } {
  if (status === "running") return { glyph: "◐", color: AmbientTheme.signal };
  if (status === "ok") return { glyph: "✓", color: AmbientTheme.add };
  return { glyph: "✗", color: AmbientTheme.bad };
}

function childGlyph(
  status: "running" | "ok" | "fail",
  spin: number,
): { glyph: string; color: string } {
  if (status === "running") return { glyph: globeFrame(spin, true), color: AmbientTheme.signal };
  if (status === "ok") return { glyph: "✓", color: AmbientTheme.add };
  return { glyph: "✗", color: AmbientTheme.bad };
}

function fmtDuration(ms?: number): string {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function oneLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Approximate rendered height of one child block, so the wave can be windowed to a rows budget. */
function childRows(child: SubagentChild, expanded: boolean): number {
  let h = 1; // the child's own row
  if (expanded && child.status === "running") h += child.tools.length; // its live tool rows
  if (child.status !== "running" && child.summary) h += 1; // the ↳ summary line
  return h;
}

function Child({
  child,
  spin,
  last,
  expanded,
  width,
}: {
  child: SubagentChild;
  spin: number;
  last: boolean;
  /** Show this child's live tool rows (only when the wave is expanded — collapsed shows just the summary). */
  expanded: boolean;
  width: number;
}): ReactNode {
  const { glyph, color } = childGlyph(child.status, spin);
  const branch = last ? "└─" : "├─";
  const rail = last ? "     " : "│    "; // continuation indent under this child
  const activity = child.activity
    ? `${child.activity.verb}${child.activity.detail ? ` ${child.activity.detail}` : ""}`
    : "";
  const meta =
    child.status === "running"
      ? activity
      : `${child.turns ?? 0} turn(s)${child.durationMs != null ? ` · ${fmtDuration(child.durationMs)}` : ""}`;

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexShrink={0}>
          <Text color={AmbientTheme.dim}>{`  ${branch} `}</Text>
          <Text color={color}>{`${glyph} `}</Text>
          {/* role is dim metadata (only the live globe carries the accent); fixed columns so model + meta align */}
          <Text color={AmbientTheme.dim}>{`${child.role.toUpperCase().padEnd(7)} `}</Text>
          <Text color={AmbientTheme.fg}>{`${oneLine(child.label, 18).padEnd(18)}  `}</Text>
        </Box>
        {/* the volatile model + meta shrinks + truncates so a long activity/detail never wraps the tree */}
        <Box flexShrink={1} minWidth={0}>
          <Text color={AmbientTheme.dim} wrap="truncate">
            {`${child.model}  ${meta}`}
          </Text>
        </Box>
      </Box>

      {expanded && child.status === "running"
        ? child.tools.map((t) => (
            <Box key={t.id}>
              <Box flexShrink={0}>
                <Text color={AmbientTheme.dim}>{`  ${rail}`}</Text>
                <Text color={toolMark(t.status).color}>{`${toolMark(t.status).glyph} `}</Text>
              </Box>
              <Box flexShrink={1} minWidth={0}>
                <Text color={AmbientTheme.dim} wrap="truncate">
                  {`${t.name}${t.preview ? `  ${t.preview}` : ""}`}
                </Text>
              </Box>
            </Box>
          ))
        : null}

      {child.status !== "running" && child.summary ? (
        <Box>
          <Box flexShrink={0}>
            <Text color={AmbientTheme.dim}>{`  ${rail}↳ `}</Text>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text color={AmbientTheme.dim} wrap="truncate">
              {oneLine(child.summary, Math.max(8, width - rail.length - 4))}
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * The nested-subagent view — the user's "I want to SEE the subagent working". A calm tree under a `◆`
 * header: each child shows a spinning globe while it works + its current tool, and collapses to a one-line
 * `↳` summary (with the explore→summary compression) when done. Brand grammar only — no emoji; structure
 * (├─ / globe / ✓ / ↳) carries meaning even under NO_COLOR.
 */
export function Subagent({
  item,
  width = 80,
  expanded = false,
  maxRows = Number.POSITIVE_INFINITY,
}: {
  item: SubagentItem;
  width?: number;
  /** When the wave is LIVE, whether it's expanded to show each child's tool rows + streamed prose (↓ / Ctrl+O
   *  toggles it). Collapsed by default so a big wave can't fill the screen; a finished wave ignores this. */
  expanded?: boolean;
  /** Rows budget for the whole tree — a big wave is windowed to the first children that fit, plus a
   *  "… +K more" line, so the live frame never grows tall (which would make the layout jump). */
  maxRows?: number;
}): ReactNode {
  const n = item.children.length;
  const roleWord =
    n > 0 && item.children.every((c) => c.role === item.children[0]?.role)
      ? `${item.children[0]?.role}${n === 1 ? "" : "s"}`
      : "agents";
  const running = item.status === "running";
  const doneCount = item.children.filter((c) => c.status !== "running").length;
  // A live wave shows a running count + how to expand; a finished wave just says finished.
  const header = running
    ? `${n - doneCount}/${n} ${roleWord} running${expanded ? " · ↑ collapse" : " · ↓ / ctrl+o to expand"}`
    : `${n} ${roleWord} finished`;

  // Window the tree to the rows budget: header (1) + a live-tail line (if any) + as many child blocks as fit,
  // reserving one row for the "… +K more" marker when we truncate. Keeps a big wave from becoming a tall frame.
  const tailRows = running && expanded && item.liveText ? 1 : 0;
  const childBudget = Math.max(1, Math.floor(maxRows) - 1 - tailRows);
  let shownCount = item.children.length;
  let used = 0;
  for (let i = 0; i < item.children.length; i++) {
    const more = i < item.children.length - 1; // a truncation here needs a marker row
    if (
      used + childRows(item.children[i] as SubagentChild, expanded) >
      childBudget - (more ? 1 : 0)
    ) {
      shownCount = i;
      break;
    }
    used += childRows(item.children[i] as SubagentChild, expanded);
  }
  const shown = item.children.slice(0, shownCount);
  const hidden = item.children.length - shownCount;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {/* the ◆ marker carries the accent only while the wave is LIVE; a finished tree goes dim. */}
        <Text color={running ? AmbientTheme.cyan : AmbientTheme.dim}>◆ </Text>
        <Text color={running ? AmbientTheme.fg : AmbientTheme.dim}>subagent</Text>
        <Text color={AmbientTheme.dim}>{`   ${header}`}</Text>
      </Box>
      {shown.map((c, i) => (
        <Child
          key={c.childSessionId}
          child={c}
          spin={item.spin}
          last={hidden === 0 && i === shown.length - 1}
          expanded={expanded}
          width={width}
        />
      ))}
      {hidden > 0 ? (
        <Text
          color={AmbientTheme.dim}
        >{`  └─ … +${hidden} more ${hidden === 1 ? "agent" : "agents"}`}</Text>
      ) : null}
      {/* A dim live tail of the children's streamed prose (only when expanded) — so you SEE what they're
          thinking, not just which tool ran (the user: "I can't tell what those subagents are even doing"). */}
      {running && expanded && item.liveText ? (
        <Box>
          <Text color={AmbientTheme.dim}>{"  · "}</Text>
          <Box flexShrink={1} minWidth={0}>
            <Text color={AmbientTheme.dim} wrap="truncate">
              {oneLine(item.liveText, Math.max(8, width - 6))}
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
