import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateCase,
  parseCsv,
  parseEvalCases,
} from "~/domain/rig/eval";
import { FIXTURES, SHOP_A, candidates, rules } from "../support/rig-fixtures";

const sample = readFileSync(join(FIXTURES, "eval-sample.csv"), "utf8");

describe("parseCsv", () => {
  it("handles quotes, doubled quotes and newlines inside quotes", () => {
    expect(parseCsv('a,"b ""q"" c","x\ny"\n1,2,3\n')).toEqual([
      ["a", 'b "q" c', "x\ny"],
      ["1", "2", "3"],
    ]);
  });
});

describe("rig eval", () => {
  const { cases, errors } = parseEvalCases(sample);

  it("reads the sample rows, which are marked as placeholders", () => {
    expect(errors).toEqual([]);
    expect(cases).toHaveLength(3);
    expect(cases.every((c) => c.text.startsWith("PLACEHOLDER"))).toBe(true);
  });

  it("passes the sample rows against the fixture catalogue", () => {
    for (const evalCase of cases) {
      const outcome = evaluateCase(evalCase, candidates(), rules, SHOP_A);
      expect(outcome.rules.filter((r) => !r.ok)).toEqual([]);
      expect(outcome.pass).toBe(true);
    }
  });

  it("fails a row whose expected range the rig misses, naming the rule", () => {
    const wrong = { ...cases[0]!, expectedSail: { min: 7, max: 8 } };
    const outcome = evaluateCase(wrong, candidates(), rules, SHOP_A);
    expect(outcome.pass).toBe(false);
    expect(outcome.rules.find((r) => !r.ok)?.rule).toBe("sail-range");
  });

  it("reports a missing column and a bad row instead of guessing", () => {
    expect(parseEvalCases("text\nfoo\n").errors[0]).toMatch(/Missing column/);
    const bad = sample.replace(",82,intermediate", ",8200,intermediate");
    expect(parseEvalCases(bad).errors[0]).toMatch(/Line 2/);
  });
});
