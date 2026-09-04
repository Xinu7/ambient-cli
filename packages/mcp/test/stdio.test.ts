import { expect, it } from "vitest";
import { spawnStdioTransport } from "../src/stdio.js";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A wrapper process (`sh`) that launches a long-lived GRANDCHILD (`sleep`) and prints its pid — this mirrors
// how real MCP servers run under `npm exec`/`npx`/`uvx`. close() must kill the whole group, not just `sh`,
// or the grandchild orphans AND keeps our stdout pipe open (the CLI then hangs after [complete]).
it("close() kills the whole process group — no orphaned grandchild, pipes released", async () => {
  const { transport, child } = spawnStdioTransport({
    command: "sh",
    args: ["-c", "sleep 30 & echo $! ; wait"],
  });
  // Read the grandchild pid off stdout (a second listener; the framer also sees it and ignores the non-JSON).
  let out = "";
  child.stdout?.on("data", (d: string) => {
    out += d;
  });
  for (let i = 0; i < 40 && !/\d/.test(out); i++) await settle(25);
  const gcPid = Number.parseInt(out.trim(), 10);
  expect(Number.isInteger(gcPid)).toBe(true);
  expect(alive(gcPid)).toBe(true); // the grandchild sleep is running

  transport.close();
  for (let i = 0; i < 40 && alive(gcPid); i++) await settle(25);
  expect(alive(gcPid)).toBe(false); // …and dies with the group (not orphaned)
});
