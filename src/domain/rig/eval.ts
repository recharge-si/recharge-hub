import { buildRig } from "~/domain/rig/engine";
import { mergeProfile, answersSchema } from "~/domain/rig/profile";
import type { RigRole } from "~/domain/rig/keys";
import type { RigCandidate, RigRules } from "~/domain/rig/types";

/**
 * The launch evaluation (docs/rig-builder.md § Quality gate, PRD 4 US-411):
 * rows written by Recharge staff, each a buyer with the sail and board range
 * an expert expects, run through the engine. Pure; `scripts/rig-eval.ts` reads
 * the CSV and the snapshot. The AI is not involved: the eval runs on the
 * structured answers, which is what the AI would have read from the text.
 */

export const CSV_COLUMNS = [
  "text",
  "weightKg",
  "skill",
  "windMinKn",
  "windMaxKn",
  "boardKind",
  "budgetEur",
  "owns",
  "expectedSailMinM2",
  "expectedSailMaxM2",
  "expectedBoardMinL",
  "expectedBoardMaxL",
  "notes",
] as const;

/** RFC 4180 enough for a spreadsheet export: quotes, doubled quotes, newlines in quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

export interface EvalCase {
  line: number;
  text: string;
  answers: Record<string, unknown>;
  expectedSail: { min: number; max: number } | null;
  expectedBoard: { min: number; max: number } | null;
  notes: string;
}

function optionalNumber(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (text === "") return null;
  const parsed = Number(text.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function parseEvalCases(text: string): {
  cases: EvalCase[];
  errors: string[];
} {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((name) => name.trim());
  const errors: string[] = [];
  for (const column of CSV_COLUMNS) {
    if (!header.includes(column)) errors.push(`Missing column ${column}.`);
  }
  if (errors.length > 0) return { cases: [], errors };

  const at = (row: string[], name: string) => row[header.indexOf(name)];
  const cases: EvalCase[] = [];
  table.slice(1).forEach((row, index) => {
    const line = index + 2;
    const answers: Record<string, unknown> = { discipline: "windsurf" };
    for (const name of ["weightKg", "windMinKn", "windMaxKn", "budgetEur"]) {
      const value = optionalNumber(at(row, name));
      if (value !== null) answers[name] = value;
    }
    for (const name of ["skill", "boardKind"]) {
      const value = (at(row, name) ?? "").trim();
      if (value !== "") answers[name] = value;
    }
    const owns = (at(row, "owns") ?? "")
      .split(/[;|]/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (owns.length > 0) answers["owns"] = owns;

    const parsed = answersSchema.safeParse(answers);
    if (!parsed.success) {
      errors.push(
        `Line ${line}: ${parsed.error.issues[0]?.path.join(".") ?? "row"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
      return;
    }
    const range = (lo: string, hi: string) => {
      const min = optionalNumber(at(row, lo));
      const max = optionalNumber(at(row, hi));
      if (min === null && max === null) return null;
      if (min === null || max === null || Number.isNaN(min) || Number.isNaN(max)) {
        errors.push(`Line ${line}: ${lo} and ${hi} must both be numbers.`);
        return null;
      }
      return { min, max };
    };
    cases.push({
      line,
      text: (at(row, "text") ?? "").trim(),
      answers,
      expectedSail: range("expectedSailMinM2", "expectedSailMaxM2"),
      expectedBoard: range("expectedBoardMinL", "expectedBoardMaxL"),
      notes: (at(row, "notes") ?? "").trim(),
    });
  });
  return { cases, errors };
}

export interface RuleOutcome {
  rule: string;
  ok: boolean;
  detail: string;
}

export interface EvalOutcome {
  line: number;
  pass: boolean;
  rules: RuleOutcome[];
}

export function evaluateCase(
  evalCase: EvalCase,
  candidates: readonly RigCandidate[],
  rules: RigRules,
  shopId: string,
): EvalOutcome {
  const parsed = answersSchema.parse(evalCase.answers);
  const result = buildRig(mergeProfile(parsed, undefined), candidates, rules, {
    shopId,
  });
  const rig = result.rigs[0];
  const outcomes: RuleOutcome[] = [];
  const partOf = (role: RigRole) => rig?.items.find((item) => item.role === role);

  outcomes.push({
    rule: "rig-built",
    ok: rig !== undefined && result.unmet.every((u) => u.role === "budget"),
    detail: rig
      ? result.unmet.map((u) => `${u.role}:${u.reason}`).join(", ") || "complete"
      : `none (${[...result.needs, ...result.unmet.map((u) => `${u.role}:${u.reason}`)].join(", ")})`,
  });
  outcomes.push({
    rule: "checks",
    ok: rig !== undefined && rig.checks.every((check) => check.ok),
    detail: rig
      ? rig.checks.filter((c) => !c.ok).map((c) => c.id).join(", ") || "all pass"
      : "no rig",
  });
  const within = (
    label: string,
    value: unknown,
    range: { min: number; max: number } | null,
  ) => {
    if (!range) return;
    const number = typeof value === "number" ? value : Number.NaN;
    outcomes.push({
      rule: label,
      ok: number >= range.min && number <= range.max,
      detail: `${Number.isNaN(number) ? "none" : number} vs ${range.min}-${range.max}`,
    });
  };
  within("sail-range", partOf("sail")?.specs.areaM2, evalCase.expectedSail);
  within("board-range", partOf("board")?.specs.volumeL, evalCase.expectedBoard);

  return {
    line: evalCase.line,
    pass: outcomes.every((outcome) => outcome.ok),
    rules: outcomes,
  };
}
