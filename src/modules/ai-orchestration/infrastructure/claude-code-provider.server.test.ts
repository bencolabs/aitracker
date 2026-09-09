/**
 * The adapter is the only place a model answer crosses a process boundary,
 * so these tests pin the argv contract (privacy-relevant flags), the fence
 * stripping the HTTP providers get for free from provider JSON mode, and the
 * failure mapping for a CLI that can fail in more ways than an HTTP call.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeInvocationError,
  createClaudeCodeProvider,
  stripCodeFence,
} from "./claude-code-provider.server.ts";
import type { AIProviderRequest } from "../contracts.ts";

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: { end(value: string): void; on(event: string, fn: () => void): void };
  kill(signal?: string): void;
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: {
    readonly env?: Record<string, string>;
    readonly cwd?: string;
  };
  readonly stdin: string[];
}

/** A spawn double that emits `stdout` then closes with `exitCode`. */
function fakeSpawn(options: {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly emitError?: boolean;
  readonly calls: SpawnCall[];
}) {
  return ((file: string, args: readonly string[], spawnOptions: never) => {
    const child = new EventEmitter() as FakeChild;
    const written: string[] = [];
    const stdout = new Readable({ read: () => {} });
    child.stdout = stdout;
    child.stderr = new Readable({ read: () => {} });
    child.stdin = { end: (value: string) => written.push(value), on: () => {} };
    child.kill = () => {};
    options.calls.push({
      file,
      args,
      options: spawnOptions as never,
      stdin: written,
    });
    queueMicrotask(() => {
      if (options.emitError) {
        child.emit("error", new Error("ENOENT"));
        return;
      }
      // `close` must not race the stdout delivery: a real child's output is
      // fully readable by the time the process closes.
      if (options.stdout) stdout.push(options.stdout);
      stdout.push(null);
      stdout.once("end", () => child.emit("close", options.exitCode ?? 0));
    });
    return child as never;
  }) as never;
}

const SUCCESS_PAYLOAD = JSON.stringify({
  subtype: "success",
  is_error: false,
  result: '{"headline":"ok","insights":[]}',
  usage: {
    input_tokens: 9,
    output_tokens: 594,
    cache_creation_input_tokens: 11190,
    cache_read_input_tokens: 0,
    output_tokens_details: { thinking_tokens: 361 },
  },
});

function providerRequest(): AIProviderRequest {
  return {
    requestId: "req-1",
    modelId: "fallback-model",
    prompt: { id: "p", version: 1, template: "SYSTEM PROMPT" },
    input: { text: '{"totals":{"events":1}}' },
    signal: new AbortController().signal,
  } as AIProviderRequest;
}

function provider(options: Parameters<typeof createClaudeCodeProvider>[0]) {
  return createClaudeCodeProvider({
    resolveExecutable: (file) => `/usr/local/bin/${file}`,
    ...options,
  });
}

test("passes the aggregate on stdin and the prompt as argv", async () => {
  const calls: SpawnCall[] = [];
  const response = await provider({
    model: "haiku",
    spawn: fakeSpawn({ stdout: SUCCESS_PAYLOAD, calls }),
  }).invoke(providerRequest());

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.file, "/usr/local/bin/claude");
  // The payload must never reach argv, where `ps` would expose it.
  assert.ok(!call.args.some((arg) => arg.includes("totals")));
  assert.deepEqual(call.stdin, ['{"totals":{"events":1}}']);
  assert.equal(response.providerId, CLAUDE_CODE_PROVIDER_ID);
  assert.equal(response.modelId, "haiku");
});

test("spawns with the flags that keep the call private and context-free", async () => {
  const calls: SpawnCall[] = [];
  await provider({
    spawn: fakeSpawn({ stdout: SUCCESS_PAYLOAD, calls }),
  }).invoke(providerRequest());
  const args = calls[0].args;

  // Keeps the call out of ~/.claude/projects, which this app itself scans.
  assert.ok(args.includes("--no-session-persistence"));
  // No CLAUDE.md / hooks / MCP / command-running tools.
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--restricted"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "SYSTEM PROMPT");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
});

test("omits --model so the CLI picks its own default", async () => {
  const calls: SpawnCall[] = [];
  await provider({
    spawn: fakeSpawn({ stdout: SUCCESS_PAYLOAD, calls }),
  }).invoke(providerRequest());
  assert.ok(!calls[0].args.includes("--model"));
});

test("counts cache tokens as real input consumption", async () => {
  const calls: SpawnCall[] = [];
  const response = await provider({
    spawn: fakeSpawn({ stdout: SUCCESS_PAYLOAD, calls }),
  }).invoke(providerRequest());

  // 9 + 11190 + 0 — the fixed system-prompt cost dominates a small payload
  // and must not be reported as a 9-token request.
  assert.equal(response.usage?.inputTokens, 11_199);
  assert.equal(response.usage?.outputTokens, 594);
  assert.equal(response.usage?.totalTokens, 11_793);
  assert.equal(response.usage?.reasoningTokens, 361);
});

test("strips a markdown fence the CLI has no JSON mode to prevent", async () => {
  const calls: SpawnCall[] = [];
  const fenced = JSON.stringify({
    subtype: "success",
    is_error: false,
    result: '```json\n{"headline":"ok"}\n```',
  });
  const response = await provider({
    spawn: fakeSpawn({ stdout: fenced, calls }),
  }).invoke(providerRequest());

  assert.equal(response.text, '{"headline":"ok"}');
  assert.doesNotThrow(() => JSON.parse(response.text));
});

test("stripCodeFence leaves bare JSON untouched", () => {
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
  assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('  ```json\n{"a":1}\n```  '), '{"a":1}');
});

test("stripCodeFence drops prose surrounding the fence", () => {
  // Observed against the real CLI: a fenced answer introduced and followed by
  // commentary. Anchoring the fence to the whole string left this unparseable.
  const withProse =
    'Here is the analysis:\n\n```json\n{"a":1}\n```\n\nLet me know if you want more detail.';
  assert.equal(stripCodeFence(withProse), '{"a":1}');
  assert.doesNotThrow(() => JSON.parse(stripCodeFence(withProse)));

  assert.equal(stripCodeFence('Preamble.\n```\n{"a":1}\n```'), '{"a":1}');
});

test("sets proxy environment only when a proxy is configured", async () => {
  const withProxy: SpawnCall[] = [];
  await provider({
    proxyUrl: "http://127.0.0.1:2334",
    probeProxy: async () => true,
    spawn: fakeSpawn({ stdout: SUCCESS_PAYLOAD, calls: withProxy }),
  }).invoke(providerRequest());
  assert.equal(withProxy[0].options.env?.HTTPS_PROXY, "http://127.0.0.1:2334");
  assert.equal(withProxy[0].options.env?.NO_PROXY, "127.0.0.1,localhost");

  // With no proxy configured the adapter injects nothing and the child simply
  // inherits the host environment, whatever that happens to contain.
  const withoutProxy: SpawnCall[] = [];
  await provider({
    spawn: fakeSpawn({ stdout: SUCCESS_PAYLOAD, calls: withoutProxy }),
  }).invoke(providerRequest());
  assert.equal(
    withoutProxy[0].options.env?.HTTPS_PROXY,
    process.env.HTTPS_PROXY,
  );
});

test("fails fast when the configured proxy is not listening", async () => {
  const calls: SpawnCall[] = [];
  await assert.rejects(
    provider({
      proxyUrl: "http://127.0.0.1:2334",
      probeProxy: async () => false,
      spawn: fakeSpawn({ stdout: SUCCESS_PAYLOAD, calls }),
    }).invoke(providerRequest()),
    (error: unknown) =>
      error instanceof ClaudeCodeInvocationError &&
      error.code === "ai.provider-network" &&
      error.detail === "proxy-unreachable",
  );
  assert.equal(calls.length, 0, "must not spawn when the proxy is down");
});

test("maps a non-zero exit to a provider failure", async () => {
  const calls: SpawnCall[] = [];
  await assert.rejects(
    provider({
      spawn: fakeSpawn({ stdout: "", exitCode: 1, calls }),
    }).invoke(providerRequest()),
    (error: unknown) =>
      error instanceof ClaudeCodeInvocationError &&
      error.code === "ai.provider-failed",
  );
});

test("maps a missing executable to provider-unavailable", async () => {
  const calls: SpawnCall[] = [];
  await assert.rejects(
    provider({
      spawn: fakeSpawn({ emitError: true, calls }),
    }).invoke(providerRequest()),
    (error: unknown) =>
      error instanceof ClaudeCodeInvocationError &&
      error.code === "ai.provider-unavailable",
  );
});

test("maps malformed stdout to an invalid response", async () => {
  const calls: SpawnCall[] = [];
  await assert.rejects(
    provider({
      spawn: fakeSpawn({ stdout: "not json at all", calls }),
    }).invoke(providerRequest()),
    (error: unknown) =>
      error instanceof ClaudeCodeInvocationError &&
      error.code === "ai.provider-invalid-response" &&
      error.detail === "not-json",
  );
});

test("rejects a CLI-reported error even on a zero exit", async () => {
  const calls: SpawnCall[] = [];
  const payload = JSON.stringify({
    subtype: "error_during_execution",
    is_error: true,
    result: "something went wrong",
  });
  await assert.rejects(
    provider({ spawn: fakeSpawn({ stdout: payload, calls }) }).invoke(
      providerRequest(),
    ),
    (error: unknown) =>
      error instanceof ClaudeCodeInvocationError &&
      error.code === "ai.provider-failed",
  );
});

test("rejects an empty result rather than returning blank text", async () => {
  const calls: SpawnCall[] = [];
  const payload = JSON.stringify({
    subtype: "success",
    is_error: false,
    result: "   ",
  });
  await assert.rejects(
    provider({ spawn: fakeSpawn({ stdout: payload, calls }) }).invoke(
      providerRequest(),
    ),
    (error: unknown) =>
      error instanceof ClaudeCodeInvocationError &&
      error.detail === "empty-content",
  );
});

test("honours an already-aborted signal without spawning", async () => {
  const calls: SpawnCall[] = [];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider({ spawn: fakeSpawn({ stdout: SUCCESS_PAYLOAD, calls }) }).invoke({
      ...providerRequest(),
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof ClaudeCodeInvocationError &&
      error.code === "ai.cancelled",
  );
  assert.equal(calls.length, 0);
});
