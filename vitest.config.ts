import { defineConfig } from "vitest/config";

export default defineConfig({
  // The CLI's TUI is authored in TSX; esbuild uses the automatic JSX runtime (matches tsconfig).
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/test/**/*.test.ts", "packages/**/test/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts", "packages/**/src/**/*.tsx"],
      exclude: ["**/dist/**", "**/*.test.ts", "**/*.test.tsx"],
    },
  },
});
