import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests hit a real Jira and are opt-in via JAM_INTEGRATION=1.
    environment: "node",
  },
});
