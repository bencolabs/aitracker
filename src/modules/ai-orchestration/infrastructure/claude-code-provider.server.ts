/**
 * Model provider backed by the locally installed Claude Code CLI.
 *
 * Unlike every other provider in this module, this one makes no HTTP request:
 * it spawns `claude` in headless mode and reads a single JSON result from
 * stdout. Authentication is whatever the user's own CLI already holds, so the
 * profile carries no API key.
 *
 * Three properties are deliberate and load-bearing:
 *
 * - **No shell.** The prompt is passed as an argv element and the aggregate
 *   arrives on stdin, so no user-supplied text is ever parsed by a shell.
 *   (`claude-proxy`, the shell function some users wrap the CLI in, cannot be
 *   spawned for the same reason — its effect is reproduced through `proxyUrl`.)
 * - **No session persistence.** `--no-session-persistence` keeps the call out
 *   of `~/.claude/projects/**`, so the application's own usage scanner does
 *   not count its insight requests as the user's coding activity.
 * - **No ambient context.** `--setting-sources ""`, `--strict-mcp-config` and
 *   `--restricted` stop the CLI from loading CLAUDE.md, hooks, MCP servers and
 *   command-running tools, so the call sees only the prompt and the payload.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";

import { resolveExecutableForLaunch } from "../../../lib/process/executable-path.server.ts";
import type {
  AIErrorCode,
  AIModelProvider,
  AIProviderRequest,
  AIResponse,
  TokenUsage,
} from "../contracts.ts";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
const CLAUDE_CODE_EXECUTABLE = "claude";

/** The CLI pays a large fixed system-prompt cost, so allow a generous window. */
export const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 90_000;
const PROXY_PROBE_TIMEOUT_MS = 1_000;
/** `claude --version` is local-only; it should never take long. */
const PROBE_TIMEOUT_MS = 15_000;
/** Guards against a runaway child filling memory with stdout. */
const MAX_STDOUT_BYTES = 1_000_000;

export class ClaudeCodeInvocationError extends Error {
  constructor(
    readonly code: AIErrorCode,
    readonly detail?: string,
  ) {
    super(code);
    this.name = "ClaudeCodeInvocationError";
  }
}

export interface ClaudeCodeProviderOptions {
  /** CLI model alias or id (`haiku`, `claude-sonnet-5`); CLI default when absent. */
  readonly model?: string;
  /** Optional outbound proxy, mirroring the user's `claude-proxy` wrapper. */
  readonly proxyUrl?: string;
  readonly timeoutMs?: number;
  /** Working directory for the child. Defaults to a context-free temp dir. */
  readonly cwd?: string;
  /** Test seam. Production always uses Node's `child_process.spawn`. */
  readonly spawn?: typeof spawn;
  /** Test seam; defaults to login-shell PATH resolution. */
  readonly resolveExecutable?: (file: string) => Promise<string> | string;
  /** Test seam; defaults to a real TCP connect against the proxy. */
  readonly probeProxy?: (url: string) => Promise<boolean>;
}

/** Shape of `claude -p --output-format json` we actually depend on. */
interface ClaudeCodeResult {
  readonly result?: unknown;
  readonly is_error?: unknown;
  readonly subtype?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly cache_creation_input_tokens?: unknown;
    readonly cache_read_input_tokens?: unknown;
    readonly output_tokens_details?: { readonly thinking_tokens?: unknown };
  };
}

/**
 * Return the contents of the first fenced code block, or the whole answer when
 * there is none.
 *
 * The HTTP providers request structured output through a provider JSON mode;
 * the CLI has no equivalent switch, so a model may wrap its answer in a
 * ```json fence — and, observed in practice, surround that fence with prose
 * ("Here is the analysis…", trailing caveats). Anchoring the fence to the
 * whole string leaves those responses unparseable, so the block is matched
 * wherever it appears and the surrounding prose is dropped with it.
 */
export function stripCodeFence(value: string): string {
  const match = /```[A-Za-z0-9_-]*\r?\n([\s\S]*?)```/.exec(value);
  return match ? match[1].trim() : value.trim();
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

/**
 * Map CLI usage onto `TokenUsage`. Cache-creation and cache-read tokens are
 * folded into the input total: they are real consumption against the user's
 * rate-limit window, and for a small payload they dominate it.
 */
function toTokenUsage(
  usage: ClaudeCodeResult["usage"],
): TokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens =
    positiveInteger(usage.input_tokens) +
    positiveInteger(usage.cache_creation_input_tokens) +
    positiveInteger(usage.cache_read_input_tokens);
  const outputTokens = positiveInteger(usage.output_tokens);
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const reasoningTokens = positiveInteger(
    usage.output_tokens_details?.thinking_tokens,
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

/** Proxy environment mirroring the user's `claude-proxy` shell wrapper. */
function proxyEnvironment(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

/** TCP reachability check, the equivalent of the wrapper's `nc -z` guard. */
async function tcpProbe(url: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  return new Promise((resolve) => {
    const socket = connect({ host: target.hostname, port });
    const settle = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(PROXY_PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function buildArgs(prompt: string, model?: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    // Keep this call out of the log tree the application itself scans.
    "--no-session-persistence",
    // No CLAUDE.md, hooks, plugins, MCP servers or command-running tools.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--restricted",
    "--system-prompt",
    prompt,
    ...(model ? ["--model", model] : []),
  ];
}

/**
 * Availability probe for the settings "test connection" button.
 *
 * Deliberately runs `--version` rather than a real prompt: a prompt would be
 * a genuine end-to-end check but would spend the user's rate-limit window on
 * every click. This confirms the binary resolves and the configured proxy is
 * listening; an authentication problem surfaces on the first real refresh.
 */
export async function probeClaudeCodeAvailability(
  options: ClaudeCodeProviderOptions = {},
): Promise<{ readonly ok: boolean; readonly detail?: string }> {
  const start = options.spawn ?? spawn;
  const resolveExecutable =
    options.resolveExecutable ?? resolveExecutableForLaunch;
  const probeProxy = options.probeProxy ?? tcpProbe;

  if (options.proxyUrl && !(await probeProxy(options.proxyUrl)))
    return { ok: false, detail: "proxy-unreachable" };
  try {
    await runClaudeCode({
      start,
      executable: await resolveExecutable(CLAUDE_CODE_EXECUTABLE),
      args: ["--version"],
      stdin: "",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.proxyUrl ? { env: proxyEnvironment(options.proxyUrl) } : {}),
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof ClaudeCodeInvocationError
          ? (error.detail ?? error.code)
          : "probe-failed",
    };
  }
}

export function createClaudeCodeProvider(
  options: ClaudeCodeProviderOptions = {},
): AIModelProvider {
  const start = options.spawn ?? spawn;
  const resolveExecutable =
    options.resolveExecutable ?? resolveExecutableForLaunch;
  const probeProxy = options.probeProxy ?? tcpProbe;
  const timeoutMs = options.timeoutMs ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS;

  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    async invoke(request: AIProviderRequest): Promise<AIResponse> {
      if (request.signal?.aborted)
        throw new ClaudeCodeInvocationError("ai.cancelled");

      // Fail fast and legibly when the configured proxy is not listening,
      // rather than letting the CLI hang until the timeout.
      if (options.proxyUrl && !(await probeProxy(options.proxyUrl)))
        throw new ClaudeCodeInvocationError(
          "ai.provider-network",
          "proxy-unreachable",
        );

      const executable = await resolveExecutable(CLAUDE_CODE_EXECUTABLE);
      const raw = await runClaudeCode({
        start,
        executable,
        args: buildArgs(request.prompt.template, options.model),
        stdin: request.input.text,
        cwd: options.cwd,
        env: options.proxyUrl ? proxyEnvironment(options.proxyUrl) : undefined,
        timeoutMs,
        signal: request.signal,
      });

      let payload: ClaudeCodeResult;
      try {
        payload = JSON.parse(raw) as ClaudeCodeResult;
      } catch {
        throw new ClaudeCodeInvocationError(
          "ai.provider-invalid-response",
          "not-json",
        );
      }
      if (payload.is_error === true || payload.subtype !== "success")
        throw new ClaudeCodeInvocationError(
          "ai.provider-failed",
          typeof payload.subtype === "string" ? payload.subtype : "cli-error",
        );
      if (typeof payload.result !== "string" || payload.result.trim() === "")
        throw new ClaudeCodeInvocationError(
          "ai.provider-invalid-response",
          "empty-content",
        );

      const usage = toTokenUsage(payload.usage);
      return {
        providerId: CLAUDE_CODE_PROVIDER_ID,
        modelId: options.model ?? request.modelId,
        text: stripCodeFence(payload.result),
        finishReason: "stop",
        ...(usage ? { usage } : {}),
      };
    },
  };
}

interface RunOptions {
  readonly start: typeof spawn;
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Runs the CLI to completion and resolves its stdout, or throws a mapped error. */
function runClaudeCode(options: RunOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = options.start(options.executable, [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (code: AIErrorCode, detail?: string): void => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new ClaudeCodeInvocationError(code, detail));
      });
    };

    const timer = setTimeout(
      () => fail("ai.timeout", "cli-timeout"),
      options.timeoutMs,
    );
    const onAbort = (): void => fail("ai.cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES)
        fail("ai.provider-invalid-response", "output-too-large");
    });
    // Drain stderr so a chatty child cannot deadlock on a full pipe. Its
    // contents are never surfaced: they may quote the prompt back.
    child.stderr?.resume();
    child.once("error", () => fail("ai.provider-unavailable", "spawn-failed"));
    child.once("close", (code: number | null) => {
      if (code === 0) {
        finish(() => resolve(stdout));
        return;
      }
      fail("ai.provider-failed", `exit-${code ?? "signal"}`);
    });

    child.stdin?.on("error", () =>
      fail("ai.provider-unavailable", "stdin-failed"),
    );
    child.stdin?.end(options.stdin);
  });
}
