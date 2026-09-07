import { describe, expect, it } from "vitest";

import { formatInterval } from "~/web/lib/datetime";

/**
 * The schedule is stored in minutes, and the pages that state it say "every
 * ${this}". Whole days and whole hours have to come out as days and hours,
 * because nobody reads "every 720 minutes".
 */
describe("formatInterval", () => {
  it("says whole hours as hours", () => {
    expect(formatInterval(720)).toBe("12 hours");
    expect(formatInterval(60)).toBe("hour");
  });

  it("says whole days as days", () => {
    expect(formatInterval(1440)).toBe("day");
    expect(formatInterval(10080)).toBe("7 days");
  });

  it("says under an hour in minutes", () => {
    expect(formatInterval(15)).toBe("15 minutes");
    expect(formatInterval(1)).toBe("minute");
  });

  it("keeps the remainder rather than rounding the merchant's answer away", () => {
    expect(formatInterval(90)).toBe("1 hour 30 minutes");
    expect(formatInterval(61)).toBe("1 hour 1 minute");
  });
});
