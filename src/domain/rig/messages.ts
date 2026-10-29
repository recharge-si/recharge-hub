import type { Locale } from "~/domain/rig/words";

/**
 * Sentences for the warning codes the engine and the proxy produce, so the
 * theme can show `message` as it is and still switch on `code`. The Slovenian
 * strings are first drafts for Recharge staff to review (PRD 4 open
 * question 9); the codes are the contract.
 */

type Detail = Record<string, string | number> | undefined;

const EN: Record<string, (detail: Detail) => string> = {
  mode_plain: () => "Short descriptions today. The rig is the same.",
  text_not_read: () =>
    "We could not read your description, so the rig uses your answers only.",
  kind_assumed: (d) => `We assumed ${String(d?.["kind"] ?? "freeride")} gear.`,
  skill_assumed: (d) =>
    `We assumed an ${String(d?.["skill"] ?? "intermediate")} level.`,
  wind_assumed: (d) =>
    `We assumed ${String(d?.["windMinKn"] ?? 15)} to ${String(d?.["windMaxKn"] ?? 25)} knots.`,
  over_budget: (d) =>
    `This is the lowest-priced rig that fits together, and it is ${formatEuro(d?.["overMinor"])} over your budget.`,
  stale_snapshot: (d) =>
    `Stock was last checked ${String(d?.["minutes"] ?? "a while")} minutes ago. Check availability before you buy.`,
  unsupported_discipline: () =>
    "We only build windsurf rigs for now.",
  skill_contradiction: () =>
    "Your description mentions both beginner and several years of experience. Please check your level.",
  owned_boom_unchecked: () =>
    "We did not check that your boom fits the sail. Give its length range and we will.",
  owned_board_unchecked: () => "We did not check the gear you already own: board.",
  owned_sail_unchecked: () => "We did not check the gear you already own: sail.",
  owned_mast_unchecked: () => "We did not check the gear you already own: mast.",
  owned_base_unchecked: () => "We did not check the gear you already own: base.",
  owned_fin_unchecked: () => "We did not check the gear you already own: fin.",
};

const SL: Record<string, (detail: Detail) => string> = {
  mode_plain: () => "Danes krajši opisi. Oprema je enaka.",
  text_not_read: () =>
    "Opisa nismo mogli prebrati, zato oprema temelji samo na vaših odgovorih.",
  kind_assumed: (d) => `Predpostavili smo opremo za ${String(d?.["kind"] ?? "freeride")}.`,
  skill_assumed: () => "Predpostavili smo srednjo raven znanja.",
  wind_assumed: (d) =>
    `Predpostavili smo ${String(d?.["windMinKn"] ?? 15)} do ${String(d?.["windMaxKn"] ?? 25)} vozlov.`,
  over_budget: (d) =>
    `To je najcenejša kompatibilna oprema, ${formatEuro(d?.["overMinor"])} nad vašim proračunom.`,
  stale_snapshot: (d) =>
    `Zalogo smo nazadnje preverili pred ${String(d?.["minutes"] ?? "nekaj")} minutami. Pred nakupom preverite razpoložljivost.`,
  unsupported_discipline: () => "Za zdaj sestavljamo samo opremo za windsurf.",
  skill_contradiction: () =>
    "Opis omenja začetnika in več let izkušenj. Preverite raven znanja.",
  owned_boom_unchecked: () =>
    "Nismo preverili, ali vaš boom ustreza jadru. Navedite njegov razpon in bomo.",
};

function formatEuro(minor: unknown): string {
  const value = typeof minor === "number" ? minor : 0;
  const euros = Math.trunc(value / 100);
  const cents = String(Math.abs(value % 100)).padStart(2, "0");
  return `${euros}.${cents} EUR`;
}

/** The sentence for a warning code; an unknown code reads as its own name. */
export function warningMessage(
  code: string,
  locale: Locale,
  detail?: Detail,
): string {
  const table = locale === "sl" ? SL : EN;
  const make = table[code] ?? EN[code];
  return make ? make(detail) : code;
}
