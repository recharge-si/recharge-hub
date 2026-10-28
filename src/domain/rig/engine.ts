import type { RigRole } from "~/domain/rig/keys";
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
      owned,
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

function num(candidate: RigCandidate | undefined, field: keyof RigCandidate["specs"]): number | null {
  const value = candidate?.specs[field];
  return typeof value === "number" ? value : null;
}

function code(candidate: RigCandidate | undefined, field: keyof RigCandidate["specs"]): string | null {
  const value = candidate?.specs[field];
  return value === undefined ? null : String(value);
}

function finBandFor(context: FitContext, volumeL: number): Band | null {
  const row = context.finRules.find((rule) => volumeL <= rule.maxVolumeL);
  return row?.lengthCm ?? null;
}

/**
 * Every compatibility check that applies to the parts present. A check whose
 * parts include one the buyer owns is not computed (we do not know that
 * part), except the owned boom when its range was supplied. Order is fixed.
 */
export function checkRig(selection: Selection, context: FitContext): Check[] {
  const checks: Check[] = [];
  const has = (role: RigRole) => selection[role] !== undefined;
  const free = (...roles: RigRole[]) =>
    roles.every((role) => has(role) && !context.owned.has(role));

  const sail = selection.sail;
  const board = selection.board;
  const mast = selection.mast;
  const extension = selection.extension;
  const base = selection.base;
  const boom = selection.boom;
  const fin = selection.fin;

  if (free("sail") && context.sailBand) {
    const area = num(sail, "areaM2");
    checks.push({
      id: "sail-fit",
      ok: area !== null && inBand(area, context.sailBand),
    });
  }
  if (free("board") && context.boardBand) {
    const volume = num(board, "volumeL");
    checks.push({
      id: "board-fit",
      ok: volume !== null && inBand(volume, context.boardBand),
    });
  }
  if (free("board", "sail")) {
    const area = num(sail, "areaM2");
    const low = num(board, "minSailM2");
    const high = num(board, "maxSailM2");
    checks.push({
      id: "board-sail-range",
      ok:
        area !== null &&
        low !== null &&
        high !== null &&
        low - EPS <= area &&
        area <= high + EPS,
    });
  }
  if (free("sail", "mast")) {
    const sailRdm = code(sail, "mastRdm");
    checks.push({
      id: "sail-mast-rdm",
      ok: sailRdm !== null && sailRdm === code(mast, "mastRdm"),
    });
    const length = num(mast, "lengthCm");
    const extra =
      extension && !context.owned.has("extension")
        ? (num(extension, "extensionLengthCm") ?? Number.NaN)
        : 0;
    const low = num(sail, "mastLengthMinCm");
    const high = num(sail, "mastLengthMaxCm");
    checks.push({
      id: "sail-mast-length",
      ok:
        length !== null &&
        low !== null &&
        high !== null &&
        low - EPS <= length + extra &&
        length + extra <= high + EPS,
    });
  }
  if (free("sail", "boom")) {
    // The boom must open over the whole range the sail asks for.
    const sailLow = num(sail, "boomMinCm");
    const sailHigh = num(sail, "boomMaxCm");
    const low = num(boom, "boomMinCm");
    const high = num(boom, "boomMaxCm");
    checks.push({
      id: "sail-boom-range",
      ok:
        sailLow !== null &&
        sailHigh !== null &&
        low !== null &&
        high !== null &&
        low <= sailLow + EPS &&
        high >= sailHigh - EPS,
    });
  }
  if (free("mast", "base")) {
    checks.push({
      id: "mast-base-type",
      ok:
        code(mast, "baseType") !== null &&
        code(mast, "baseType") === code(base, "baseType"),
    });
  }
  if (free("mast", "extension") && code(extension, "baseType") !== null) {
    checks.push({
      id: "mast-extension-type",
      ok: code(mast, "baseType") === code(extension, "baseType"),
    });
  }
  if (free("board", "fin")) {
    checks.push({
      id: "fin-box",
      ok: code(board, "finBox") !== null && code(board, "finBox") === code(fin, "finBox"),
    });
    const volume = num(board, "volumeL");
    const length = num(fin, "finLengthCm");
    const band = volume === null ? null : finBandFor(context, volume);
    checks.push({
      id: "fin-length",
      ok: band !== null && length !== null && inBand(length, band),
    });
  }
  if (context.owned.has("boom") && context.ownedBoom && free("sail")) {
    const sailLow = num(sail, "boomMinCm");
    const sailHigh = num(sail, "boomMaxCm");
    checks.push({
      id: "owned-boom",
      ok:
        sailLow !== null &&
        sailHigh !== null &&
        context.ownedBoom.min <= sailLow + EPS &&
        context.ownedBoom.max >= sailHigh - EPS,
    });
  }
  return checks;
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

function closestTo(
  options: readonly RigCandidate[],
  field: "areaM2" | "volumeL",
  band: Band,
  strategy: Strategy,
): RigCandidate[] {
  const mid = middle(band);
  const ranked = [...options].sort((a, b) => {
    if (strategy === "cheapest") return byPrice(a, b);
    const da = Math.abs((num(a, field) ?? 0) - mid);
    const db = Math.abs((num(b, field) ?? 0) - mid);
    return round(da) - round(db) || byPrice(a, b);
  });
  return ranked;
}

interface Pool {
  byRole: Map<RigRole, RigCandidate[]>;
}

function poolOf(role: RigRole, pool: Pool): RigCandidate[] {
  return pool.byRole.get(role) ?? [];
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

  // Mast, extension and base together: a mast is only as good as the base it has.
  const sailRdm = code(sail, "mastRdm");
  const lengthLow = num(sail, "mastLengthMinCm") ?? 0;
  const lengthHigh = num(sail, "mastLengthMaxCm") ?? 0;
  const masts = poolOf("mast", pool).filter(
    (mast) => code(mast, "mastRdm") === sailRdm,
  );
  const bases = poolOf("base", pool);
  const extensions = poolOf("extension", pool);

  interface Option {
    mast: RigCandidate;
    extension?: RigCandidate;
    base?: RigCandidate;
  }
  const options: Option[] = [];
  for (const mast of masts) {
    const length = num(mast, "lengthCm") ?? 0;
    const type = code(mast, "baseType");
    const base = choose(
      bases.filter((candidate) => code(candidate, "baseType") === type),
      strategy,
    );
    if (length >= lengthLow - EPS && length <= lengthHigh + EPS) {
      options.push({ mast, ...(base ? { base } : {}) });
      continue;
    }
    if (length < lengthLow) {
      const extension = choose(
        extensions.filter((candidate) => {
          const extra = num(candidate, "extensionLengthCm") ?? 0;
          const extType = code(candidate, "baseType");
          return (
            (extType === null || extType === type) &&
            length + extra >= lengthLow - EPS &&
            length + extra <= lengthHigh + EPS
          );
        }),
        strategy,
      );
      if (extension) options.push({ mast, extension, ...(base ? { base } : {}) });
    }
  }
  const cost = (option: Option) =>
    option.mast.priceMinor +
    (option.extension?.priceMinor ?? 0) +
    (option.base?.priceMinor ?? 0);
  const rank = (a: Option, b: Option) =>
    cost(a) - cost(b) || a.mast.variantId - b.mast.variantId;
  const complete = options.filter((option) => option.base);
  const usable = complete.length > 0 ? complete : options;
  // Plain masts before ones that need an extension.
  const plain = usable.filter((option) => !option.extension);
  const group = (plain.length > 0 ? plain : usable).sort(rank);
  const picked =
    group.length === 0
      ? undefined
      : strategy === "cheapest"
        ? group[0]
        : group[Math.floor((group.length - 1) / 2)];
  if (picked) {
    selection.mast = picked.mast;
    if (picked.extension) selection.extension = picked.extension;
    if (picked.base) selection.base = picked.base;
    else noneFor("base");
  } else {
    noneFor("mast");
  }

  const sailLow = num(sail, "boomMinCm") ?? 0;
  const sailHigh = num(sail, "boomMaxCm") ?? 0;
  const boom = choose(
    poolOf("boom", pool).filter(
      (candidate) =>
        (num(candidate, "boomMinCm") ?? Number.POSITIVE_INFINITY) <= sailLow + EPS &&
        (num(candidate, "boomMaxCm") ?? Number.NEGATIVE_INFINITY) >= sailHigh - EPS,
    ),
    strategy,
  );
  if (boom) selection.boom = boom;
  else noneFor("boom");

  // Board, then a fin that fits its box and length.
  const area = num(sail, "areaM2") ?? 0;
  const boardBand = context.boardBand;
  const boards =
    boardBand === null
      ? []
      : closestTo(
          poolOf("board", pool).filter((board) => {
            const volume = num(board, "volumeL");
            return (
              volume !== null &&
              inBand(volume, boardBand) &&
              (num(board, "minSailM2") ?? Number.POSITIVE_INFINITY) <=
                area + EPS &&
              (num(board, "maxSailM2") ?? Number.NEGATIVE_INFINITY) >=
                area - EPS
            );
          }),
          "volumeL",
          boardBand,
          strategy,
        );
  const finsFor = (board: RigCandidate) => {
    const volume = num(board, "volumeL") ?? 0;
    const band = finBandFor(context, volume);
    return poolOf("fin", pool).filter(
      (fin) =>
        code(fin, "finBox") === code(board, "finBox") &&
        band !== null &&
        inBand(num(fin, "finLengthCm") ?? -1, band),
    );
  };
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
    priceMinor: candidate.priceMinor,
    currency: candidate.currency,
    available: candidate.inStock,
    quantity: 1,
    specs: candidate.specs,
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
    priceMinor: candidate.priceMinor,
    currency: candidate.currency,
    specs: candidate.specs,
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
  for (const role of ASSEMBLY_ORDER) {
    const current = selection[role];
    if (!current || context.owned.has(role)) continue;
    const swaps: RigCandidate[] = [];
    for (const candidate of poolOf(role, pool)) {
      if (candidate.variantId === current.variantId) continue;
      const trial: Selection = { ...selection, [role]: candidate };
      if (checkRig(trial, context).every((check) => check.ok)) {
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
  for (const candidate of ordered) {
    if (candidate.shopId !== context.shopId) continue;
    if (candidate.status !== "ACTIVE") continue;
    if (seen.has(candidate.variantGid)) continue;
    seen.add(candidate.variantGid);
    if (candidate.missing.length > 0) {
      for (const key of candidate.missing) {
        missingAttributes[key] = (missingAttributes[key] ?? 0) + 1;
      }
      continue;
    }
    if (!candidate.inStock) continue;
    considered[candidate.role] = (considered[candidate.role] ?? 0) + 1;
    const list = pool.byRole.get(candidate.role) ?? [];
    list.push(candidate);
    pool.byRole.set(candidate.role, list);
  }

  const base = emptyResult(fit, { missingAttributes, considered });
  const sailBand = fit.context.sailBand;
  if (!sailBand) return base;

  const fitting = poolOf("sail", pool).filter((sail) => {
    const area = num(sail, "areaM2");
    return (
      code(sail, "category") === fit.kind &&
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
  const warnings = [...fit.warnings];
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
  const checks = checkRig(result.selection, fit.context);
  const rig: Rig = {
    label: strategy === "cheapest" ? "Lowest price" : "Recommended",
    items,
    totalMinor: total,
    currency: items[0]?.currency ?? "",
    checks,
    alternatives: alternativesFor(result.selection, pool, fit.context),
  };
  return {
    needs: [],
    rigs: [rig],
    checks,
    unmet,
    warnings,
    missingAttributes,
    considered,
  };
}
