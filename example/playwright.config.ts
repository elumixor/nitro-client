import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:5199",
  },
  webServer: [
    {
      command: "npx nitropack dev --port 3456",
      cwd: "./backend",
      port: 3456,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npx vite --port 5199",
      cwd: "./frontend",
      port: 5199,
      reuseExistingServer: false,
      timeout: 15_000,
    },
  ],
});
