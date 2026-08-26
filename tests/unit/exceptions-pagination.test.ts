import { describe, expect, it } from "vitest";

import {
  EXCEPTIONS_PAGE_SIZE,
  parseExceptionsLimit,
} from "~/web/lib/exceptions";

describe("parseExceptionsLimit", () => {
  it("falls back to the page size when there is no limit", () => {
    expect(parseExceptionsLimit(null)).toBe(EXCEPTIONS_PAGE_SIZE);
  });

  it("falls back on anything that is not a positive integer", () => {
    for (const raw of ["", "abc", "0", "-5", "3.5", "NaN"]) {
      expect(parseExceptionsLimit(raw)).toBe(EXCEPTIONS_PAGE_SIZE);
    }
  });

  it("accepts a valid limit as-is", () => {
    expect(parseExceptionsLimit("25")).toBe(25);
  });

  it("caps an absurd limit rather than loading everything", () => {
    expect(parseExceptionsLimit("999999")).toBeLessThan(999999);
  });
});
