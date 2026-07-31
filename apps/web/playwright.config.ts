import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3110",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "桌面浏览器",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } }
    }
  ],
  webServer: {
    command: "node scripts/start-e2e-standalone.mjs",
    url: "http://127.0.0.1:3110",
    env: { WORKBENCH_LLM_MODE: "mock", PORT: "3110", HOSTNAME: "127.0.0.1" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
