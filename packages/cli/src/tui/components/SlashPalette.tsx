import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AmbientTheme } from "../theme.js";

export interface SlashCommand {
  name: string;
  args?: string;
  desc: string;
}

/** The command palette shown when the composer text starts with `/`. Kept small + memorable. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", desc: "Show what ambient can do" },
  { name: "/model", desc: "Pick a live model (opens a picker)" },
  {
    name: "/effort",
    args: "[auto|off|low|medium|high]",
    desc: "Reasoning effort (opens a picker)",
  },
  { name: "/plan", desc: "Plan mode — explore + build a task list, no changes" },
  { name: "/build", desc: "Build mode — execute the work" },
  { name: "/ask", desc: "Permission: approve each edit + command (default)" },
  { name: "/accept", desc: "Permission: auto-approve edits, still confirm shell" },
  { name: "/bypass", desc: "Permission: full autonomy — no prompts" },
  { name: "/thinking", desc: "Toggle the live model-reasoning view (also Ctrl+T)" },
  {
    name: "/goal",
    args: "<objective> | show | clear",
    desc: "Set a north-star the agent keeps in view every turn",
  },
  { name: "/attach", args: "<path>", desc: "Attach an image (or press Ctrl+V to paste one)" },
  { name: "/skills", desc: "Show your skills + how the agent uses them" },
  { name: "/clear", desc: "Clear the screen" },
  { name: "/quit", desc: "Exit ambient" },
];

/** The commands matching the current `/…` prefix — builtins PLUS any discovered (Claude/Codex) commands.
 *  An EXACT name match is surfaced FIRST (so pressing Enter on `/deploy` never runs `/deployment`), and a
 *  name is de-duplicated (a discovered command can't produce two identical rows / shadow a builtin twice). */
export function matchSlash(input: string, extra: SlashCommand[] = []): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const token = (input.slice(1).split(/\s/, 1)[0] ?? "").toLowerCase();
  const seen = new Set<string>();
  const matched: SlashCommand[] = [];
  for (const c of [...SLASH_COMMANDS, ...extra]) {
    const name = c.name.slice(1).toLowerCase();
    if (seen.has(name) || !name.startsWith(token)) continue; // first (builtins win) + prefix filter
    seen.add(name);
    matched.push(c);
  }
  // Exact match first, then the rest in their original (builtins-then-discovered) order.
  return matched.sort((a, b) => {
    const ae = a.name.slice(1).toLowerCase() === token ? 0 : 1;
    const be = b.name.slice(1).toLowerCase() === token ? 0 : 1;
    return ae - be;
  });
}

/**
 * The floating command list above the composer. `selected` is highlighted; ↑/↓ move it, Enter/Tab runs it.
 * Rendered only when there are matches (App decides).
 */
export function SlashPalette({
  commands,
  selected,
  width,
}: {
  commands: SlashCommand[];
  selected: number;
  width: number;
}): ReactNode {
  if (commands.length === 0) return null;
  const boxW = Math.max(0, Math.min(width - 2, 120));
  // Window to at most 8 rows around the selection so a bare `/` (all commands) can't get tall.
  const max = 8;
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(max / 2), Math.max(0, commands.length - max)),
  );
  const shown = commands.slice(start, start + max);
  const above = start;
  const below = commands.length - (start + shown.length);
  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={2}
    >
      <Text color={AmbientTheme.dim} wrap="truncate">
        Commands · ↑/↓ then enter · esc to cancel
      </Text>
      {above > 0 ? <Text color={AmbientTheme.dim}>{`  … ${above} above`}</Text> : null}
      {shown.map((c, k) => {
        const active = start + k === selected;
        const name = c.args ? `${c.name} ${c.args}` : c.name;
        return (
          // fixed cursor + name columns (matching Approval + the other pickers) → a straight desc edge; the
          // ▸ glyph carries selection so it survives NO_COLOR.
          <Box key={c.name}>
            <Box width={2} flexShrink={0}>
              <Text color={AmbientTheme.cyan}>{active ? "▸ " : "  "}</Text>
            </Box>
            <Box width={22} flexShrink={0}>
              <Text
                color={active ? AmbientTheme.cyan : AmbientTheme.dim}
                bold={active}
                wrap="truncate"
              >
                {name}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={AmbientTheme.dim} wrap="truncate">
                {c.desc}
              </Text>
            </Box>
          </Box>
        );
      })}
      {below > 0 ? <Text color={AmbientTheme.dim}>{`  … ${below} below`}</Text> : null}
    </Box>
  );
}
