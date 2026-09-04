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

function Child({
  child,
  spin,
  last,
  collapsed,
  width,
}: {
  child: SubagentChild;
  spin: number;
  last: boolean;
  collapsed: boolean;
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

      {!collapsed && child.status === "running"
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
export function Subagent({ item, width = 80 }: { item: SubagentItem; width?: number }): ReactNode {
  const n = item.children.length;
  const roleWord =
    n > 0 && item.children.every((c) => c.role === item.children[0]?.role)
      ? `${item.children[0]?.role}${n === 1 ? "" : "s"}`
      : "agents";
  const running = item.status === "running";
  const header = running ? `${n} ${roleWord} working` : `${n} ${roleWord} finished`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {/* the ◆ marker carries the accent only while the wave is LIVE; a finished tree goes dim. */}
        <Text color={running ? AmbientTheme.cyan : AmbientTheme.dim}>◆ </Text>
        <Text color={running ? AmbientTheme.fg : AmbientTheme.dim}>subagent</Text>
        <Text color={AmbientTheme.dim}>{`   ${header}`}</Text>
      </Box>
      {item.children.map((c, i) => (
        <Child
          key={c.childSessionId}
          child={c}
          spin={item.spin}
          last={i === item.children.length - 1}
          collapsed={item.collapsed}
          width={width}
        />
      ))}
    </Box>
  );
}
