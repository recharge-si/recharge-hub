/**
 * Deterministic derivations (docs/rig-builder.md § Derived facts). Used only
 * when the metafield is missing, only for these five facts, and every value
 * that comes from here is flagged `derived` on the candidate. Pure.
 *
 * A compatibility fact (boom range, mast requirement, fin box, rider mass) is
 * never derived: if the data is absent the rule reports `unchecked`.
 */

/** The text a variant offers: its option values and its title. */
export type VariantText = readonly string[];

const MAST_CM = { min: 370, max: 520 } as const;
const SAIL_M2 = { min: 1, max: 14 } as const;
const FIN_CM = { min: 15, max: 70 } as const;

function within(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max;
}

function number(text: string): number {
  return Number(text.replace(",", "."));
}

/** A mast's option Size is its length in cm ("460"); only 370..520 is believed. */
export function mastLengthFromText(texts: VariantText): number | null {
  for (const text of texts) {
    const match = /^\s*(\d{3})(?:\s*cm)?\s*$/i.exec(text);
    if (!match?.[1]) continue;
    const value = Number(match[1]);
    if (within(value, MAST_CM)) return value;
  }
  return null;
}

/** A sail's option text "5.8 m2 / Orange" (or "m²"); 1..14 m2 only. */
export function sailAreaFromText(texts: VariantText): number | null {
  for (const text of texts) {
    const match = /(\d{1,2}(?:[.,]\d{1,2})?)\s*m(?:2|²)/i.exec(text);
    if (!match?.[1]) continue;
    const value = number(match[1]);
    if (within(value, SAIL_M2)) return value;
  }
  return null;
}

/**
 * A fin's option Size: "36 cm Power Box" is cm; a bare "440" is millimetres
 * (divided by 10 when over 100); a bare "36" is cm. Believed within 15..70 cm.
 */
export function finLengthFromText(texts: VariantText): number | null {
  for (const text of texts) {
    const withUnit = /(\d{1,3}(?:[.,]\d+)?)\s*cm\b/i.exec(text);
    if (withUnit?.[1]) {
      const value = number(withUnit[1]);
      if (within(value, FIN_CM)) return value;
      continue;
    }
    const bare = /^\s*(\d{2,3}(?:[.,]\d+)?)\s*(mm)?\s*$/i.exec(text);
    if (!bare?.[1]) continue;
    let value = number(bare[1]);
    if (bare[2] || value > 100) value /= 10;
    value = Math.round(value * 100) / 100;
    if (within(value, FIN_CM)) return value;
  }
  return null;
}

/** "HD RDM C75" gives "rdm"; a title naming both, or neither, gives null. */
export function mastDiameterFromTitle(title: string): "rdm" | "sdm" | null {
  const rdm = /\brdm\b/i.test(title);
  const sdm = /\bsdm\b/i.test(title);
  if (rdm === sdm) return null;
  return rdm ? "rdm" : "sdm";
}

/** "C75" in a mast title is 75 percent carbon; 10..100 only. */
export function carbonPercentFromTitle(title: string): number | null {
  const match = /\bC(\d{2,3})\b/.exec(title);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return value >= 10 && value <= 100 ? value : null;
}
