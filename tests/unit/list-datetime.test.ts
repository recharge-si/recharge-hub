import { describe, expect, it } from "vitest";

import { formatListDateTime } from "~/web/lib/datetime";

/**
 * The short form used down the date column of the orders list.
 *
 * The boundaries are the whole point of it — "Today" has to mean the calendar
 * day the reader is having, not the last 24 hours — so they are asserted
 * against an injected clock rather than the machine's.
 */
describe("formatListDateTime", () => {
  const now = new Date(2026, 7, 25, 14, 0); // 25 August 2026, local time.

  it("calls anything on today's date Today, including one minute past midnight", () => {
    expect(formatListDateTime(new Date(2026, 7, 25, 13, 0).toISOString(), now))
      .toMatch(/^Today at /);
    expect(formatListDateTime(new Date(2026, 7, 25, 0, 1).toISOString(), now))
      .toMatch(/^Today at /);
  });

  it("calls yesterday Yesterday however few hours ago it was", () => {
    // 23:59 yesterday is under an hour before midnight and still not today.
    expect(formatListDateTime(new Date(2026, 7, 24, 23, 59).toISOString(), now))
      .toMatch(/^Yesterday at /);
    expect(formatListDateTime(new Date(2026, 7, 24, 0, 5).toISOString(), now))
      .toMatch(/^Yesterday at /);
  });

  it("drops the year for a date in the current year and keeps it otherwise", () => {
    const thisYear = formatListDateTime(
      new Date(2026, 0, 15, 9, 30).toISOString(),
      now,
    );
    expect(thisYear).not.toMatch(/^Today|^Yesterday/);
    expect(thisYear).not.toContain("2026");

    expect(
      formatListDateTime(new Date(2025, 0, 15, 9, 30).toISOString(), now),
    ).toContain("2025");
  });

  /**
   * The reason the day difference is rounded rather than floored. Ljubljana
   * moves its clocks on 25 October 2026, so the day before it is 25 hours long
   * and the day after it is 23; flooring a fractional day turns "yesterday"
   * into "today" on exactly those two mornings.
   */
  it("survives a day that is not 24 hours long", () => {
    const afterTheChange = new Date(2026, 9, 26, 10, 0);
    expect(
      formatListDateTime(
        new Date(2026, 9, 25, 10, 0).toISOString(),
        afterTheChange,
      ),
    ).toMatch(/^Yesterday at /);
  });
});
