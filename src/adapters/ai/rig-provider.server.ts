import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ZodType } from "zod";

import {
  claudeSupportsToolsFlag,
  runClaudePool,
} from "~/adapters/ai/claude-pool.server";
import { getEnv } from "~/adapters/config/env.server";

/**
 * The model behind the rig builder (docs/rig-builder.md § Provider). The
 * builder asks for one thing: a JSON object that matches a schema, within a
 * time. Where the answer comes from is behind `RigAiProvider`, so claude-pool
 * can be swapped for something else without touching the service.
 *
 * `ClaudePoolProvider` runs the shared runner (`claude-pool.server.ts`) with
 * every rule the runner enforces (argument array, tools off, scrubbed
 * environment, process-group kill on timeout) plus three of its own: a
 * dedicated empty `HOME`, an empty working directory, and a concurrency cap
 * that answers `busy` at once instead of queueing a buyer behind a slow call.
 */

export type ProviderResult<T> =
  | { ok: true; value: T; model: string | null; latencyMs: number }
  | {
      ok: false;
      reason: "timeout" | "busy" | "exhausted" | "error";
      message?: string;
      latencyMs: number;
    };

export interface RigAiProvider {
  readonly name: string;
  /** Whether the provider can be used safely at all (for claude-pool: the installed `claude` can turn tools off). */
  ready(): Promise<boolean>;
  complete<T>(
    prompt: string,
    schema: ZodType<T>,
    options: { timeoutMs: number },
  ): Promise<ProviderResult<T>>;
}

export interface ClaudePoolProviderOptions {
  model: string;
  maxConcurrent: number;
  /** The `claude-pool` executable. Default: found on `PATH`. */
  command?: string;
  /** The `claude` executable checked for the tools flag. Default: found on `PATH`. */
  claudeCommand?: string;
  /** A directory the child may call home. Default: an empty one in the temp dir. */
  homeDir?: string;
  /** Where the child runs. Default: an empty directory in the temp dir. */
  workDir?: string;
}

function emptyDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export class ClaudePoolProvider implements RigAiProvider {
  readonly name = "claude-pool";
  private toolsFlag: Promise<boolean> | undefined;

  constructor(private readonly options: ClaudePoolProviderOptions) {}

  /** Checked once per process: a CLI that dropped `--tools` would run with tools on. */
  ready(): Promise<boolean> {
    this.toolsFlag ??= claudeSupportsToolsFlag(
      this.options.claudeCommand ?? "claude",
    ).catch(() => false);
    return this.toolsFlag;
  }

  async complete<T>(
    prompt: string,
    schema: ZodType<T>,
    options: { timeoutMs: number },
  ): Promise<ProviderResult<T>> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    if (!(await this.ready())) {
      return {
        ok: false,
        reason: "error",
        message: "The installed claude cannot turn tools off.",
        latencyMs: elapsed(),
      };
    }
    const result = await runClaudePool(prompt, {
      schema,
      model: this.options.model,
      timeoutMs: options.timeoutMs,
      maxConcurrent: this.options.maxConcurrent,
      maxWaiting: 0,
      ...(this.options.command ? { command: this.options.command } : {}),
      cwd:
        this.options.workDir ?? emptyDir(join(tmpdir(), "recharge-hub-rig-work")),
      env: {
        HOME:
          this.options.homeDir ??
          emptyDir(join(tmpdir(), "recharge-hub-rig-home")),
      },
    });
    if (result.ok) {
      return {
        ok: true,
        value: result.value,
        model: result.model,
        latencyMs: elapsed(),
      };
    }
    return {
      ok: false,
      reason: result.reason,
      ...(result.reason === "error" ? { message: result.message } : {}),
      latencyMs: elapsed(),
    };
  }
}

let shared: RigAiProvider | undefined;

/** The provider this deployment is configured for. */
export function getRigAiProvider(): RigAiProvider {
  if (!shared) {
    const env = getEnv();
    shared = new ClaudePoolProvider({
      model: env.RIG_AI_MODEL,
      maxConcurrent: env.RIG_AI_MAX_CONCURRENT,
    });
  }
  return shared;
}
