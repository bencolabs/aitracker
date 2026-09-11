import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createDashboardAIInsightService,
  type DashboardAIInsightInput,
  type DashboardAIInsightRuntimeConfig,
} from "./ai-insight.server.ts";

// Regression context: CLI gateways (e.g. GLM-backed `claude` remotes) ignore
// soft length guidance and return fenced JSON with fields past the display
// caps. The output must be clamped to the schema limits, not discarded.
const claudeCodeConfig: DashboardAIInsightRuntimeConfig = {
  protocol: "claude-code",
  auth: "bearer",
  endpoint: "",
  apiKey: "",
  model: "haiku",
  cliModel: "haiku",
};

function input(): DashboardAIInsightInput {
  return {
    range: { preset: "30d" },
    totals: {
      events: 12,
      totalTokens: 8100,
      inputTokens: 5000,
      cachedInputTokens: 2000,
      outputTokens: 1100,
      cacheRatePercent: 28.5,
      estimatedCostUsd: 0.24,
      costQuality: "available",
    },
    topModels: [{ label: "claude-haiku", tokens: 8100, events: 12 }],
    topProjects: [{ label: "aitracker_webapp", tokens: 8100, events: 12 }],
    topTools: [{ label: "Claude Code", tokens: 8100, events: 12 }],
    monitoring: {
      running: true,
      pendingCount: 0,
      collectorHealth: [{ id: "usage", state: "healthy" }],
    },
    security: {
      available: true,
      assessedAssets: 6,
      failedAssets: 0,
      suspicious: 0,
      dangerous: 0,
    },
    outputs: {
      securityRuns: { available: false, count: null },
      distillationOutputs: { available: true, count: 2 },
      dailyReports: { available: true, count: 1 },
    },
  };
}

/** Minimal `claude -p --output-format json` double emitting `cliResult`. */
function fakeClaudeCli(cliResult: string) {
  return ((_file: string, _args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: { end(v: string): void; on(e: string, f: () => void): void };
      kill(): void;
    };
    const stdout = new Readable({ read: () => {} });
    child.stdout = stdout;
    child.stderr = new Readable({ read: () => {} });
    child.stdin = { end: () => {}, on: () => {} };
    child.kill = () => {};
    queueMicrotask(() => {
      stdout.push(
        JSON.stringify({
          subtype: "success",
          is_error: false,
          result: "```json\n" + cliResult + "\n```",
          usage: { input_tokens: 5, output_tokens: 50 },
        }),
      );
      stdout.push(null);
      stdout.once("end", () => child.emit("close", 0));
    });
    return child as never;
  }) as never;
}

test("clamps an over-long detail instead of discarding the insight", async () => {
  const longDetail = "d".repeat(450);
  const cliResult = JSON.stringify({
    headline: "Steady window.",
    insights: [
      { title: "Cache coverage", detail: longDetail, severity: "info" },
    ],
  });
  const service = createDashboardAIInsightService({
    resolveConfig: async () => claudeCodeConfig,
    spawn: fakeClaudeCli(cliResult),
  });

  const result = await service.refresh(input());
  assert.equal(result.status, "ready");
  assert.equal(result.insight?.insights[0]?.detail.length, 260);
});

test("clamps headline, title, and item count to the schema limits", async () => {
  const cliResult = JSON.stringify({
    headline: "h".repeat(300),
    insights: [
      {
        title: "t".repeat(120),
        detail: "d".repeat(300),
        severity: "info",
      },
      {
        title: "second",
        detail: "second detail",
        severity: "attention",
      },
      {
        title: "third",
        detail: "third detail",
        severity: "risk",
      },
      {
        title: "fourth",
        detail: "must be dropped",
        severity: "info",
      },
    ],
  });
  const service = createDashboardAIInsightService({
    resolveConfig: async () => claudeCodeConfig,
    spawn: fakeClaudeCli(cliResult),
  });

  const result = await service.refresh(input());
  assert.equal(result.status, "ready");
  assert.equal(result.insight?.headline.length, 180);
  const insights = result.insight?.insights ?? [];
  assert.equal(insights.length, 3);
  assert.equal(insights[0]?.title.length, 80);
  assert.equal(insights[0]?.detail.length, 260);
  assert.equal(insights[2]?.title, "third");
});

test("still rejects output whose severity is not a schema value", async () => {
  const cliResult = JSON.stringify({
    headline: "Steady window.",
    insights: [
      {
        title: "Cache coverage",
        detail: "d".repeat(300),
        severity: "yelling",
      },
    ],
  });
  const service = createDashboardAIInsightService({
    resolveConfig: async () => claudeCodeConfig,
    spawn: fakeClaudeCli(cliResult),
  });

  const result = await service.refresh(input());
  assert.equal(result.status, "invalid-output");
  assert.equal(result.insight, null);
});
