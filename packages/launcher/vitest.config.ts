import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../server/tests/global-temp.ts"],
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
