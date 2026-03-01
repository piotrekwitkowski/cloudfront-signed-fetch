import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_URL,
  },
});
