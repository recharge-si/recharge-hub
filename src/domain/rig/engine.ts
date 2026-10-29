import { keyOf, type RigRole, type SpecField } from "~/domain/rig/keys";
import type {
  Band,
  BuildResult,
  Check,
  EngineWarning,
  Profile,
  Rig,
  RigAlternative,
  RigCandidate,
  RigItem,
  RigRules,
  Skill,
  Tolerances,
  Unchecked,
  Unmet,
} from "~/domain/rig/types";

/**
 * The rig engine (docs/rig-builder.md § The engine). Pure and deterministic:
 * no I/O, no clock, no randomness. The same input gives a byte-identical
 * output, ties are broken by price and then by variant id, never by order of
 * arrival.
 *
 * The AI never reaches this module: it reads the buyer's words into a
 * `Profile` and writes sentences about the result. Which products go in a rig
 * and whether they fit is decided here, and `checkRig` is the one function
 * both `buildRig` and the verify endpoint use.
 */

/* -------------------------------------------------------------------------- */
/* Fit context: what the profile and the rules table say                      */
/* -------------------------------------------------------------------------- */

export interface FitContext {
  sailBand: Band | null;
  boardBand: Band | null;
  finRules: RigRules["fin"];
  tolerances: Tolerances;
  /** Board kind the rules were read with (freeride or wave). */
  kind: string;
  /** The rider's weight, for a board that states the riders it takes. */
  weightKg: number | null;
  /** Roles the buyer already owns: left out of the rig and of its checks. */
  owned: ReadonlySet<RigRole>;
  ownedBoom: Band | null;
}

export interface Resolved {
  /** Fields still needed before anything can be built. */
  needs: string[];
  context: FitContext;
  /** Sail category the rules and the candidates are matched on. */
  kind: string;
  /** What the rules were read with, after assumptions for what the buyer left out. */
  effective: { skill: Skill; kind: string; wind: Band };
  warnings: EngineWarning[];
  unmet: Unmet[];
}

const EPS = 1e-9;

function inBand(value: number, band: Band): boolean {
  return value >= band.min - EPS && value <= band.max + EPS;
}

function middle(band: Band): number {
  return (band.min + band.max) / 2;
}

/** Reads the profile against the rules table. Pure; also used by verify. */
export function resolveFit(profile: Profile, rules: RigRules): Resolved {
  const warnings: EngineWarning[] = [];
  const unmet: Unmet[] = [];
  const needs: string[] = [];
  const owned = new Set<RigRole>(profile.owns);

  if (profile.discipline === null) needs.push("discipline");
  if (profile.weightKg === null) needs.push("weightKg");

  const kind = profile.boardKind ?? rules.defaultBoardKind;
  if (profile.boardKind === null) {
    warnings.push({ code: "kind_assumed", detail: { kind } });
  }
  const skill = profile.skill ?? rules.defaultSkill;
  if (profile.skill === null) {
    warnings.push({ code: "skill_assumed", detail: { skill } });
  }
  let wind: Band;
  if (profile.windMinKn === null && profile.windMaxKn === null) {
    wind = rules.defaultWind;
    warnings.push({
      code: "wind_assumed",
      detail: { windMinKn: wind.min, windMaxKn: wind.max },
    });
  } else {
    const low = profile.windMinKn ?? profile.windMaxKn ?? 0;
    const high = profile.windMaxKn ?? profile.windMinKn ?? low;
    wind = { min: Math.min(low, high), max: Math.max(low, high) };
  }

  let sailBand: Band | null = null;
  let boardBand: Band | null = null;
  if (profile.weightKg !== null) {
    const weight = profile.weightKg;
    const mid = middle(wind);
    const sailRow = rules.sail.find(
      (row) =>
        row.category === kind &&
        weight >= row.weightMinKg &&
        weight < row.weightMaxKg &&
        mid >= row.windMinKn &&
        mid < row.windMaxKn,
    );
    sailBand = sailRow?.areaM2 ?? null;
    const boardRow = rules.board.find(
      (row) =>
        row.kind === kind &&
        row.skill === skill &&
        weight >= row.weightMinKg &&
        weight < row.weightMaxKg,
    );
    boardBand = boardRow?.volumeL ?? null;
    if (needs.length === 0 && sailBand === null) {
      unmet.push({ role: "sail", reason: "no_rule" });
    }
    if (needs.length === 0 && boardBand === null) {
      unmet.push({ role: "board", reason: "no_rule" });
    }
  }

  let ownedBoom: Band | null = null;
  if (
    owned.has("boom") &&
    profile.ownedBoomMinCm !== null &&
    profile.ownedBoomMaxCm !== null
  ) {
    ownedBoom = { min: profile.ownedBoomMinCm, max: profile.ownedBoomMaxCm };
  }
  for (const role of [...owned].sort()) {
    if (role === "boom" && ownedBoom) continue;
    warnings.push({ code: `owned_${role}_unchecked` });
  }

  return {
    needs,
    context: {
      sailBand,
      boardBand,
      finRules: rules.fin,
      tolerances: rules.tolerances,
      weightKg: profile.weightKg,
      owned,
      kind,
      ownedBoom,
    },
    kind,
    effective: { skill, kind, wind },
    warnings,
    unmet,
  };
}

/* -------------------------------------------------------------------------- */
/* Checks: the one function build and verify share                            */
/* -------------------------------------------------------------------------- */

export type Selection = Partial<Record<RigRole, RigCandidate>>;

function num(candidate: RigCandidate | undefined, field: SpecField): number | null {
  const value = candidate?.specs[field];
  return typeof value === "number" ? value : null;
}

function code(candidate: RigCandidate | undefined, field: SpecField): string | null {
  const value = candidate?.specs[field];
  return typeof value === "string" ? value : null;
}

function list(candidate: RigCandidate | undefined, field: SpecField): string[] | null {
  const value = candidate?.specs[field];
  return Array.isArray(value) ? value : null;
}

function finBandFor(context: FitContext, volumeL: number): Band | null {
  const row = context.finRules.find((rule) => volumeL <= rule.maxVolumeL);
  return row?.lengthCm ?? null;
}

/** What one rule says: it ran and passed or failed, or it lacked data and did not run. */
type Outcome =
  | { kind: "ran"; ok: boolean }
  | { kind: "unchecked"; missing: Unchecked["missing"] };

interface RuleResult {
  id: string;
  outcome: Outcome;
}

const ran = (ok: boolean): Outcome => ({ kind: "ran", ok });

/**
 * The strict rule: a value that is absent is never assumed. Each `need` names
 * the part, the field and the key it would be read from; if any is absent the
 * outcome is `unchecked` and names every absent key, otherwise `decide` runs
 * on the values.
 */
function decide(
  needs: ReadonlyArray<{ part: RigCandidate | undefined; field: SpecField }>,
  run: () => boolean,
): Outcome {
  const missing: Unchecked["missing"] = [];
  for (const { part, field } of needs) {
    if (part && part.specs[field] === undefined) {
      missing.push({ role: part.role, key: keyOf(part.role, field) });
    }
  }
  return missing.length > 0 ? { kind: "unchecked", missing } : ran(run());
}

function rules(selection: Selection, context: FitContext): RuleResult[] {
  const out: RuleResult[] = [];
  const add = (id: string, outcome: Outcome) => out.push({ id, outcome });
  const has = (role: RigRole) => selection[role] !== undefined;
  const free = (...roles: RigRole[]) =>
    roles.every((role) => has(role) && !context.owned.has(role));

  const { sail, board, mast, boom, fin } = selection;
  const extension =
    selection.extension && !context.owned.has("extension")
      ? selection.extension
      : undefined;
  const base = selection.base;
  const tol = context.tolerances;

  if (free("sail") && context.sailBand) {
    const band = context.sailBand;
    add(
      "sail-fit",
      decide([{ part: sail, field: "areaM2" }], () => inBand(num(sail, "areaM2") ?? 0, band)),
    );
  }
  if (free("board") && context.boardBand) {
    const band = context.boardBand;
    add(
      "board-fit",
      decide([{ part: board, field: "volumeL" }], () => inBand(num(board, "volumeL") ?? 0, band)),
    );
  }
  if (free("board", "sail")) {
    add(
      "board-sail-range",
      decide(
        [
          { part: sail, field: "areaM2" },
          { part: board, field: "sailMinM2" },
          { part: board, field: "sailMaxM2" },
        ],
        () => {
          const area = num(sail, "areaM2") ?? 0;
          return (
            (num(board, "sailMinM2") ?? 0) - EPS <= area &&
            area <= (num(board, "sailMaxM2") ?? 0) + EPS
          );
        },
      ),
    );
  }
  if (free("board") && context.weightKg !== null) {
    const low = num(board, "riderMinKg");
    const high = num(board, "riderMaxKg");
    if (low !== null || high !== null) {
      const weight = context.weightKg;
      add(
        "rider-fit",
        ran(
          (low === null || weight >= low - EPS) &&
            (high === null || weight <= high + EPS),
        ),
      );
    }
  }
  if (free("sail", "mast")) {
    // The mast diameter the sail takes: its recommended one and/or its list.
    const accepted = [
      ...(list(sail, "compatibleDiameters") ?? []),
      ...(code(sail, "mastDiameter") ? [code(sail, "mastDiameter") as string] : []),
    ];
    if (accepted.length === 0 || mast?.specs.mastDiameter === undefined) {
      const missing: Unchecked["missing"] = [];
      if (accepted.length === 0) {
        missing.push({ role: "sail", key: keyOf("sail", "mastDiameter") });
      }
      if (mast?.specs.mastDiameter === undefined) {
        missing.push({ role: "mast", key: keyOf("mast", "mastDiameter") });
      }
      add("sail-mast-diameter", { kind: "unchecked", missing });
    } else {
      add("sail-mast-diameter", ran(accepted.includes(code(mast, "mastDiameter") ?? "")));
    }

    // Length: the mast, stretched by the extension when there is one, must
    // reach the length the sail recommends, within the tolerance.
    const needs: Array<{ part: RigCandidate | undefined; field: SpecField }> = [
      { part: sail, field: "mastCm" },
      { part: mast, field: "lengthCm" },
    ];
    if (extension) {
      needs.push(
        { part: extension, field: "extensionMinCm" },
        { part: extension, field: "extensionMaxCm" },
      );
    }
    add(
      "sail-mast-length",
      decide(needs, () => {
        const wanted = num(sail, "mastCm") ?? 0;
        const length = num(mast, "lengthCm") ?? 0;
        const low = length + (extension ? (num(extension, "extensionMinCm") ?? 0) : 0);
        const high = length + (extension ? (num(extension, "extensionMaxCm") ?? 0) : 0);
        return high >= wanted - tol.mastLengthCm - EPS && low <= wanted + tol.mastLengthCm + EPS;
      }),
    );

    // IMCS only when both sides state it.
    const sailImcs = num(sail, "mastImcs");
    const mastImcs = num(mast, "mastImcs");
    if (sailImcs !== null && mastImcs !== null) {
      add("sail-mast-imcs", ran(Math.abs(sailImcs - mastImcs) <= tol.imcs + EPS));
    }
  }
  if (free("mast", "boom")) {
    const diameters = list(boom, "compatibleDiameters");
    const diameter = code(mast, "mastDiameter");
    if (diameters !== null && diameter !== null) {
      add("mast-boom-diameter", ran(diameters.includes(diameter)));
    }
  }
  if (free("sail", "boom")) {
    // The boom must open over the whole range the sail asks for.
    const rangeKnown =
      sail?.specs.boomMinCm !== undefined && sail.specs.boomMaxCm !== undefined;
    const point = num(sail, "recommendedBoomCm");
    const sailLow = rangeKnown ? num(sail, "boomMinCm") : point;
    const sailHigh = rangeKnown ? num(sail, "boomMaxCm") : point;
    const missing: Unchecked["missing"] = [];
    if (sailLow === null || sailHigh === null) {
      if (sail?.specs.boomMinCm === undefined) {
        missing.push({ role: "sail", key: keyOf("sail", "boomMinCm") });
      }
      if (sail?.specs.boomMaxCm === undefined) {
        missing.push({ role: "sail", key: keyOf("sail", "boomMaxCm") });
      }
    }
    for (const field of ["boomMinCm", "boomMaxCm"] as const) {
      if (boom?.specs[field] === undefined) {
        missing.push({ role: "boom", key: keyOf("boom", field) });
      }
    }
    if (missing.length > 0) {
      add("sail-boom-range", { kind: "unchecked", missing });
    } else {
      add(
        "sail-boom-range",
        ran(
          (num(boom, "boomMinCm") ?? Number.POSITIVE_INFINITY) <= (sailLow ?? 0) + EPS &&
            (num(boom, "boomMaxCm") ?? Number.NEGATIVE_INFINITY) >= (sailHigh ?? 0) - EPS,
        ),
      );
    }
  }
  if (free("mast") && extension) {
    add(
      "mast-extension-diameter",
      decide(
        [
          { part: mast, field: "mastDiameter" },
          { part: extension, field: "mastDiameter" },
        ],
        () => code(mast, "mastDiameter") === code(extension, "mastDiameter"),
      ),
    );
  }
  if (extension && base && !context.owned.has("base")) {
    add(
      "extension-base-connection",
      decide(
        [
          { part: extension, field: "baseConnection" },
          { part: base, field: "baseConnection" },
        ],
        () => code(extension, "baseConnection") === code(base, "baseConnection"),
      ),
    );
  }
  if (free("board", "fin")) {
    add(
      "fin-box",
      decide(
        [
          { part: board, field: "finBoxTypes" },
          { part: fin, field: "finBox" },
        ],
        () => (list(board, "finBoxTypes") ?? []).includes(code(fin, "finBox") ?? ""),
      ),
    );
    // The board's own fin range when it states one; the (placeholder) rules
    // table by volume otherwise; unchecked when it has neither.
    const low = num(board, "finMinCm");
    const high = num(board, "finMaxCm");
    const volume = num(board, "volumeL");
    const bandFromVolume = volume === null ? null : finBandFor(context, volume);
    if (num(fin, "finLengthCm") === null) {
      add("fin-length", {
        kind: "unchecked",
        missing: [{ role: "fin", key: keyOf("fin", "finLengthCm") }],
      });
    } else if (low !== null || high !== null) {
      const length = num(fin, "finLengthCm") ?? 0;
      add(
        "fin-length",
        ran(
          (low === null || length >= low - EPS) && (high === null || length <= high + EPS),
        ),
      );
    } else if (bandFromVolume) {
      add("fin-length", ran(inBand(num(fin, "finLengthCm") ?? 0, bandFromVolume)));
    } else {
      add("fin-length", {
        kind: "unchecked",
        missing: [
          { role: "board", key: keyOf("board", "finMinCm") },
          { role: "board", key: keyOf("board", "finMaxCm") },
        ],
      });
    }
  }
  if (context.owned.has("boom") && context.ownedBoom && free("sail")) {
    const owned = context.ownedBoom;
    add(
      "owned-boom",
      decide(
        [
          { part: sail, field: "boomMinCm" },
          { part: sail, field: "boomMaxCm" },
        ],
        () =>
          owned.min <= (num(sail, "boomMinCm") ?? 0) + EPS &&
          owned.max >= (num(sail, "boomMaxCm") ?? 0) - EPS,
      ),
    );
  }
  return out;
}

export interface CheckReport {
  /** The rules that ran, with their answer. */
  checks: Check[];
  /** The rules that could not run, and the data each lacks. */
  unchecked: Unchecked[];
}

/**
 * Every compatibility check that applies to the parts present, and every rule
 * that could not run for lack of data. A check whose parts include one the
 * buyer owns is not computed (we do not know that part), except the owned
 * boom when its range was supplied. Order is fixed.
 */
export function checkReport(selection: Selection, context: FitContext): CheckReport {
  const checks: Check[] = [];
  const unchecked: Unchecked[] = [];
  for (const { id, outcome } of rules(selection, context)) {
    if (outcome.kind === "ran") checks.push({ id, ok: outcome.ok });
    else unchecked.push({ id, missing: outcome.missing });
  }
  return { checks, unchecked };
}

/** The checks that ran (see `checkReport` for the ones that could not). */
export function checkRig(selection: Selection, context: FitContext): Check[] {
  return checkReport(selection, context).checks;
}

/** The warnings that name what a rig was not checked for, one per missing key. */
export function uncheckedWarnings(unchecked: readonly Unchecked[]): EngineWarning[] {
  const seen = new Set<string>();
  const out: EngineWarning[] = [];
  for (const entry of unchecked) {
    for (const { role, key } of entry.missing) {
      const warningCode = `unchecked_${role}_${key}`;
      if (seen.has(warningCode)) continue;
      seen.add(warningCode);
      out.push({ code: warningCode, detail: { check: entry.id, role, key } });
    }
  }
  return out;
}

/** True when a part cannot go with the others: some rule that ran said no. */
function conflicts(
  selection: Selection,
  context: FitContext,
  selecting = false,
): boolean {
  // While choosing parts, the buyer own boom is reported afterwards (a rig
  // that does not fit it is still shown, with the failing check), not used to
  // drop a sail for which nothing is known.
  return rules(selection, context).some(
    ({ id, outcome }) =>
      outcome.kind === "ran" && !outcome.ok && !(selecting && id === "owned-boom"),
  );
}

function uncheckedCount(selection: Selection, context: FitContext): number {
  return rules(selection, context).filter(({ outcome }) => outcome.kind === "unchecked")
    .length;
}

/* -------------------------------------------------------------------------- */
/* Building                                                                   */
/* -------------------------------------------------------------------------- */

type Strategy = "recommended" | "cheapest";

const ASSEMBLY_ORDER: readonly RigRole[] = [
  "sail",
  "mast",
  "extension",
  "base",
  "boom",
  "board",
  "fin",
];

/** Sail sizes tried before giving up on a complete rig. */
const SAIL_TRIES = 8;
const ALTERNATIVES_PER_PART = 3;

function byPrice(a: RigCandidate, b: RigCandidate): number {
  return a.priceMinor - b.priceMinor || a.variantId - b.variantId;
}

function round(value: number): number {
  return Math.round(value * 1e6);
}

/** Median by price: the lower middle, so a pair gives the cheaper one. */
function choose(options: readonly RigCandidate[], strategy: Strategy): RigCandidate | undefined {
  if (options.length === 0) return undefined;
  const sorted = [...options].sort(byPrice);
  return strategy === "cheapest"
    ? sorted[0]
    : sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * The options that go with the parts already chosen: none a rule says no to,
 * and of those only the ones with the fewest rules left unchecked, so a rig
 * is verified wherever the data allows.
 */
function compatible(
  options: readonly RigCandidate[],
  role: RigRole,
  chosen: Selection,
  context: FitContext,
): RigCandidate[] {
  const scored: Array<{ candidate: RigCandidate; unchecked: number }> = [];
  for (const candidate of options) {
    const trial: Selection = { ...chosen, [role]: candidate };
    if (conflicts(trial, context, true)) continue;
    scored.push({ candidate, unchecked: uncheckedCount(trial, context) });
  }
  const best = Math.min(...scored.map((entry) => entry.unchecked));
  return scored
    .filter((entry) => entry.unchecked === best)
    .map((entry) => entry.candidate);
}

/** How many facts a candidate states in its own metafields (derived ones do not count). */
function storedFacts(candidate: RigCandidate): number {
  return Object.keys(candidate.specs).length - candidate.derived.length;
}

function closestTo(
  options: readonly RigCandidate[],
  field: "areaM2" | "volumeL",
  band: Band,
  strategy: Strategy,
): RigCandidate[] {
  const mid = middle(band);
  const distance = (candidate: RigCandidate) => {
    const value = num(candidate, field);
    return value === null ? Number.POSITIVE_INFINITY : Math.abs(value - mid);
  };
  return [...options].sort((a, b) => {
    if (strategy === "cheapest") return byPrice(a, b);
    const da = distance(a);
    const db = distance(b);
    // Equally close: the one with more stored data, so more of its fit is checked.
    return (
      round(da) - round(db) ||
      storedFacts(b) - storedFacts(a) ||
      byPrice(a, b)
    );
  });
}

interface Pool {
  byRole: Map<RigRole, RigCandidate[]>;
}

function poolOf(role: RigRole, pool: Pool): RigCandidate[] {
  return pool.byRole.get(role) ?? [];
}

/** Which categories (from the plan's types) serve a kind of rider; null category = unknown, allowed. */
const KIND_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  freeride: ["freeride", "beginner"],
  wave: ["wave", "freewave"],
};

function categoryServes(candidate: RigCandidate, kind: string): boolean {
  if (candidate.category === null) return true;
  const served = KIND_CATEGORIES[kind];
  return served ? served.includes(candidate.category) : candidate.category === kind;
}

/** One attempt at a rig around `sail`; the roles it cannot fill are `unmet`. */
function assemble(
  sail: RigCandidate,
  pool: Pool,
  fit: Resolved,
  strategy: Strategy,
): { selection: Selection; unmet: Unmet[] } {
  const context = fit.context;
  const selection: Selection = { sail };
  const unmet: Unmet[] = [];
  const noneFor = (role: RigRole) =>
    unmet.push({ role, reason: "no_compatible_in_stock" });

  // Mast, and an extension when the mast alone falls short of the sail.
  interface Option {
    mast: RigCandidate;
    extension?: RigCandidate;
    unchecked: number;
  }
  const options: Option[] = [];
  const extensions = poolOf("extension", pool);
  for (const mast of poolOf("mast", pool)) {
    const alone: Selection = { sail, mast };
    const report = checkReport(alone, context);
    const failed = report.checks
      .filter((check) => !check.ok && check.id !== "owned-boom")
      .map((check) => check.id);
    if (failed.length === 0) {
      options.push({ mast, unchecked: report.unchecked.length });
    } else if (failed.length === 1 && failed[0] === "sail-mast-length") {
      const fits = compatible(extensions, "extension", alone, context);
      const extension = choose(fits, strategy);
      if (extension) {
        options.push({
          mast,
          extension,
          unchecked: uncheckedCount({ ...alone, extension }, context),
        });
      }
    }
  }
  const cost = (option: Option) =>
    option.mast.priceMinor + (option.extension?.priceMinor ?? 0);
  const rank = (a: Option, b: Option) =>
    cost(a) - cost(b) || a.mast.variantId - b.mast.variantId;
  // Plain masts before ones that need an extension, then the best verified.
  const plain = options.filter((option) => !option.extension);
  const tier = plain.length > 0 ? plain : options;
  const fewest = Math.min(...tier.map((option) => option.unchecked));
  const group = tier.filter((option) => option.unchecked === fewest).sort(rank);
  const picked =
    group.length === 0
      ? undefined
      : strategy === "cheapest"
        ? group[0]
        : group[Math.floor((group.length - 1) / 2)];
  if (picked) {
    selection.mast = picked.mast;
    if (picked.extension) selection.extension = picked.extension;
    const base = choose(
      compatible(poolOf("base", pool), "base", selection, context),
      strategy,
    );
    if (base) selection.base = base;
    else noneFor("base");
  } else {
    noneFor("mast");
  }

  const boom = choose(
    compatible(poolOf("boom", pool), "boom", selection, context),
    strategy,
  );
  if (boom) selection.boom = boom;
  else noneFor("boom");

  // Board, then a fin that fits its box and length.
  const boardBand = context.boardBand;
  const boards =
    boardBand === null
      ? []
      : closestTo(
          poolOf("board", pool).filter((board) => {
            if (!categoryServes(board, fit.kind)) return false;
            const volume = num(board, "volumeL");
            if (volume !== null && !inBand(volume, boardBand)) return false;
            return !conflicts({ sail, board }, context, true);
          }),
          "volumeL",
          boardBand,
          strategy,
        );
  const finsFor = (board: RigCandidate) =>
    compatible(poolOf("fin", pool), "fin", { board }, context);
  const board = boards.find((candidate) => finsFor(candidate).length > 0) ?? boards[0];
  if (board) {
    selection.board = board;
    const fin = choose(finsFor(board), strategy);
    if (fin) selection.fin = fin;
    else noneFor("fin");
  } else {
    noneFor("board");
    noneFor("fin");
  }
  return { selection, unmet };
}

function toItem(candidate: RigCandidate): RigItem {
  return {
    role: candidate.role,
    productId: candidate.productId,
    variantGid: candidate.variantGid,
    variantId: candidate.variantId,
    title: candidate.title,
    variantTitle: candidate.variantTitle,
    handle: candidate.handle,
    imageUrl: candidate.imageUrl,
    vendor: candidate.vendor,
    priceMinor: candidate.priceMinor,
    currency: candidate.currency,
    available: candidate.inStock,
    quantity: 1,
    specs: candidate.specs,
    derived: candidate.derived,
  };
}

function toAlternative(candidate: RigCandidate): RigAlternative {
  return {
    role: candidate.role,
    variantGid: candidate.variantGid,
    variantId: candidate.variantId,
    productId: candidate.productId,
    title: candidate.title,
    variantTitle: candidate.variantTitle,
    handle: candidate.handle,
    imageUrl: candidate.imageUrl,
    vendor: candidate.vendor,
    priceMinor: candidate.priceMinor,
    currency: candidate.currency,
    specs: candidate.specs,
    derived: candidate.derived,
  };
}

function totalOf(selection: Selection, owned: ReadonlySet<RigRole>): number {
  let total = 0;
  for (const role of ASSEMBLY_ORDER) {
    const part = selection[role];
    if (part && !owned.has(role)) total += part.priceMinor;
  }
  return total;
}

function alternativesFor(
  selection: Selection,
  pool: Pool,
  context: FitContext,
): RigAlternative[] {
  const out: RigAlternative[] = [];
  const baseline = uncheckedCount(selection, context);
  for (const role of ASSEMBLY_ORDER) {
    const current = selection[role];
    if (!current || context.owned.has(role)) continue;
    const swaps: RigCandidate[] = [];
    for (const candidate of poolOf(role, pool)) {
      if (candidate.variantId === current.variantId) continue;
      if (
        (role === "sail" || role === "board") &&
        !categoryServes(candidate, context.kind)
      ) {
        continue;
      }
      const trial: Selection = { ...selection, [role]: candidate };
      if (
        !conflicts(trial, context) &&
        uncheckedCount(trial, context) <= baseline
      ) {
        swaps.push(candidate);
      }
    }
    swaps.sort(byPrice);
    for (const candidate of swaps.slice(0, ALTERNATIVES_PER_PART)) {
      out.push(toAlternative(candidate));
    }
  }
  return out;
}

function emptyResult(
  fit: Resolved,
  extra: Partial<BuildResult> = {},
): BuildResult {
  return {
    needs: fit.needs,
    rigs: [],
    checks: [],
    unchecked: [],
    unmet: fit.unmet,
    warnings: fit.warnings,
    missingAttributes: {},
    considered: {},
    ...extra,
  };
}

/** A complete selection has every role the rig needs; the rest are `unmet`. */
function attempt(
  sails: readonly RigCandidate[],
  pool: Pool,
  fit: Resolved,
  strategy: Strategy,
): { selection: Selection; unmet: Unmet[] } | null {
  let best: { selection: Selection; unmet: Unmet[] } | null = null;
  for (const sail of sails.slice(0, SAIL_TRIES)) {
    const result = assemble(sail, pool, fit, strategy);
    if (result.unmet.length === 0) return result;
    if (!best || result.unmet.length < best.unmet.length) best = result;
  }
  return best;
}

export interface BuildContext {
  shopId: string;
  /**
   * Variants never to pick or offer, alternatives included (a buyer's cart
   * refused one as sold out). Unknown ids are ignored.
   */
  excludeVariantIds?: ReadonlySet<number>;
}

/**
 * The rig for a profile out of the candidates the snapshot holds. Shop,
 * status and stock are filtered here as well as in the query, so a mistake
 * in the caller cannot put another shop's, a draft or a sold-out product in
 * a rig.
 */
export function buildRig(
  profile: Profile,
  candidates: readonly RigCandidate[],
  rules: RigRules,
  context: BuildContext,
): BuildResult {
  const fit = resolveFit(profile, rules);
  if (fit.needs.length > 0) return emptyResult(fit);

  const missingAttributes: Record<string, number> = {};
  const considered: Partial<Record<RigRole, number>> = {};
  const pool: Pool = { byRole: new Map() };
  const ordered = [...candidates].sort(
    (a, b) => a.variantId - b.variantId || (a.variantGid < b.variantGid ? -1 : 1),
  );
  const seen = new Set<string>();
  let stockUnknown = 0;
  for (const candidate of ordered) {
    if (candidate.shopId !== context.shopId) continue;
    if (candidate.status !== "ACTIVE") continue;
    if (context.excludeVariantIds?.has(candidate.variantId)) continue;
    if (seen.has(candidate.variantGid)) continue;
    seen.add(candidate.variantGid);
    if (candidate.missing.length > 0) {
      for (const key of candidate.missing) {
        missingAttributes[key] = (missingAttributes[key] ?? 0) + 1;
      }
      continue;
    }
    if (!candidate.inStock) {
      // Unknown stock is not stock; say so rather than let the shelf look empty.
      if (candidate.inventoryQuantity === null) stockUnknown += 1;
      continue;
    }
    considered[candidate.role] = (considered[candidate.role] ?? 0) + 1;
    const list = pool.byRole.get(candidate.role) ?? [];
    list.push(candidate);
    pool.byRole.set(candidate.role, list);
  }

  const base = emptyResult(fit, {
    missingAttributes,
    considered,
    warnings:
      stockUnknown > 0
        ? [...fit.warnings, { code: "stock_not_read", detail: { parts: stockUnknown } }]
        : fit.warnings,
  });
  const sailBand = fit.context.sailBand;
  if (!sailBand) return base;

  const fitting = poolOf("sail", pool).filter((sail) => {
    const area = num(sail, "areaM2");
    return (
      categoryServes(sail, fit.kind) &&
      area !== null &&
      inBand(area, sailBand)
    );
  });
  if (fitting.length === 0) {
    return {
      ...base,
      unmet: [...base.unmet, { role: "sail", reason: "no_compatible_in_stock" }],
    };
  }

  let strategy: Strategy = "recommended";
  let result = attempt(
    closestTo(fitting, "areaM2", sailBand, "recommended"),
    pool,
    fit,
    "recommended",
  );
  const warnings = [...base.warnings];
  const unmet: Unmet[] = [...fit.unmet];
  const owned = fit.context.owned;

  const budgetMinor =
    profile.budgetEur === null ? null : Math.round(profile.budgetEur * 100);
  if (result && budgetMinor !== null && result.unmet.length === 0) {
    if (totalOf(result.selection, owned) > budgetMinor) {
      const cheaper = attempt(
        closestTo(fitting, "areaM2", sailBand, "cheapest"),
        pool,
        fit,
        "cheapest",
      );
      if (cheaper && cheaper.unmet.length === 0) {
        result = cheaper;
        strategy = "cheapest";
      }
    }
  }
  if (!result) return { ...base, unmet };

  const total = totalOf(result.selection, owned);
  if (budgetMinor !== null && total > budgetMinor) {
    const over = total - budgetMinor;
    unmet.push({ role: "budget", reason: "over_budget", overMinor: over });
    warnings.push({ code: "over_budget", detail: { overMinor: over } });
  }
  unmet.push(...result.unmet);

  const items = ASSEMBLY_ORDER.flatMap((role) => {
    const part = result.selection[role];
    return part && !owned.has(role) ? [toItem(part)] : [];
  });
  const report = checkReport(result.selection, fit.context);
  const checks = report.checks;
  warnings.push(...uncheckedWarnings(report.unchecked));
  const rig: Rig = {
    label: strategy === "cheapest" ? "Lowest price" : "Recommended",
    items,
    totalMinor: total,
    currency: items[0]?.currency ?? "",
    checks,
    unchecked: report.unchecked,
    alternatives: alternativesFor(result.selection, pool, fit.context),
  };
  return {
    needs: [],
    rigs: [rig],
    checks,
    unchecked: report.unchecked,
    unmet,
    warnings,
    missingAttributes,
    considered,
  };
}
