import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./docs",
  testMatch: /.*\.spec\.mjs/,
  use: {
    headless: true,
  },
  reporter: [["list"]],
});
