import { writeFile } from "node:fs/promises";
import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from "playwright/test";

const routes = [
  ["/agents", "Agent概览"],
  ["/distill", "蒸馏工作台"],
  ["/memory", "记忆"],
  ["/reports", "日报周报"],
  ["/chats", "会话管理"],
  ["/skills", "Skill 管理"],
  ["/security", "安全检测"],
  ["/market", "安全市场"],
  ["/tracker", "燃烧榜"],
  ["/sources", "数据来源"],
  ["/settings", "设置"],
] as const;

type RouteSample = {
  readonly route: string;
  readonly firstOpenMs: number;
  readonly cachedOpenMs: number;
};

async function preparePage(browser: Browser): Promise<{
  page: Page;
  close(): Promise<void>;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.removeItem("aitracker-locale");
    window.localStorage.removeItem("aitracker-locale-mode");
    Object.defineProperty(window.navigator, "language", {
      get: () => "zh-CN",
      configurable: true,
    });
  });
  // Locale/currency preferences are SQLite-backed. Normalize them through
  // the UI because clearing localStorage alone cannot undo another test's
  // persisted language choice (and would make Chinese sidebar labels vanish).
  await page.goto("/settings", {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForURL(/locale=/, { timeout: 30_000 });
  await page
    .getByRole("button", {
      name: /^(应用偏好|App preferences|アプリ設定|앱 환경설정)$/,
    })
    .click();
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await expect(page.locator("main")).toBeVisible();
  return { page, close: () => context.close() };
}

/**
 * /distill mounts a one-time first-run guide modal after hydration. While a
 * Radix modal is open the app marks the background content as aria-hidden,
 * which hides the sidebar links from role-based locators — the benchmark
 * would otherwise stall when navigating away from /distill. Consume the modal
 * whenever it is present, right before a sidebar navigation.
 */
async function dismissGuideIfOpen(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "开始使用" });
  try {
    await dismiss.waitFor({ state: "visible", timeout: 2_500 });
    await dismiss.click();
  } catch {
    // No guide modal on this page (or it already appeared and was consumed).
  }
}

async function openFromSidebar(
  page: Page,
  route: string,
  label: string,
): Promise<number> {
  await dismissGuideIfOpen(page);
  const renderedName = `aitracker:navigation:rendered:${route}`;
  const startedAt = performance.now();
  await page.evaluate((name) => performance.clearMarks(name), renderedName);
  // Calling click from the DOM avoids Playwright's implicit hover, so this is
  // an actual no-preload first click rather than an intent-preloaded sample.
  await page
    .getByRole("link", { name: label, exact: true })
    .evaluate((link) => link.click());
  await page.waitForURL((url) => url.pathname === route, { timeout: 90_000 });
  await page.waitForFunction(
    (name) => performance.getEntriesByName(name).length > 0,
    renderedName,
    { timeout: 30_000 },
  );
  return performance.now() - startedAt;
}

/**
 * Best-effort dismissal of the /distill first-run guide before benchmarking.
 * The guide preference is persisted over a fire-and-forget server request and
 * the modal only appears after hydration, so probe a few times until a probe
 * page no longer shows it. `openFromSidebar` additionally consumes the modal
 * on sight, so a missed probe can never stall the loop.
 */
async function dismissFirstRunGuide(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const page = await context.newPage();
      await page.goto("/distill", { waitUntil: "domcontentloaded" });
      const dismiss = page.getByRole("button", { name: "开始使用" });
      try {
        await dismiss.waitFor({ state: "visible", timeout: 8_000 });
      } catch {
        // Not shown: the guide is already dismissed for this workspace.
        await page.close();
        return;
      }
      await dismiss.click();
      // Leave the click's server request time to finish before probing again.
      await page.waitForTimeout(750);
      await page.close();
    }
  } finally {
    await context.close();
  }
}

test("route opening benchmark reports first-open and cached navigation latency", async ({
  browser,
}, testInfo: TestInfo) => {
  test.setTimeout(15 * 60_000);
  await dismissFirstRunGuide(browser);
  const samples: RouteSample[] = [];

  for (const [route, label] of routes) {
    const first = await preparePage(browser);
    const firstOpenMs = await openFromSidebar(first.page, route, label);
    await first.close();

    const cached = await preparePage(browser);
    await openFromSidebar(cached.page, route, label);
    await openFromSidebar(cached.page, "/", "首页总览");
    const secondOpenMs = await openFromSidebar(cached.page, route, label);
    await cached.close();

    // The first route entry is cold from the renderer/router perspective; the
    // second visit verifies the actual in-app cache-navigation experience.
    samples.push({
      route,
      firstOpenMs: Math.round(firstOpenMs),
      cachedOpenMs: Math.round(secondOpenMs),
    });
  }

  console.table(samples);
  await writeFile(
    testInfo.outputPath("route-open-performance.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), samples }, null, 2)}\n`,
  );
  expect(samples).toHaveLength(routes.length);
});
