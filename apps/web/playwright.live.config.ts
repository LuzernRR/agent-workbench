import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/live",
  fullyParallel: false,
  workers: 1,
  timeout: 360_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-live" }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_LIVE_BASE_URL || "http://127.0.0.1:3000",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [{
    name: "production-live",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } }
  }]
});
