/// <reference types="vitest" />
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Timestamp fixtures assert UTC wall-clock rendering; pin it so local runs match CI.
process.env.TZ = "UTC";

// Explicit opt-in keeps new browser tests in jsdom by default.
const nodeTests = [
  "src/components/TaskCardTags.test.ts",
  "src/lib/allInventory.test.ts",
  "src/lib/calendarExport.test.ts",
  "src/lib/captionHints.test.ts",
  "src/lib/captureSyntax.test.ts",
  "src/lib/cleanupRound.test.ts",
  "src/lib/errorMessage.test.ts",
  "src/lib/googleCalendarShare.test.ts",
  "src/lib/intakeDraft.test.ts",
  "src/lib/localDateTime.test.ts",
  "src/lib/naturalDate.test.ts",
  "src/lib/paperlessAttachments.test.ts",
  "src/lib/projectActivationResolution.test.ts",
  "src/lib/projectListFilter.test.ts",
  "src/lib/projectWorkflow.test.ts",
  "src/lib/referenceContent.test.ts",
  "src/lib/refinementHelpers.test.ts",
  "src/lib/relativeDate.test.ts",
  "src/lib/reminderLabels.test.ts",
  "src/lib/reminderPresets.test.ts",
  "src/lib/revisitPolicy.test.ts",
  "src/lib/serviceWorkerUrls.test.ts",
  "src/lib/shareTarget.test.ts",
  "src/lib/shareText.test.ts",
  "src/lib/shareUrls.test.ts",
  "src/lib/sortOrder.test.ts",
  "src/lib/tagGrouping.test.ts",
  "src/lib/taskHelpers.test.ts",
  "src/lib/taskTreeMove.test.ts",
  "src/lib/workItemRail.test.ts",
];

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: {
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: nodeTests,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          exclude: [...configDefaults.exclude, ...nodeTests],
          setupFiles: ["./src/test/setup.ts"],
          css: true,
        },
      },
    ],
    globals: true,
  },
});
