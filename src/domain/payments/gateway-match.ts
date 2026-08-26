/**
 * Suggesting which MetaKocka payment type a Shopify gateway settles into.
 *
 * A suggestion, never a decision. docs/BUILD_SPEC.md section 8.7 says a payment
 * type is never guessed, and this does not guess: it proposes a value the
 * merchant sees, can change, and has to save. What it will not do is offer a
 * type on a hunch — a gateway with more than one plausible match, or none, is
 * left for a person, because a wrong payment type is a wrong entry in somebody's
 * books rather than a wrong label on a screen.
 *
 * Pure (section 5). The register is the merchant's own, in their own language,
 * so the keywords cover Slovene as well as English.
 */

/** Comparable form: lowercase, letters and digits only. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * What each family of gateway is called in a payment register.
 *
 * Keyed by the normalised gateway handle. A handle not listed here gets only
 * the exact-name comparison, which is how a merchant's own custom manual method
 * ("Predracun") still matches the register entry of the same name.
 */
const KEYWORDS: { match: (gateway: string) => boolean; words: string[] }[] = [
  {
    match: (gateway) =>
      [
        "shopifypayments",
        "bogus",
        "stripe",
        "braintree",
        "authorizenet",
      ].includes(gateway) ||
      // "giftcard" contains "card" and is not one. Excluded here rather than
      // by ordering the list, so the rule reads as what it means.
      (gateway.includes("card") && !gateway.includes("giftcard")),
    // "kartic" is a stem, so "Placilo s kartico" answers as well as "Kartica".
    words: [
      "card",
      "kartica",
      "kartic",
      "kreditna",
      "creditcard",
      "visa",
      "mastercard",
    ],
  },
  {
    match: (gateway) =>
      gateway.includes("cashondelivery") ||
      gateway === "cod" ||
      gateway.includes("povzetj"),
    words: [
      "cod",
      "povzetju",
      "povzetje",
      "povzetj",
      "odkupnina",
      "cash",
      "gotovina",
    ],
  },
  {
    match: (gateway) =>
      ["manual", "bankdeposit", "banktransfer", "moneyorder"].includes(gateway),
    words: [
      "trr",
      "transfer",
      "banktransfer",
      "bank",
      "banka",
      "nakazilo",
      "predracun",
    ],
  },
  { match: (gateway) => gateway.includes("paypal"), words: ["paypal"] },
  {
    match: (gateway) =>
      gateway.includes("giftcard") || gateway.includes("credit"),
    words: ["gift", "giftcard", "darilni", "darilnibon", "bon"],
  },
];

/**
 * The single payment type that clearly means this gateway, or null.
 *
 * Three passes, each stricter than the one after it, and every pass abandons
 * the gateway the moment two types answer to it equally well.
 */
export function suggestPaymentType(
  gateway: string,
  paymentTypes: readonly string[],
): string | null {
  const handle = normalise(gateway);
  if (handle === "" || paymentTypes.length === 0) return null;

  const candidates = paymentTypes.map((type) => ({
    type,
    key: normalise(type),
  }));

  // 1. The register entry is named after the gateway itself.
  const exact = candidates.filter((entry) => entry.key === handle);
  if (exact.length === 1) return exact[0]!.type;
  if (exact.length > 1) return null;

  const family = KEYWORDS.find((entry) => entry.match(handle));
  if (!family) return null;

  // 2. The register entry is exactly one of the family's words.
  const named = candidates.filter((entry) => family.words.includes(entry.key));
  if (named.length === 1) return named[0]!.type;
  if (named.length > 1) return null;

  // 3. The register entry contains one, e.g. "Placilo s kartico".
  const contains = candidates.filter((entry) =>
    family.words.some((word) => entry.key.includes(word)),
  );
  return contains.length === 1 ? contains[0]!.type : null;
}

/**
 * Suggestions for every gateway that has no mapping yet.
 *
 * Existing mappings are never overwritten: a merchant's own answer outranks a
 * pattern match, always.
 */
export function suggestPaymentMapping(
  gateways: readonly string[],
  paymentTypes: readonly string[],
  existing: Readonly<Record<string, string>>,
): Record<string, string> {
  const suggested: Record<string, string> = {};

  for (const gateway of gateways) {
    if (existing[gateway]) continue;
    const match = suggestPaymentType(gateway, paymentTypes);
    if (match) suggested[gateway] = match;
  }

  return suggested;
}
