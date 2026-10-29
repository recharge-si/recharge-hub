import type { SpecField, SpecValue, Specs } from "~/domain/rig/keys";
import type { Locale } from "~/domain/rig/words";

/**
 * The facts the engine used for a part, as short labelled values with units
 * ("Sail area", "5.8 m²"), for the theme to print under a product. The same
 * data as `specs`, which stays the machine-readable object; this is only the
 * words, in the buyer's language. A pair of bounds reads as one range.
 */

export interface Fact {
  /** The first spec field the fact came from, for the theme to key on. */
  field: SpecField;
  label: string;
  value: string;
  /** True when the value was derived from the variant's name, not stored. */
  derived?: true;
}

type Unit = "cm" | "kg" | "m2" | "l" | "";

const UNIT: Record<Unit, string> = { cm: " cm", kg: " kg", m2: " m²", l: " L", "": "" };

interface Def {
  field: SpecField;
  /** The upper bound of a range, when the fact is one. */
  to?: SpecField;
  unit: Unit;
  label: Record<Locale, string>;
}

const d = (
  field: SpecField,
  unit: Unit,
  en: string,
  sl: string,
  to?: SpecField,
): Def => ({ field, unit, label: { en, sl }, ...(to ? { to } : {}) });

/** In reading order; a field a part does not have is skipped. */
const DEFS: readonly Def[] = [
  d("areaM2", "m2", "Sail area", "Površina jadra"),
  d("volumeL", "l", "Volume", "Volumen"),
  d("lengthCm", "cm", "Mast length", "Dolžina droga"),
  d("mastCm", "cm", "Recommended mast", "Priporočen drog"),
  d("mastDiameter", "", "Mast diameter", "Premer droga"),
  d("mastImcs", "", "IMCS", "IMCS"),
  d("carbonPercent", "", "Carbon %", "Karbon %"),
  d("compatibleDiameters", "", "Fits masts", "Primerno za droge"),
  d("boomMinCm", "cm", "Boom range", "Razpon boma", "boomMaxCm"),
  d("recommendedBoomCm", "cm", "Recommended boom", "Priporočen bom"),
  d("extensionMinCm", "cm", "Extension range", "Razpon podaljška", "extensionMaxCm"),
  d("baseConnection", "", "Base connection", "Priključek podnožja"),
  d("finBox", "", "Fin box", "Utor za fin"),
  d("finLengthCm", "cm", "Fin length", "Dolžina fina"),
  d("finBoxTypes", "", "Fin boxes", "Utori za fin"),
  d("sailMinM2", "m2", "Sail range", "Razpon jader", "sailMaxM2"),
  d("finMinCm", "cm", "Fin range", "Razpon finov", "finMaxCm"),
  d("riderMinKg", "kg", "Rider weight", "Teža jahača", "riderMaxKg"),
];

/** The bounds are folded into their range; one on its own is still shown. */
const UPPER = new Set<SpecField>(
  DEFS.flatMap((def) => (def.to ? [def.to] : [])),
);

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function show(value: SpecValue, unit: Unit): string {
  if (Array.isArray(value)) return value.map(words).join(", ");
  if (typeof value === "number") return `${num(value)}${UNIT[unit]}`;
  return words(value);
}

/** `power_box` reads as "power box"; short codes (rdm, sdm) as capitals. */
function words(code: string): string {
  const text = code.replace(/_/g, " ");
  return text.length <= 3 ? text.toUpperCase() : text;
}

export function factsOf(
  specs: Specs,
  derived: readonly SpecField[],
  locale: Locale,
): Fact[] {
  const out: Fact[] = [];
  const shown = new Set<SpecField>();
  for (const def of DEFS) {
    const low = specs[def.field];
    if (low === undefined) continue;
    shown.add(def.field);
    const high = def.to ? specs[def.to] : undefined;
    let value: string;
    if (def.to && high !== undefined) {
      shown.add(def.to);
      value =
        typeof low === "number" && typeof high === "number"
          ? `${num(low)}–${num(high)}${UNIT[def.unit]}`
          : `${show(low, def.unit)}–${show(high, def.unit)}`;
    } else {
      value = show(low, def.unit);
    }
    const isDerived =
      derived.includes(def.field) || (def.to ? derived.includes(def.to) : false);
    out.push({
      field: def.field,
      label: def.to && high === undefined ? `${def.label[locale]} (min)` : def.label[locale],
      value,
      ...(isDerived ? { derived: true as const } : {}),
    });
  }
  // A lone upper bound (its lower one missing) is still a fact.
  for (const def of DEFS) {
    if (!def.to || shown.has(def.to)) continue;
    const high = specs[def.to];
    if (high === undefined || !UPPER.has(def.to)) continue;
    out.push({
      field: def.to,
      label: `${def.label[locale]} (max)`,
      value: show(high, def.unit),
    });
  }
  return out;
}
