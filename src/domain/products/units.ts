/**
 * MetaKocka's unit-of-measure register.
 *
 * Every product MetaKocka holds carries a unit, and the API accepts the string
 * as written with no endpoint to list the valid ones and no validation error
 * when it is wrong (CLAUDE.md section 3). So the list lives here, transcribed
 * from the register in the MetaKocka UI, and the settings screen offers it as a
 * closed choice rather than a free-text field a typo can ruin.
 *
 * Order follows MetaKocka's own, which is alphabetical by the Slovenian name
 * with the numeric packaging units and a short tail after it. It is left as
 * MetaKocka has it so a merchant reading both screens sees one list.
 *
 * Pure data (section 5): no I/O, no imports from adapters.
 */
export const METAKOCKA_UNITS = [
  "ar",
  "avt. pola",
  "beseda",
  "blok",
  "cm",
  "cm2",
  "cm3",
  "cnt",
  "daj",
  "dan",
  "dm",
  "dcl",
  "ddv",
  "dkg",
  "emb",
  "g",
  "grt",
  "gal",
  "ha",
  "izvod",
  "karton",
  "kg",
  "kit",
  "km",
  "km2",
  "kol",
  "kom",
  "kos",
  "kpl",
  "krilo",
  "kvartal",
  "kWh",
  "lb",
  "leto",
  "liter",
  "m",
  "m2",
  "m3",
  "mesec",
  "mil",
  "min",
  "ml",
  "mm",
  "mm3",
  "nočitev",
  "oseba",
  "paleta",
  "panel",
  "par",
  "pce",
  "pkt",
  "pol",
  "prm",
  "predplč",
  "ptn",
  "rol",
  "sek",
  "sest",
  "set",
  "steklenica",
  "stor",
  "stran",
  "škl",
  "t",
  "tcm",
  "tčk",
  "teden",
  "tm",
  "ura",
  "zaboj",
  "zav",
  "100",
  "50",
  "10",
  "člen",
  "kolut",
  "sod",
] as const;

export type MetakockaUnit = (typeof METAKOCKA_UNITS)[number];

/** What a Slovenian company sells most things in, and MetaKocka's own default. */
export const DEFAULT_UNIT = "kos";

export function isKnownUnit(value: string): value is MetakockaUnit {
  return (METAKOCKA_UNITS as readonly string[]).includes(value);
}
