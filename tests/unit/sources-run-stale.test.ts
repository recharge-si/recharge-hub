import { describe, expect, it } from "vitest";

import {
  RUN_STALE_MS,
  describeRun,
  isRunActive,
  isRunStale,
  runStatusLabel,
  sourceStatus,
} from "~/web/lib/sources";

/**
 * docs/sources.md § Failures: a run the portal still calls running, but
 * that died with the portal process, is not waited on for ever. The page
 * stops polling, says it stopped responding, and offers Run now again.
 */

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const run = (
  status: "queued" | "running" | "completed",
  startedAt: string | null,
) => ({
  id: "r1",
  sourceId: "sc_1",
  status,
  startedAt,
  queuedAt: startedAt,
  finishedAt: null,
});

describe("a run that stopped responding", () => {
  it("is active while young, stale once older than the limit", () => {
    expect(isRunActive(run("running", ago(60_000)), NOW)).toBe(true);
    expect(isRunStale(run("running", ago(60_000)), NOW)).toBe(false);
    expect(isRunActive(run("running", ago(RUN_STALE_MS + 1)), NOW)).toBe(false);
    expect(isRunStale(run("queued", ago(RUN_STALE_MS + 1)), NOW)).toBe(true);
  });

  it("is never stale when it finished, or when the portal gave no time", () => {
    expect(isRunStale(run("completed", ago(RUN_STALE_MS * 3)), NOW)).toBe(
      false,
    );
    expect(isRunStale(run("running", null), NOW)).toBe(false);
    expect(isRunActive(run("running", null), NOW)).toBe(true);
  });

  it("says so wherever a run's state is shown", () => {
    const dead = run("running", "2020-01-01T00:00:00Z");
    expect(runStatusLabel(dead)).toBe("Stopped responding");
    expect(describeRun(dead as never)).toMatch(/^Stopped responding/);
    expect(
      sourceStatus({ enabled: true, health: "ok", lastRun: dead as never }),
    ).toEqual({ label: "Stopped responding", tone: "warning" });
  });
});
