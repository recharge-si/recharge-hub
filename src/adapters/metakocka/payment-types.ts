import type { MetakockaClient } from "~/adapters/metakocka/client";
import { probeDocument, SENTINEL_PAYMENT_TYPE } from "~/adapters/metakocka/probe";

/**
 * Discovering the payment types a company accepts.
 *
 * CLAUDE.md §8.7: `payment_type` must match a type in the merchant's MetaKocka
 * register and **no endpoint lists them**. Verified against a live company:
 * sending an invalid value returns the whole valid set in `opr_desc`:
 *
 *   opr_code 2
 *   "Paramether 'payment_type' has invalid value : X.
 *    Valid values : Transakcijski račun,Gotovina,Prenos preplačila,Kartica BA"
 *
 * So the list is discoverable by deliberately failing validation. The request
 * that does the failing lives in `probe.ts`, which writes nothing.
 *
 * It is still parsing a human-readable string, so it can break. When it does,
 * `discoverPaymentTypes` returns null rather than guessing, and the settings
 * screen falls back to typing the value by hand.
 */

const VALID_VALUES = /Valid values\s*:\s*(.+)$/i;

export function parsePaymentTypes(description: string): string[] | null {
  const match = VALID_VALUES.exec(description);
  if (!match?.[1]) return null;

  const values = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== SENTINEL_PAYMENT_TYPE);

  return values.length > 0 ? values : null;
}

/**
 * Returns the payment types this company accepts, or null when the list could
 * not be read. Never returns a partial or invented list.
 */
export async function discoverPaymentTypes(
  client: MetakockaClient,
): Promise<string[] | null> {
  const description = await probeDocument(client);
  return description ? parsePaymentTypes(description) : null;
}
