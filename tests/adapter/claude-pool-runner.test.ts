import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  claudePoolArgs,
  claudeSupportsToolsFlag,
  extractJson,
  parseEnvelope,
  poolResetWaitMs,
  runClaudePool,
  scrubbedEnv,
  waitFromPoolStatus,
} from "~/adapters/ai/claude-pool.server";
import {
  envelope,
  installFakeClaude,
  scripted,
} from "../support/fake-claude-pool";

const fake = installFakeClaude();
const work = mkdtempSync(join(tmpdir(), "claude-pool-test-"));

beforeAll(() => {
  vi.stubEnv("PATH", fake.pathWith());
});
afterEach(() => {
  fake.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("PATH", fake.pathWith());
});

function script(...lines: string[]): string {
  const file = join(work, `script-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, lines.join("\n") + "\n");
  fake.set("script", file);
  return file;
}

describe("claudePoolArgs", () => {
  it("is an argument array with tools off and the prompt as one argument", () => {
    const prompt = '"; rm -rf / ; $(echo hi) --add-dir /';
    const args = claudePoolArgs(prompt, { model: "sonnet" });
    expect(args.slice(0, 2)).toEqual(["-p", prompt]);
    expect(args).toContain("json");
    expect(args.slice(-2)).toEqual(["--tools", ""]);
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--strict-mcp-config");
  });
});

describe("scrubbedEnv", () => {
  it("keeps the allow-list and CLAUDE_POOL_*, drops secrets", () => {
    const env = scrubbedEnv({
      PATH: "/bin",
      HOME: "/home/x",
      HUB_DATABASE_URL: "postgres://secret",
      ANTHROPIC_API_KEY: "sk-ant",
      SHOPIFY_API_SECRET: "s",
      CLAUDE_POOL_DIR: "/pool",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/x",
      CLAUDE_POOL_DIR: "/pool",
    });
  });
});

describe("parseEnvelope and extractJson", () => {
  it("reads the result and the model", () => {
    expect(parseEnvelope(envelope("hi", "m1"))).toEqual({
      text: "hi",
      model: "m1",
    });
  });
  it("refuses an error envelope and non-JSON", () => {
    expect(
      parseEnvelope(JSON.stringify({ is_error: true, result: "x" })),
    ).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
  });
  it("finds JSON in prose and fences", () => {
    expect(extractJson('Sure! ```json\n{"a": [1, "}"]}\n``` done')).toEqual({
      a: [1, "}"],
    });
    expect(extractJson("nothing here")).toBeUndefined();
  });
});

describe("runClaudePool with a fake executable", () => {
  it("returns the value with the model on exit 0", async () => {
    script(scripted(0, envelope('{"n": 3}', "claude-x")));
    const result = await runClaudePool("hello", {
      schema: z.object({ n: z.number() }),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { n: 3 },
      model: "claude-x",
    });
  });

  it("passes the prompt and flags as arguments and scrubs the environment", async () => {
    const args = join(work, "args");
    const envFile = join(work, "env");
    script(scripted(0, envelope("ok")));
    fake.set("args", args);
    fake.set("env", envFile);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-leak");
    vi.stubEnv("HUB_DATABASE_URL", "postgres://leak");
    vi.stubEnv("CLAUDE_POOL_ACCOUNT", "acct");
    const prompt = "line one\nline two $(whoami) `id` ; --add-dir /";
    await runClaudePool(prompt);
    const seen = readFileSync(args, "utf8");
    expect(seen).toContain("$(whoami)");
    expect(seen).toContain("--tools");
    expect(readFileSync(envFile, "utf8").trim()).toBe("key= db= pool=acct");
  });

  it("maps exit 75 to exhausted and other exits to error", async () => {
    script(scripted(75));
    expect(await runClaudePool("x")).toEqual({
      ok: false,
      reason: "exhausted",
    });
    script(scripted(1));
    expect(await runClaudePool("x")).toMatchObject({
      ok: false,
      reason: "error",
    });
  });

  it("is an error for non-JSON output and for a reply that fails the schema", async () => {
    script(scripted(0, "garbage"));
    expect(await runClaudePool("x")).toMatchObject({
      ok: false,
      reason: "error",
    });
    script(scripted(0, envelope("no json at all")));
    expect(
      await runClaudePool("x", { schema: z.object({ n: z.number() }) }),
    ).toMatchObject({ ok: false, reason: "error" });
  });

  it("times out and kills the call", async () => {
    fake.set("sleep", "5");
    script(scripted(0, envelope("late")));
    const started = Date.now();
    const result = await runClaudePool("x", { timeoutMs: 300 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("is an error when the executable is missing", async () => {
    const result = await runClaudePool("x", {
      command: "definitely-not-installed-xyz",
    });
    expect(result).toMatchObject({ ok: false, reason: "error" });
  });

  it("limits concurrency and answers busy when too many wait", async () => {
    fake.set("sleep", "1");
    script(scripted(0, envelope("ok")));
    const options = { maxConcurrent: 1, maxWaiting: 1, timeoutMs: 10_000 };
    const results = await Promise.all([
      runClaudePool("a", options),
      runClaudePool("b", options),
      runClaudePool("c", options),
    ]);
    const reasons = results.map((r) => (r.ok ? "ok" : r.reason));
    expect(reasons).toEqual(["ok", "ok", "busy"]);
  });
});

describe("pool status and the tools flag", () => {
  it("reads the soonest reset", () => {
    const status = [
      "1  a  90%  21%  Thu 00:00 (in 1h24m)  Sat 01:00 (in 50h24m)  past 90%",
      "2  b  93%  -    Thu 01:10 (in 2h34m)  -  past 90%",
    ].join("\n");
    expect(waitFromPoolStatus(status)).toBe((84 + 1) * 60_000);
    expect(waitFromPoolStatus("nothing")).toBe(15 * 60_000);
  });

  it("asks the pool, falling back to 15 minutes", async () => {
    fake.set("status", "1 a 99% - Thu (in 30m) - x");
    expect(await poolResetWaitMs()).toBe(31 * 60_000);
    expect(await poolResetWaitMs("definitely-not-installed-xyz")).toBe(
      15 * 60_000,
    );
  });

  it("detects the --tools flag in claude --help", async () => {
    expect(await claudeSupportsToolsFlag()).toBe(true);
    expect(await claudeSupportsToolsFlag("definitely-not-installed-xyz")).toBe(
      false,
    );
  });
});
