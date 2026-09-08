import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "playwright/test";

/**
 * Dedicated config for machine-bound scenarios that assert against the *real*
 * local workspace: Skills actually installed under the real HOME (/skills
 * count + selection), installed agents and their platform data roots
 * (/sources). A clean CI runner has neither, so the default suite skips them
 * unless this config exports AITRACKER_E2E_LOCAL_WORKSPACE.
 *
 * The usage database still points at a throwaway temp directory (the spec
 * assertions never need seeded usage rows), while Skills/installation
 * scanning reads the real HOME of the machine running the suite.
 *
 * Run on a developer machine:
 *   npx playwright test -c playwright.config.local-workspace.ts desktop.spec.ts full-system-smoke.spec.ts
 */

const port = 41741;
const workspaceHome = mkdtempSync(join(tmpdir(), "aitracker-local-workspace-"));

// The env vars must also reach the test process (specs read them to decide
// whether to skip), not just the web server.
process.env.AITRACKER_USAGE_HOME = workspaceHome;
process.env.AITRACKER_E2E_LOCAL_WORKSPACE = workspaceHome;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      AITRACKER_USAGE_HOME: workspaceHome,
      AITRACKER_E2E_LOCAL_WORKSPACE: workspaceHome,
      // Keep the test dev server deterministic: no background scheduler.
      AITRACKER_ENABLE_BACKGROUND_TASKS: "false",
    },
  },
});
