import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inject the real package version at build time so `--version` never drifts from package.json (it used to
// print a hardcoded "0.1.0"). Under tsc/vitest (no esbuild define) the code falls back to "dev".
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  entry: { amb: "src/amb.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  define: { __AMB_VERSION__: JSON.stringify(version) },
  // Bundle the workspace packages + pure-JS deps into one self-contained `amb` file. React/Ink stay
  // external (installed in node_modules) — they use conditional exports that don't bundle cleanly.
  noExternal: [/^@amb\//, "zod"],
  // undici (web_fetch's IP-pinned dispatcher) stays external — it's CJS with `require("assert")` internals
  // that don't survive ESM bundling; loaded from node_modules at runtime like react/ink.
  external: [
    "better-sqlite3",
    "node-pty",
    "react",
    "ink",
    "react/jsx-runtime",
    "yoga-wasm-web",
    "undici",
  ],
  banner: { js: "#!/usr/bin/env node" },
  // The TUI uses the automatic JSX runtime (no classic `import React`); tell esbuild to match.
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
