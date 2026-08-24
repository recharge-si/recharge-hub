import { describe, expect, it } from "vitest";

import {
  formatMkDottedDate,
  mkBoolean,
  mkDecimal,
  mkMinorUnits,
  parseMkDate,
  toMinorUnits,
} from "~/adapters/metakocka/values";

describe("MetaKocka booleans", () => {
  it("reads the strings MetaKocka actually sends", () => {
    expect(mkBoolean.parse("true")).toBe(true);
    expect(mkBoolean.parse("false")).toBe(false);
  });

  it("passes through a real boolean", () => {
    expect(mkBoolean.parse(true)).toBe(true);
  });
});

describe("MetaKocka decimals", () => {
  it("parses a plain decimal string", () => {
    expect(mkDecimal.parse("12.5")).toBe(12.5);
  });

  it("parses the decimal comma from the documented examples", () => {
    // CLAUDE.md section 3 cites `"gross_weight": "0,8"`.
    expect(mkDecimal.parse("0,8")).toBe(0.8);
  });

  it("parses a dot-grouped, comma-decimal number", () => {
    expect(mkDecimal.parse("1.234,56")).toBeCloseTo(1234.56, 10);
  });

  it("rejects a value that is not a number", () => {
    expect(() => mkDecimal.parse("not a number")).toThrow();
  });
});

describe("money as integer minor units", () => {
  it("converts without going through a float", () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754. This must not be 1998.
    expect(toMinorUnits("19.99")).toBe(1999);
  });

  it("handles the classic float offenders exactly", () => {
    expect(toMinorUnits("0.07")).toBe(7);
    expect(toMinorUnits("1.15")).toBe(115);
    expect(toMinorUnits("8.29")).toBe(829);
    expect(toMinorUnits("1234.56")).toBe(123456);
  });

  it("accepts the decimal comma", () => {
    expect(toMinorUnits("19,99")).toBe(1999);
  });

  it("pads a missing or short fraction", () => {
    expect(toMinorUnits("5")).toBe(500);
    expect(toMinorUnits("5.1")).toBe(510);
  });

  it("rounds half up on the first dropped digit", () => {
    expect(toMinorUnits("1.005")).toBe(101);
    expect(toMinorUnits("1.004")).toBe(100);
  });

  it("handles negatives, which refunds will need", () => {
    expect(toMinorUnits("-19.99")).toBe(-1999);
  });

  it("parses through the Zod schema too", () => {
    expect(mkMinorUnits.parse("19,99")).toBe(1999);
    expect(() => mkMinorUnits.parse("abc")).toThrow();
  });

  it("refuses an amount beyond safe integer range rather than losing precision", () => {
    expect(() => toMinorUnits("999999999999999999")).toThrow(RangeError);
  });
});

describe("MetaKocka dates", () => {
  it("parses ISO with an offset and no time", () => {
    // CLAUDE.md section 3: `"2024-09-12+02:00"`. `new Date()` does not handle
    // this shape on its own.
    const parsed = parseMkDate("2024-09-12+02:00");
    expect(parsed.toISOString()).toBe("2024-09-11T22:00:00.000Z");
  });

  it("parses a plain ISO date", () => {
    expect(parseMkDate("2024-09-12").toISOString()).toBe(
      "2024-09-12T00:00:00.000Z",
    );
  });

  it("parses the dd.mm.yyyy form used by mark_paid", () => {
    expect(parseMkDate("12.09.2024").toISOString()).toBe(
      "2024-09-12T00:00:00.000Z",
    );
  });

  it("does not read dd.mm.yyyy as mm.dd.yyyy", () => {
    // 25 is not a month, so a US-order reading would throw or shift the year.
    expect(parseMkDate("25.12.2024").toISOString()).toBe(
      "2024-12-25T00:00:00.000Z",
    );
  });

  it("rejects something that is not a date", () => {
    expect(() => parseMkDate("nope")).toThrow(RangeError);
  });

  it("formats outbound mark_paid dates as dd.mm.yyyy", () => {
    expect(formatMkDottedDate(new Date("2024-09-05T00:00:00Z"))).toBe(
      "05.09.2024",
    );
  });
});
