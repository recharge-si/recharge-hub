import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import type { ZodType } from "zod";

import { extractJson } from "~/domain/extract-json";

/**
 * Asking Claude through claude-pool (docs/attributes.md § Bulk filling with
 * claude-pool). One module for every caller: the operator's attribute filler
 * and, later, the rig builder.
 *
 * Rules every call follows, so no caller can forget one:
 *
 * - The command is spawned with an argument array, never a shell string.
 * - Every tool is off (`--tools ""`), no MCP server, no slash command, no
 *   `--add-dir`, nothing persisted: the model can only answer in text. The
 *   flag is the one the installed `claude --help` documents (`--allowedTools`
 *   only pre-approves tools, it does not remove them).
 * - The child gets a scrubbed environment: a short allow-list plus
 *   `CLAUDE_POOL_*`. Database URLs, Shopify and MetaKocka secrets and
 *   `ANTHROPIC_*` keys (which would bill the API instead of the pool) never
 *   reach it.
 * - A timeout kills the child's whole process group.
 * - A semaphore bounds how many run at once; a caller that must not queue
 *   sets `maxWaiting` and gets `busy`.
 * - Exit code 75 is "every account is full": `exhausted`, never an error.
 */

export type ClaudePoolFailure =
  | { ok: false; reason: "exhausted" }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "error"; message: string };

/** Tokens as the envelope reports them; zero when it does not. */
export interface ClaudePoolUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export type ClaudePoolResult<T> =
  | {
      ok: true;
      value: T;
      model: string | null;
      text: string;
      usage: ClaudePoolUsage;
    }
  | ClaudePoolFailure;

export interface ClaudePoolOptions<T> {
  /** Parses the reply's JSON; a reply that does not match is an `error`. */
  schema?: ZodType<T>;
  /** `--model`, e.g. an alias such as `sonnet`. */
  model?: string;
  /** Milliseconds before the call is killed. Default 120 000. */
  timeoutMs?: number;
  /** The executable. Default `claude-pool` (found on `PATH`). */
  command?: string;
  /** Where the child runs. Default the OS temp directory, so no project files or CLAUDE.md are in reach. */
  cwd?: string;
  /** Concurrent calls in this process. Default 2. */
  maxConcurrent?: number;
  /** Calls allowed to wait for a slot; more is `busy`. Default unlimited. */
  maxWaiting?: number;
  /** Extra `CLAUDE_POOL_*`-style variables for the child. */
  env?: Record<string, string>;
}

export const EXIT_EXHAUSTED = 75;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONCURRENCY = 2;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** The only variables (beside `CLAUDE_POOL_*`) a child may see. */
const ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
];

export function scrubbedEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_ALLOW.includes(name) || name.startsWith("CLAUDE_POOL_"))
      env[name] = value;
  }
  return { ...env, ...extra };
}

/** The arguments of one call. The prompt is one argument, whatever it holds. */
export function claudePoolArgs(
  prompt: string,
  options: { model?: string } = {},
): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--strict-mcp-config",
  ];
  if (options.model) args.push("--model", options.model);
  // Last, because `--tools` takes a list and would swallow what follows.
  args.push("--tools", "");
  return args;
}

/* -------------------------------------------------------------------------- */
/* The semaphore                                                              */
/* -------------------------------------------------------------------------- */

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  /** Resolves with a release function, or null when too many already wait. */
  async acquire(
    limit: number,
    maxWaiting: number,
  ): Promise<(() => void) | null> {
    if (this.active < limit) {
      this.active += 1;
      return () => this.release();
    }
    if (this.waiting.length >= maxWaiting) return null;
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return () => this.release();
  }

  private release() {
    const next = this.waiting.shift();
    // The slot passes to the next waiter without being freed.
    if (next) next();
    else this.active -= 1;
  }
}

const semaphore = new Semaphore();

/* -------------------------------------------------------------------------- */
/* The call                                                                   */
/* -------------------------------------------------------------------------- */

interface RawRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

function run(
  command: string,
  args: string[],
  input: {
    env: Record<string, string>;
    cwd: string;
    timeoutMs: number;
  },
): Promise<RawRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (result: Omit<RawRun, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const child = spawn(command, args, {
      env: input.env,
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      done({ code: null, spawnError: error.message }),
    );
    child.on("close", (code) => done({ code, spawnError: null }));
  });
}

/** What `--output-format json` prints: the result text, the model and the tokens. */
export function parseEnvelope(stdout: string): {
  text: string;
  model: string | null;
  usage: ClaudePoolUsage;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const envelope = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (!envelope || typeof envelope !== "object") return null;
  const record = envelope as Record<string, unknown>;
  if (record["is_error"] === true) return null;
  const text = record["result"];
  if (typeof text !== "string") return null;
  const modelUsage = record["modelUsage"];
  const model =
    modelUsage && typeof modelUsage === "object"
      ? (Object.keys(modelUsage)[0] ?? null)
      : null;
  const raw = record["usage"];
  const count = (name: string): number => {
    const value =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)[name]
        : undefined;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    text,
    model,
    usage: {
      inputTokens: count("input_tokens"),
      cachedInputTokens: count("cache_read_input_tokens"),
      outputTokens: count("output_tokens"),
    },
  };
}

export async function runClaudePool(
  prompt: string,
  options?: Omit<ClaudePoolOptions<string>, "schema">,
): Promise<ClaudePoolResult<string>>;
export async function runClaudePool<T>(
  prompt: string,
  options: ClaudePoolOptions<T> & { schema: ZodType<T> },
): Promise<ClaudePoolResult<T>>;
export async function runClaudePool<T>(
  prompt: string,
  options: ClaudePoolOptions<T> = {},
): Promise<ClaudePoolResult<T | string>> {
  const release = await semaphore.acquire(
    options.maxConcurrent ?? DEFAULT_CONCURRENCY,
    options.maxWaiting ?? Number.POSITIVE_INFINITY,
  );
  if (!release) return { ok: false, reason: "busy" };
  try {
    const raw = await run(
      options.command ?? "claude-pool",
      claudePoolArgs(prompt, options.model ? { model: options.model } : {}),
      {
        env: scrubbedEnv(process.env, options.env),
        cwd: options.cwd ?? tmpdir(),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    );
    if (raw.timedOut) return { ok: false, reason: "timeout" };
    if (raw.spawnError)
      return {
        ok: false,
        reason: "error",
        message: `claude-pool could not start: ${raw.spawnError}`,
      };
    if (raw.code === EXIT_EXHAUSTED) return { ok: false, reason: "exhausted" };
    if (raw.code !== 0)
      return {
        ok: false,
        reason: "error",
        message: `claude-pool exited with ${raw.code ?? "a signal"}: ${raw.stderr.trim().slice(0, 300)}`,
      };
    const envelope = parseEnvelope(raw.stdout);
    if (!envelope)
      return {
        ok: false,
        reason: "error",
        message: "claude-pool printed no usable result.",
      };
    if (!options.schema)
      return {
        ok: true,
        value: envelope.text,
        model: envelope.model,
        text: envelope.text,
        usage: envelope.usage,
      };
    const json = extractJson(envelope.text);
    const checked = options.schema.safeParse(json);
    if (!checked.success)
      return {
        ok: false,
        reason: "error",
        message: "The reply was not the JSON that was asked for.",
      };
    return {
      ok: true,
      value: checked.data,
      model: envelope.model,
      text: envelope.text,
      usage: envelope.usage,
    };
  } finally {
    release();
  }
}

/* -------------------------------------------------------------------------- */
/* Pool status                                                                */
/* -------------------------------------------------------------------------- */

const FALLBACK_WAIT_MS = 15 * 60_000;
const MIN_WAIT_MS = 60_000;
const MAX_WAIT_MS = 6 * 60 * 60_000;

/**
 * Milliseconds until the first account resets, read off `--pool-status`
 * text: each account line has a `(in 1h24m)` for its 5-hour window; the
 * soonest wins. Anything unreadable is 15 minutes.
 */
export function waitFromPoolStatus(text: string): number {
  let soonest: number | null = null;
  for (const line of text.split("\n")) {
    const match = /\(in (?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?\)/.exec(line);
    if (!match) continue;
    const ms =
      (Number(match[1] ?? 0) * 24 * 60 +
        Number(match[2] ?? 0) * 60 +
        Number(match[3] ?? 0)) *
      60_000;
    if (ms > 0 && (soonest === null || ms < soonest)) soonest = ms;
  }
  if (soonest === null) return FALLBACK_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, soonest + 60_000));
}

/** How long to pause after `exhausted`. Never throws. */
export async function poolResetWaitMs(
  command = "claude-pool",
): Promise<number> {
  const raw = await run(command, ["--pool-status"], {
    env: scrubbedEnv(process.env),
    cwd: tmpdir(),
    timeoutMs: 20_000,
  });
  if (raw.timedOut || raw.spawnError || raw.code !== 0) return FALLBACK_WAIT_MS;
  return waitFromPoolStatus(raw.stdout);
}

/**
 * Whether the installed `claude` still documents `--tools` (the flag that
 * turns every tool off). A runner calls this once before it starts and
 * refuses to run without it: a CLI that dropped the flag would otherwise
 * run with tools on.
 */
export async function claudeSupportsToolsFlag(
  command = "claude",
): Promise<boolean> {
  const raw = await run(command, ["--help"], {
    env: scrubbedEnv(process.env),
    cwd: tmpdir(),
    timeoutMs: 20_000,
  });
  return raw.code === 0 && /^\s*--tools\b/m.test(raw.stdout);
}
