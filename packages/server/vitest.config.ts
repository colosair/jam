import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-temp.ts"],
    include: ["tests/**/*.test.ts"],
    // Integration tests hit a real Jira and are opt-in via JAM_INTEGRATION=1.
    environment: "node",
    // Repoints the home directory before anything imports, so a test that
    // forgets to inject `home` cannot write into the developer's own ~/.jam.
    setupFiles: ["tests/setup-env.ts"],
  },
});
