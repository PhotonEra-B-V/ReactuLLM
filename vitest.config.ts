import { defineConfig } from "vitest/config";

// The framework's OWN tests. These exercise the SDD pipeline (parser, schema,
// renderer, checks, safety, builder) — they are NOT the generated red suites,
// which target a real React app and its own vitest/RTL setup.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
