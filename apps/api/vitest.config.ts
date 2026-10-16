import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 2,
    globalSetup: ["./tests/globalSetup.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
