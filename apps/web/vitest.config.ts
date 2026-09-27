/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Timestamp fixtures assert UTC wall-clock rendering; pin it so local runs match CI.
process.env.TZ = "UTC";

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
