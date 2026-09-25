import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Zero-maintenance guard: model knowledge must come from the live catalog, never from source code. This scans
 * every package's source (comments stripped) and fails if code names a model or bakes in a context-window
 * size. The only place policy numbers may live is the ModelProfile module.
 */
const ROOT = join(__dirname, "..", "..");
const ALLOWED_NUMBERS_FILE = join("reliability", "src", "profile.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const files = readdirSync(ROOT)
  .map((pkg) => join(ROOT, pkg, "src"))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(sourceFiles);

// Vendor/model ids and family names that would mean code knows about a specific model.
const MODEL_NAME =
  /["'`][^"'`\n]*\b(glm-?\d|qwen\d?|deepseek|kimi|gemma|llama-?\d|mistral|gpt-(?:oss|4|5)|claude-(?:opus|sonnet|haiku|\d)|z-ai\/|moonshotai\/|ambient\/(?:large|small))[^"'`\n]*["'`]/i;
// Context/output sizes that are really facts about particular models.
const WINDOW_SIZE =
  /\b(32_?768|65_?536|131_?072|202_?752|262_?144|524_?288|1_?048_?576|128_?000|200_?000)\b/;

describe("no hardwired model knowledge in source", () => {
  it("scans a real source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no source file names a specific model", () => {
    const hits = files.flatMap((f) => {
      const code = stripComments(readFileSync(f, "utf8"));
      return code
        .split("\n")
        .filter((line) => MODEL_NAME.test(line))
        .map((line) => `${relative(ROOT, f)}: ${line.trim()}`);
    });
    expect(hits).toEqual([]);
  });

  it("context/output window sizes live only in the profile module", () => {
    const hits = files
      .filter((f) => !f.endsWith(ALLOWED_NUMBERS_FILE))
      .flatMap((f) => {
        const code = stripComments(readFileSync(f, "utf8"));
        return (
          code
            .split("\n")
            // Byte/char caps (MAX_*_BYTES / *_CHARS) are I/O limits, not model context windows.
            .filter((line) => WINDOW_SIZE.test(line) && !/_(BYTES|CHARS)\b/.test(line))
            .map((line) => `${relative(ROOT, f)}: ${line.trim()}`)
        );
      });
    expect(hits).toEqual([]);
  });
});
