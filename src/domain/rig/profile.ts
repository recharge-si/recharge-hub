import { z } from "zod";

import { RIG_ROLES, type RigRole } from "~/domain/rig/keys";
import {
  BOARD_KINDS,
  SKILLS,
  type BoardKind,
  type Profile,
  type ProfileSource,
  type Skill,
} from "~/domain/rig/types";

/**
 * The buyer as the engine needs them (docs/rig-builder.md § Profile). Two
 * sources: the form answers, which are validated strictly at the proxy
 * boundary, and the model's reading of free text, which is treated as
 * untrusted: only values that pass the same ranges survive, an out-of-range
 * value becomes `null` with source `invalid` and is never clamped, and form
 * answers always win.
 */

export const LIMITS = {
  weightKg: { min: 30, max: 200 },
  heightCm: { min: 120, max: 230 },
  windKn: { min: 0, max: 60 },
  budgetEur: { min: 1, max: 100_000 },
  boomCm: { min: 50, max: 300 },
  text: 1000,
} as const;

const OWNABLE = RIG_ROLES.filter((role) => role !== "extension");

const num = (min: number, max: number) =>
  z.number().finite().min(min).max(max);

/** The `answers` of a request. Unknown keys are refused. */
export const answersSchema = z
  .object({
    discipline: z.literal("windsurf").optional(),
    weightKg: num(LIMITS.weightKg.min, LIMITS.weightKg.max).optional(),
    heightCm: num(LIMITS.heightCm.min, LIMITS.heightCm.max).optional(),
    skill: z.enum(SKILLS).optional(),
    windMinKn: num(LIMITS.windKn.min, LIMITS.windKn.max).optional(),
    windMaxKn: num(LIMITS.windKn.min, LIMITS.windKn.max).optional(),
    budgetEur: num(LIMITS.budgetEur.min, LIMITS.budgetEur.max).optional(),
    owns: z.array(z.enum(OWNABLE as [RigRole, ...RigRole[]])).max(6).optional(),
    boardKind: z.enum(BOARD_KINDS).optional(),
    ownedBoomMinCm: num(LIMITS.boomCm.min, LIMITS.boomCm.max).optional(),
    ownedBoomMaxCm: num(LIMITS.boomCm.min, LIMITS.boomCm.max).optional(),
  })
  .strict()
  .superRefine((answers, ctx) => {
    if (
      answers.windMinKn !== undefined &&
      answers.windMaxKn !== undefined &&
      answers.windMinKn > answers.windMaxKn
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["windMinKn"],
        message: "windMinKn must not be above windMaxKn",
      });
    }
    if (
      answers.ownedBoomMinCm !== undefined &&
      answers.ownedBoomMaxCm !== undefined &&
      answers.ownedBoomMinCm > answers.ownedBoomMaxCm
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ownedBoomMinCm"],
        message: "ownedBoomMinCm must not be above ownedBoomMaxCm",
      });
    }
  });
export type Answers = z.infer<typeof answersSchema>;

/* -------------------------------------------------------------------------- */
/* The model's reading                                                        */
/* -------------------------------------------------------------------------- */

/** Knots at the bottom and top of each Beaufort force (0 to 12). */
const BEAUFORT_KN: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 3],
  [4, 6],
  [7, 10],
  [11, 16],
  [17, 21],
  [22, 27],
  [28, 33],
  [34, 40],
  [41, 47],
  [48, 55],
  [56, 63],
  [64, 100],
];

const KG_PER_LB = 0.45359237;
const CM_PER_INCH = 2.54;

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A number, or a string that is only a number. Anything else is not a number. */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+([.,]\d+)?\s*$/.test(value)) {
    return Number(value.trim().replace(",", "."));
  }
  return null;
}

export interface ParsedModelProfile {
  discipline?: "windsurf";
  weightKg?: number;
  heightCm?: number;
  skill?: Skill;
  windMinKn?: number;
  windMaxKn?: number;
  budgetEur?: number;
  owns?: RigRole[];
  boardKind?: BoardKind;
  /** Fields the model gave a value for that failed validation. */
  invalid: string[];
  warnings: string[];
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Reads what a model said into a profile. Accepts an object only (the caller
 * has already found the JSON in the reply); everything is checked again here.
 */
export function parseProfile(output: unknown): ParsedModelProfile {
  const result: ParsedModelProfile = { invalid: [], warnings: [] };
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return result;
  }
  const raw = output as Record<string, unknown>;

  const ranged = (
    field: string,
    value: unknown,
    min: number,
    max: number,
  ): number | undefined => {
    if (!present(value)) return undefined;
    const parsed = numeric(value);
    if (parsed === null || parsed < min || parsed > max) {
      result.invalid.push(field);
      return undefined;
    }
    return parsed;
  };

  if (present(raw["discipline"])) {
    const discipline =
      typeof raw["discipline"] === "string"
        ? raw["discipline"].trim().toLowerCase()
        : "";
    if (discipline === "windsurf" || discipline === "windsurfing") {
      result.discipline = "windsurf";
    } else {
      result.invalid.push("discipline");
      result.warnings.push("unsupported_discipline");
    }
  }

  let weight = ranged("weightKg", raw["weightKg"], LIMITS.weightKg.min, LIMITS.weightKg.max);
  if (weight === undefined && !result.invalid.includes("weightKg")) {
    const pounds = numeric(raw["weightLb"]);
    if (pounds !== null) {
      const kg = oneDecimal(pounds * KG_PER_LB);
      if (kg >= LIMITS.weightKg.min && kg <= LIMITS.weightKg.max) weight = kg;
      else result.invalid.push("weightKg");
    }
  }
  if (weight !== undefined) result.weightKg = weight;

  let height = ranged("heightCm", raw["heightCm"], LIMITS.heightCm.min, LIMITS.heightCm.max);
  if (height === undefined && !result.invalid.includes("heightCm")) {
    const inches = numeric(raw["heightIn"]);
    if (inches !== null) {
      const cm = oneDecimal(inches * CM_PER_INCH);
      if (cm >= LIMITS.heightCm.min && cm <= LIMITS.heightCm.max) height = cm;
      else result.invalid.push("heightCm");
    }
  }
  if (height !== undefined) result.heightCm = height;

  if (present(raw["skill"])) {
    const skill =
      typeof raw["skill"] === "string" ? raw["skill"].trim().toLowerCase() : "";
    const found = SKILLS.find((candidate) => candidate === skill);
    if (found) result.skill = found;
    else result.invalid.push("skill");
  }

  let windMin = ranged("windMinKn", raw["windMinKn"], LIMITS.windKn.min, LIMITS.windKn.max);
  let windMax = ranged("windMaxKn", raw["windMaxKn"], LIMITS.windKn.min, LIMITS.windKn.max);
  const forceLow = numeric(raw["windBeaufortMin"]);
  const forceHigh = numeric(raw["windBeaufortMax"] ?? raw["windBeaufortMin"]);
  if (
    windMin === undefined &&
    windMax === undefined &&
    !result.invalid.includes("windMinKn") &&
    !result.invalid.includes("windMaxKn") &&
    forceLow !== null &&
    forceHigh !== null
  ) {
    const low = BEAUFORT_KN[Math.round(forceLow)];
    const high = BEAUFORT_KN[Math.round(forceHigh)];
    if (low && high && forceLow >= 0 && forceHigh <= 12) {
      const kn = { min: low[0], max: high[1] };
      if (kn.max <= LIMITS.windKn.max && kn.min <= kn.max) {
        windMin = kn.min;
        windMax = kn.max;
      } else {
        result.invalid.push("windMinKn", "windMaxKn");
      }
    } else {
      result.invalid.push("windMinKn", "windMaxKn");
    }
  }
  if (windMin !== undefined && windMax !== undefined && windMin > windMax) {
    result.invalid.push("windMinKn", "windMaxKn");
    windMin = undefined;
    windMax = undefined;
  }
  if (windMin !== undefined) result.windMinKn = windMin;
  if (windMax !== undefined) result.windMaxKn = windMax;

  const budget = ranged("budgetEur", raw["budgetEur"], LIMITS.budgetEur.min, LIMITS.budgetEur.max);
  if (budget !== undefined) result.budgetEur = budget;

  if (Array.isArray(raw["owns"])) {
    const owns = new Set<RigRole>();
    for (const entry of raw["owns"]) {
      const role = OWNABLE.find(
        (candidate) =>
          typeof entry === "string" && candidate === entry.trim().toLowerCase(),
      );
      if (role) owns.add(role);
    }
    result.owns = [...owns].sort();
  }

  if (present(raw["boardKind"])) {
    const kind =
      typeof raw["boardKind"] === "string"
        ? raw["boardKind"].trim().toLowerCase()
        : "";
    const found = BOARD_KINDS.find((candidate) => candidate === kind);
    if (found) result.boardKind = found;
    else result.invalid.push("boardKind");
  }

  const years = numeric(raw["experienceYears"]);
  if (result.skill === "beginner" && years !== null && years >= 5) {
    result.warnings.push("skill_contradiction");
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The profile the engine runs on: explicit form answers first, then what the
 * text said, and `source` records which. The discipline is windsurf unless
 * somebody said otherwise (v1 sells one).
 */
export function mergeProfile(
  answers: Answers | undefined,
  text: ParsedModelProfile | undefined,
): Profile {
  const source: Partial<Record<string, ProfileSource>> = {};
  const pick = <K extends keyof Answers & keyof ParsedModelProfile>(
    field: K,
  ): NonNullable<Answers[K]> | null => {
    const fromForm = answers?.[field];
    if (fromForm !== undefined) {
      source[field] = "form";
      return fromForm;
    }
    const fromText = text?.[field] as NonNullable<Answers[K]> | undefined;
    if (fromText !== undefined) {
      source[field] = "text";
      return fromText;
    }
    if (text?.invalid.includes(field)) source[field] = "invalid";
    return null;
  };

  let discipline = pick("discipline");
  if (discipline === null && source["discipline"] !== "invalid") {
    discipline = "windsurf";
    source["discipline"] = "default";
  }
  const windFromForm =
    answers?.windMinKn !== undefined || answers?.windMaxKn !== undefined;
  let windMinKn: number | null;
  let windMaxKn: number | null;
  if (windFromForm) {
    windMinKn = answers?.windMinKn ?? null;
    windMaxKn = answers?.windMaxKn ?? null;
    if (windMinKn !== null) source["windMinKn"] = "form";
    if (windMaxKn !== null) source["windMaxKn"] = "form";
  } else {
    windMinKn = pick("windMinKn");
    windMaxKn = pick("windMaxKn");
  }
  const ownsFromForm = answers?.owns;
  let owns: RigRole[] = [];
  if (ownsFromForm !== undefined) {
    owns = [...new Set(ownsFromForm)].sort();
    source["owns"] = "form";
  } else if (text?.owns !== undefined) {
    owns = text.owns;
    source["owns"] = "text";
  }

  return {
    discipline,
    weightKg: pick("weightKg"),
    heightCm: pick("heightCm"),
    skill: pick("skill"),
    windMinKn,
    windMaxKn,
    budgetEur: pick("budgetEur"),
    owns,
    boardKind: pick("boardKind"),
    ownedBoomMinCm: answers?.ownedBoomMinCm ?? null,
    ownedBoomMaxCm: answers?.ownedBoomMaxCm ?? null,
    source,
  };
}

/** A profile holds enough to build a rig. */
export function profileNeeds(profile: Profile): string[] {
  const needs: string[] = [];
  if (profile.discipline === null) needs.push("discipline");
  if (profile.weightKg === null) needs.push("weightKg");
  return needs;
}
