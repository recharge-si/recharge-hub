import { z } from "zod";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { ENDPOINTS } from "~/adapters/metakocka/endpoints";
import { MetakockaError } from "~/adapters/metakocka/errors";

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
 * So the list is discoverable by deliberately failing validation. The request is
 * rejected before any document is created — confirmed with a partner and no
 * product list, and with an empty product list — so this writes nothing.
 *
 * It is still parsing a human-readable string, so it can break. When it does,
 * `discoverPaymentTypes` returns null rather than guessing, and the settings
 * screen falls back to typing the value by hand.
 */

/** Chosen so it can never collide with a real payment type. */
const SENTINEL = "__ORCHESTRATOR_DISCOVER__";

const VALID_VALUES = /Valid values\s*:\s*(.+)$/i;

/** Minimal document that reaches payment_type validation and no further. */
const PROBE_PARTNER = {
  business_entity: "false",
  taxpayer: "false",
  foreign_county: "false",
  customer: "Payment type discovery",
  street: "-",
  post_number: "-",
  place: "-",
  country: "Slovenia",
};

export function parsePaymentTypes(description: string): string[] | null {
  const match = VALID_VALUES.exec(description);
  if (!match?.[1]) return null;

  const values = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== SENTINEL);

  return values.length > 0 ? values : null;
}

/**
 * Returns the payment types this company accepts, or null when the list could
 * not be read. Never returns a partial or invented list.
 */
export async function discoverPaymentTypes(
  client: MetakockaClient,
): Promise<string[] | null> {
  try {
    // Expected to throw. A success would mean MetaKocka accepted the sentinel
    // as a real payment type, which would also mean it created a document.
    const created = await client.call(
      ENDPOINTS.putDocument,
      {
        doc_type: "sales_order",
        doc_date: new Date().toISOString().slice(0, 10),
        partner: PROBE_PARTNER,
        mark_paid: [
          { payment_type: SENTINEL, date: "01.01.2000", amount: "0.00" },
        ],
      },
      z.object({ mk_id: z.string().optional() }).passthrough(),
    );

    // Defensive: clean up something that should be impossible.
    if (created.mk_id) {
      await client
        .call(
          ENDPOINTS.deleteDocument,
          { doc_type: "sales_order", mk_id: created.mk_id },
          z.object({}).passthrough(),
        )
        .catch(() => undefined);
    }

    return null;
  } catch (error) {
    if (error instanceof MetakockaError && error.oprDesc) {
      return parsePaymentTypes(error.oprDesc);
    }
    throw error;
  }
}
