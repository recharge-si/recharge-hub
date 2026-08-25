import { z } from "zod";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { toDocumentDate } from "~/adapters/metakocka/documents";
import { ENDPOINTS } from "~/adapters/metakocka/endpoints";
import { MetakockaError } from "~/adapters/metakocka/errors";

/**
 * A sales order MetaKocka is guaranteed to refuse, used to ask it questions it
 * has no endpoint for.
 *
 * CLAUDE.md §3 lists what the API cannot do, and two entries matter here: it
 * will not list the payment types a company accepts, and it will not list or
 * validate profit centres. Both values must nonetheless match the merchant's
 * register exactly or the document is rejected on a real order.
 *
 * What MetaKocka will do is *validate*. Sending a document whose
 * `payment_type` cannot exist is refused before anything is created, and the
 * refusal is informative: it names the valid payment types outright, and if the
 * profit centre were the earlier problem it would have said so instead. So a
 * request designed to fail is a read: the error text is the answer.
 *
 * **This creates nothing.** Verified against a live company with a partner and
 * no product list, and again with an empty product list. The `mk_id` branch
 * below deletes what should be impossible rather than trusting that.
 */

/** Chosen so it can never collide with a real payment type. */
export const SENTINEL_PAYMENT_TYPE = "__ORCHESTRATOR_DISCOVER__";

/**
 * A profit centre no company will have. Used as a control: see
 * `validateProfitCenter`, which needs to know whether MetaKocka checks the
 * profit centre before or after the payment type.
 */
export const SENTINEL_PROFIT_CENTER = "__ORCHESTRATOR_NO_SUCH_CENTER__";

/** Minimal partner. Enough to get past partner validation and no further. */
const PROBE_PARTNER = {
  business_entity: "false",
  taxpayer: "false",
  foreign_county: "false",
  customer: "Settings check",
  street: "-",
  post_number: "-",
  place: "-",
  country: "Slovenia",
};

/**
 * Sends the probe and returns the `opr_desc` MetaKocka refused it with.
 *
 * Returns null when there was no description to read, including the case that
 * should never happen: MetaKocka accepting the sentinel payment type. A caller
 * must treat null as "could not tell", never as a negative answer.
 *
 * `extra` is merged ahead of `mark_paid` so a probe can add the field it is
 * asking about. It cannot override the sentinel, which is what keeps the
 * request from becoming a real document.
 */
export async function probeDocument(
  client: MetakockaClient,
  extra: Record<string, unknown> = {},
): Promise<string | null> {
  try {
    // Expected to throw. Reaching the next line would mean MetaKocka accepted
    // the sentinel as a real payment type, which would also mean it created a
    // document.
    const created = await client.call(
      ENDPOINTS.putDocument,
      {
        doc_type: "sales_order",
        // dd.mm.yyyy, like every other document date. A bare ISO date is
        // refused outright (§3, verified), so validation would stop there and
        // never reach the field being asked about.
        doc_date: toDocumentDate(new Date()),
        partner: PROBE_PARTNER,
        ...extra,
        mark_paid: [
          {
            payment_type: SENTINEL_PAYMENT_TYPE,
            date: "01.01.2000",
            amount: "0.00",
          },
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
    if (error instanceof MetakockaError && error.oprDesc) return error.oprDesc;
    throw error;
  }
}
