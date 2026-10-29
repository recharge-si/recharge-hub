import type {
  Band,
  BoardRule,
  FinRule,
  RigRules,
  SailRule,
} from "~/domain/rig/types";

/**
 * PLACEHOLDER RULES TABLE (R1). NOT ADVICE.
 *
 * These numbers exist so the engine, the tests and the page can be built and
 * exercised before a Recharge windsurf expert has written the real table
 * (docs/rig-builder.md § Rules table, PRD 4 open question 2). The only values
 * the PRD fixes are the two the tests pin: a 82 kg freeride rider in 15-25
 * knots gets a sail of 5.3-6.2 m2, and an intermediate freeride rider of 82 kg
 * gets a board of 95-115 L. Every other number was made up to give the table
 * a plausible shape. Do not enable the builder for customers on this table:
 * replace it, have the expert review ten full rigs, and record name and date
 * in docs/rig-builder.md (the launch criterion, PRD 4 US-411).
 */

/** Rider weight bands, kg: lower bound inclusive, upper exclusive. */
const WEIGHT_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0, 60],
  [60, 75],
  [75, 90],
  [90, 105],
  [105, 300],
];

/** Wind bands by the middle of the buyer's range, knots: lower inclusive, upper exclusive. */
const WIND_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0, 15],
  [15, 25],
  [25, 61],
];

type AreaTable = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

/** Sail area in m2, [weight band][wind band] = [min, max]. */
const SAIL_AREA: Readonly<Record<string, AreaTable>> = {
  freeride: [
    [[4.5, 5.5], [3.8, 4.6], [3.2, 3.8]],
    [[5.5, 6.5], [4.6, 5.5], [3.8, 4.6]],
    [[6.5, 7.5], [5.3, 6.2], [4.2, 5.2]],
    [[7.2, 8.2], [6.0, 7.0], [4.8, 5.8]],
    [[7.8, 8.8], [6.6, 7.6], [5.4, 6.4]],
  ],
  wave: [
    [[3.8, 4.6], [3.2, 4.0], [2.6, 3.2]],
    [[4.6, 5.4], [3.8, 4.6], [3.2, 3.8]],
    [[5.2, 6.0], [4.4, 5.3], [3.6, 4.4]],
    [[5.8, 6.6], [5.0, 5.9], [4.2, 5.0]],
    [[6.4, 7.2], [5.6, 6.5], [4.8, 5.6]],
  ],
};

type VolumeTable = Readonly<
  Record<string, ReadonlyArray<readonly [number, number]>>
>;

/** Board volume in L, [skill][weight band] = [min, max]. */
const BOARD_VOLUME: Readonly<Record<string, VolumeTable>> = {
  freeride: {
    beginner: [[95, 120], [110, 135], [125, 150], [140, 165], [155, 185]],
    intermediate: [[70, 90], [80, 100], [95, 115], [110, 130], [125, 145]],
    advanced: [[60, 80], [70, 90], [85, 105], [100, 120], [115, 135]],
  },
  wave: {
    beginner: [[90, 110], [100, 120], [110, 130], [125, 145], [140, 160]],
    intermediate: [[65, 80], [75, 90], [85, 100], [100, 115], [115, 130]],
    advanced: [[55, 70], [65, 80], [75, 90], [90, 105], [105, 120]],
  },
};

const FIN_LENGTH: readonly FinRule[] = [
  { maxVolumeL: 80, lengthCm: { min: 24, max: 30 } },
  { maxVolumeL: 100, lengthCm: { min: 30, max: 38 } },
  { maxVolumeL: 125, lengthCm: { min: 34, max: 42 } },
  { maxVolumeL: 100000, lengthCm: { min: 38, max: 48 } },
];

function sailRules(): SailRule[] {
  const rows: SailRule[] = [];
  for (const [category, table] of Object.entries(SAIL_AREA)) {
    table.forEach((winds, weightIndex) => {
      const weight = WEIGHT_BANDS[weightIndex];
      if (!weight) return;
      winds.forEach(([min, max], windIndex) => {
        const wind = WIND_BANDS[windIndex];
        if (!wind) return;
        rows.push({
          category,
          weightMinKg: weight[0],
          weightMaxKg: weight[1],
          windMinKn: wind[0],
          windMaxKn: wind[1],
          areaM2: { min, max },
        });
      });
    });
  }
  return rows;
}

function boardRules(): BoardRule[] {
  const rows: BoardRule[] = [];
  for (const [kind, skills] of Object.entries(BOARD_VOLUME)) {
    for (const [skill, bands] of Object.entries(skills)) {
      bands.forEach(([min, max], weightIndex) => {
        const weight = WEIGHT_BANDS[weightIndex];
        if (!weight) return;
        rows.push({
          kind,
          skill,
          weightMinKg: weight[0],
          weightMaxKg: weight[1],
          volumeL: { min, max },
        });
      });
    }
  }
  return rows;
}

const DEFAULT_WIND: Band = { min: 15, max: 25 };

/** The placeholder table. `placeholder: true` is shown in the readiness line and in docs. */
export function placeholderRules(): RigRules {
  return {
    id: "R1-placeholder",
    placeholder: true,
    sail: sailRules(),
    board: boardRules(),
    fin: FIN_LENGTH,
    // PLACEHOLDER: how far a mast may be from the sail's recommended length,
    // and an IMCS from the recommended one. Not advice.
    tolerances: { mastLengthCm: 10, imcs: 1 },
    defaultWind: DEFAULT_WIND,
    defaultSkill: "intermediate",
    defaultBoardKind: "freeride",
  };
}
