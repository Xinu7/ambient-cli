import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Zero-maintenance guard: model knowledge must come from the live catalog, never from source code. This scans
 * every package's source and the build scripts (comments stripped) and fails if code names a model or bakes
 * in a context-window size. The only place policy numbers may live is the ModelProfile module.
 */
const ROOT = join(__dirname, "..", "..");
const REPO = join(ROOT, "..");
const ALLOWED_NUMBERS_FILE = join("reliability", "src", "profile.ts");

function sourceFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/** Remove // and /* comments without touching string contents (a glob like "src/**\/*.ts" is not a comment). */
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < code.length) {
    const c = code[i] as string;
    const next = code[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const body = code.slice(i, end < 0 ? code.length : end + 2);
      out += body.replace(/[^\n]/g, ""); // keep line numbers
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const dirs = readdirSync(ROOT)
  .map((pkg) => join(ROOT, pkg, "src"))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
const files = [
  ...dirs.flatMap((d) => sourceFiles(d, /\.(ts|tsx|mts|js|mjs)$/)),
  ...sourceFiles(join(REPO, "scripts"), /\.(mjs|js|ts|sh)$/),
];

// Vendor/model ids and family names — anywhere in code (strings, regex literals, identifiers), since a regex
// like /qwen/i or a concatenation "gl" + "m-5" means code knows about a specific model.
const MODEL_NAME =
  /\b(glm|qwen|deepseek|kimi|gemma|gemini|grok|minimax|mistral|mixtral|nemotron|llama-?\d|gpt-?(?:oss|3|4|5)|claude-(?:opus|sonnet|haiku|\d)|z-ai|x-ai|moonshotai|ambient\/(?:large|small))/i;
// Context/output sizes that are really facts about particular models, however they're spelled.
const WINDOW_NUMBER =
  /\b(16384|32768|65536|128000|131072|200000|202752|256000|262144|524288|1000000|1048576|2000000|2097152)\b/;
const WINDOW_EXPR =
  /\b(?:16|32|64|128|256|512|2048)\s*\*\s*1024\b|\b0x(?:4000|8000|10000|20000|40000|80000|100000)\b/i;
/** A named byte/char limit (`const MAX_FILE_BYTES = …`) is an I/O limit, not a model window. */
const IO_LIMIT_DECL = /\b(?:const|let)\s+[A-Z0-9_]*_(?:BYTES|CHARS)\s*=/;

function hits(pred: (line: string) => boolean, exclude?: string): string[] {
  return files
    .filter((f) => !exclude || !f.endsWith(exclude))
    .flatMap((f) =>
      stripComments(readFileSync(f, "utf8"))
        .split("\n")
        .filter(pred)
        .map((line) => `${relative(REPO, f)}: ${line.trim()}`),
    );
}

describe("no hardwired model knowledge in source", () => {
  it("scans a real source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no source file names a specific model", () => {
    expect(hits((line) => MODEL_NAME.test(line))).toEqual([]);
  });

  it("context/output window sizes live only in the profile module", () => {
    expect(
      hits((line) => {
        // Named byte/char limits and number formatting for display ("1.2M") aren't model windows.
        if (IO_LIMIT_DECL.test(line) || line.includes("toFixed(")) return false;
        const plain = line.replace(/(\d)_(?=\d)/g, "$1");
        return WINDOW_NUMBER.test(plain) || WINDOW_EXPR.test(plain);
      }, ALLOWED_NUMBERS_FILE),
    ).toEqual([]);
  });

  it("the guard itself catches the usual disguises", () => {
    const disguised = [
      "const isQwen = /qwen/i.test(id);",
      'const id = "gl" + "m-5"; const fam = "glm";',
      "const window = 1_000_000;",
      "const w = 32 * 1024;",
      "const w = 0x8000;",
      'if (id.startsWith("x-ai/")) {}',
    ];
    for (const line of disguised) {
      const plain = line.replace(/(\d)_(?=\d)/g, "$1");
      expect(
        MODEL_NAME.test(line) || WINDOW_NUMBER.test(plain) || WINDOW_EXPR.test(plain),
        line,
      ).toBe(true);
    }
    expect(stripComments('const g = "src/**/*.ts"; const n = 1;')).toContain("const n = 1");
  });
});
