import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ProcessHeader,
  describeProcess,
  type ProcessHealth,
  type ProcessMode,
} from "~/web/components/process-header";
import { formatRelativeTime } from "~/web/lib/datetime";

const now = new Date(2026, 9, 28, 14, 10, 0);
const ago = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000).toISOString();
const ahead = (minutes: number) =>
  new Date(now.getTime() + minutes * 60_000).toISOString();

describe("formatRelativeTime", () => {
  it("states minutes, hours and calendar days, never an ISO string", () => {
    expect(formatRelativeTime(ago(0), now)).toBe("just now");
    expect(formatRelativeTime(ago(2), now)).toBe("2 min ago");
    expect(formatRelativeTime(ago(180), now)).toBe("3 h ago");
    expect(formatRelativeTime(ahead(12), now)).toBe("in 12 min");
    expect(formatRelativeTime(ahead(200), now)).toBe("in 3 h");
    const yesterday = new Date(2026, 9, 27, 14, 5).toISOString();
    expect(formatRelativeTime(yesterday, now)).toMatch(
      /^yesterday \d\d[:.]\d\d$/,
    );
    const tomorrow = new Date(2026, 9, 29, 6, 0).toISOString();
    expect(formatRelativeTime(tomorrow, now)).toMatch(
      /^tomorrow \d\d[:.]\d\d$/,
    );
    for (const iso of [ago(1), ago(5000), ahead(5000)])
      expect(formatRelativeTime(iso, now)).not.toMatch(/T\d\d:\d\d/);
  });
});

const HEALTHS: ProcessHealth[] = ["ok", "needs_attention", "never_run", "off"];
const MODES: ProcessMode[] = ["automatic", "manual"];

describe("ProcessHeader", () => {
  for (const health of HEALTHS)
    for (const mode of MODES)
      for (const withRun of [true, false])
        for (const withNext of [true, false])
          it(`${health} / ${mode} / lastRun ${withRun} / next ${withNext}`, () => {
            const props = {
              health,
              mode,
              lastRun: withRun ? { at: ago(2), outcome: "completed" } : null,
              nextRunAt: withNext ? ahead(180) : null,
              attention: { href: "/app/sources/1", label: "Open the source" },
              now,
            };
            const text = describeProcess(props, now);
            expect(text).toMatch(/^(Healthy|Needs attention|Never run|Off) · .*/);
            expect(text.includes("next in 3 h")).toBe(
              mode === "automatic" && health !== "off" && withNext,
            );
            if (mode === "manual") expect(text).not.toContain("next");
            if (withRun) expect(text).toContain("ran 2 min ago, completed");

            const html = renderToStaticMarkup(
              createElement(ProcessHeader, props),
            );
            expect(html).not.toContain('tone="success"');
            expect(html).not.toContain("s-badge");
            if (health === "needs_attention") {
              expect(html).toContain('tone="critical"');
              expect(html).toContain('href="/app/sources/1"');
            } else {
              expect(html).not.toContain("s-banner");
              expect(html).not.toContain("<s-link");
            }
          });

  it("shows a run in progress", () => {
    expect(
      describeProcess({ health: "ok", mode: "automatic", running: true }, now),
    ).toContain("running now");
  });

  it("treats an unknown health as needs attention and logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = { health: "bogus" as ProcessHealth, mode: "manual" as const };
    expect(describeProcess(props, now)).toMatch(/^Needs attention · /);
    describeProcess(props, now);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
