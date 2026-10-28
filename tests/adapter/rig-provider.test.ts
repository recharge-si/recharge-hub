import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ClaudePoolProvider } from "~/adapters/ai/rig-provider.server";
import { mergeProfile, parseProfile } from "~/domain/rig/profile";
import { buildProfilePrompt, profileReplySchema } from "~/domain/rig/words";
import {
  envelope,
  installFakeClaude,
  scripted,
} from "../support/fake-claude-pool";
import { FIXTURES } from "../support/rig-fixtures";

const fake = installFakeClaude();
const work = mkdtempSync(join(tmpdir(), "rig-provider-test-"));

beforeAll(() => {
  vi.stubEnv("PATH", fake.pathWith());
});
afterEach(() => {
  fake.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("PATH", fake.pathWith());
});

function script(...lines: string[]): void {
  const file = join(work, `script-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, lines.join("\n") + "\n");
  fake.set("script", file);
}

function provider(maxConcurrent = 3) {
  return new ClaudePoolProvider({ model: "sonnet", maxConcurrent });
}

const ANY = z.record(z.string(), z.unknown());

describe("ClaudePoolProvider", () => {
  it("is ready when the installed claude documents --tools", async () => {
    expect(await provider().ready()).toBe(true);
  });

  it("returns the parsed reply with the model and a latency", async () => {
    script(scripted(0, envelope('{"a":1}')));
    const result = await provider().complete("hi", ANY, { timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: true, value: { a: 1 }, model: "claude-sonnet-fake" });
  });

  it("spawns with an argument array, tools off and no extra directories", async () => {
    const argsFile = join(work, "args.txt");
    writeFileSync(argsFile, "");
    fake.set("args", argsFile);
    script(scripted(0, envelope("{}")));
    const prompt = buildProfilePrompt("82 kg, mail me at buyer@example.com");
    await provider().complete(prompt, ANY, { timeoutMs: 5000 });
    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args).toContain("--tools");
    expect(args).not.toContain("--add-dir");
    expect(args).toContain("sonnet");
    const sent = args.join("\n");
    expect(sent).not.toContain("buyer@example.com");
    // No address, cookie or customer id ever enters a prompt.
    expect(sent).not.toMatch(/203\.0\.113\.|cookie|customer_id/i);
  });

  it("does not hand the hub's secrets to the child", async () => {
    const envFile = join(work, "env.txt");
    writeFileSync(envFile, "");
    fake.set("env", envFile);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    vi.stubEnv("HUB_DATABASE_URL", "postgres://secret");
    script(scripted(0, envelope("{}")));
    await provider().complete("hi", ANY, { timeoutMs: 5000 });
    expect(readFileSync(envFile, "utf8").trim()).toBe("key= db= pool=");
  });

  it("maps exit 75 to exhausted and any other failure to error", async () => {
    script(scripted(75));
    expect(await provider().complete("hi", ANY, { timeoutMs: 5000 })).toMatchObject({
      ok: false,
      reason: "exhausted",
    });
    script(scripted(1));
    expect(await provider().complete("hi", ANY, { timeoutMs: 5000 })).toMatchObject({
      ok: false,
      reason: "error",
    });
  });

  it("kills a slow call at the timeout", async () => {
    fake.set("sleep", "5");
    script(scripted(0, envelope("{}")));
    const started = Date.now();
    const result = await provider().complete("hi", ANY, { timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("answers busy at once when every slot is taken, without spawning", async () => {
    const argsFile = join(work, "args-busy.txt");
    writeFileSync(argsFile, "");
    fake.set("args", argsFile);
    fake.set("sleep", "1");
    script(scripted(0, envelope("{}")));
    const one = provider(1);
    const first = one.complete("first", ANY, { timeoutMs: 5000 });
    // Let the first call take the slot.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await one.complete("second", ANY, { timeoutMs: 5000 });
    expect(second).toMatchObject({ ok: false, reason: "busy" });
    await first;
    expect(readFileSync(argsFile, "utf8")).not.toContain("second");
  });
});

describe("profile replies (12 recorded)", () => {
  const dir = join(FIXTURES, "profile-replies");
  const expected = JSON.parse(
    readFileSync(join(dir, "expected.json"), "utf8"),
  ) as Record<string, Record<string, unknown> | null>;

  for (const [name, want] of Object.entries(expected)) {
    it(name, async () => {
      const text = readFileSync(join(dir, `${name}.txt`), "utf8");
      script(scripted(0, envelope(text)));
      const result = await provider().complete("p", profileReplySchema, {
        timeoutMs: 5000,
      });
      if (want === null) {
        // Nothing readable: the service answers with the form only.
        expect(result.ok).toBe(false);
        return;
      }
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const parsed = parseProfile(result.value);
      expect(parsed).toEqual(want);
      // Whatever the model said, an explicit answer wins.
      const merged = mergeProfile({ weightKg: 99 }, parsed);
      expect(merged.weightKg).toBe(99);
      expect(merged.source["weightKg"]).toBe("form");
    });
  }
});
