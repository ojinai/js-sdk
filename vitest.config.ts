import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/version.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 85,
        statements: 80,
        // Critical paths keep the baseline gate explicitly pinned here so the
        // coverage target remains visible if global thresholds change later.
        "src/ojin-client.ts": {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
        "src/protocol/error-mapping.ts": {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
      },
    },
  },
});
