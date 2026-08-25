import { z } from "zod";

import {
  mkEnvelopeSchema,
  type MetakockaClient,
} from "~/adapters/metakocka/client";
import { ENDPOINTS } from "~/adapters/metakocka/endpoints";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { toMinorUnits } from "~/adapters/metakocka/values";

/**
 * Sales orders, per
 * https://github.com/metakocka/metakocka_api_base/blob/master/docs/documents_put_document_sales_order.md
 *
 * The constraint that shapes everything above this file: `warehouse`,
 * `profit_center`, `delivery_type` and `parcel_shop_id` are **document-level,
 * not per line** (CLAUDE.md §3). One sales order is one warehouse and one
 * profit centre, so an order split across two supply sources is two documents,
 * not one document with two kinds of line.
 *
 * Three verified behaviours are designed around here rather than discovered
 * later:
 *
 *  - **`count_code` is not unique on MetaKocka's side.** Re-sending one creates
 *    a second document under MetaKocka's own numbering, which can then no
 *    longer be found by the code we sent. So this module never retries blindly;
 *    the duplicate guard lives in `metakocka_document` and an ambiguous timeout
 *    is resolved by `findDocument`, not by sending again.
 *  - **`buyer_order` links siblings, `customer_order` does not.** A
 *    `customer_order` sent here is silently discarded and is not searchable.
 *  - **An invalid `warehouse` is silently accepted** and filed against the
 *    company default. The caller validates the mark against `warehouse_list`
 *    before calling; MetaKocka will not do it.
 *
 * Money goes out as `price_with_tax` because the documentation is explicit that
 * webshop orders always should, and as a decimal string built from integer
 * minor units so no float ever touches it (§15).
 */

const documentResponseSchema = mkEnvelopeSchema.and(
  z
    .object({
      mk_id: z.union([z.string(), z.number()]).transform(String).optional(),
      count_code: z.string().optional(),
      doc_number: z.string().optional(),
    })
    .passthrough(),
);

export interface DocumentParty {
  /**
   * The MetaKocka partner this refers to, when it has been resolved.
   *
   * With it, the document links to that partner and creates nothing. Without
   * it MetaKocka makes a new partner from the fields below, every time — see
   * adapters/metakocka/partners.ts.
   */
  mkId?: string | null;
  /** Required alongside mkId: an id with no address is refused. */
  mkAddressId?: string | null;
  /** Company or person name. */
  customer: string;
  street?: string | null;
  postNumber?: string | null;
  place?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  isBusiness?: boolean;
  email?: string | null;
  phone?: string | null;
}

/**
 * One line of a sales order, always a reference to a catalogue product.
 *
 * **[verified] `name` and `unit` are deliberately absent, and that is what
 * keeps these lines out of the catalogue.** A line whose `code` matches an
 * existing product is linked to it and MetaKocka overrides any `name` sent
 * with the catalogue's own, so sending one achieves nothing. A line whose code
 * does *not* match is refused —
 * `opr_code 8, "Product with code X not found - unit must be set to add new
 * product"` — which says plainly that supplying `unit` would make MetaKocka
 * **create a product from the order line**. That is how an order ends up
 * inventing catalogue entries, so neither field is ever sent and an unknown SKU
 * becomes an exception instead (§11).
 */
export interface DocumentLine {
  /** The MetaKocka product code, which this app keeps equal to the SKU. */
  code: string;
  amount: number;
  /** Unit price in minor units, as Shopify charged it. */
  priceWithTaxMinor: number;
  /** Decimal factor such as "0.22". Null leaves the tax to MetaKocka. */
  taxFactor?: string | null;
  name?: string | null;
}

export interface SalesOrderInput {
  countCode: string;
  /** Shared by every document from one Shopify order. */
  buyerOrder: string;
  /** When the order happened. Injected, never read from the clock here (§5). */
  docDate: Date;
  /** Overrides the ERP timezone the document date is expressed in. */
  timeZone?: string;
  currencyCode: string;
  partner: DocumentParty;
  receiver?: DocumentParty | null;
  lines: DocumentLine[];
  /**
   * The pricelist this order is priced against, as `sales_pricelist_code`.
   *
   * Without it MetaKocka files the document against no pricelist at all, which
   * leaves anyone opening it in the ERP unable to see which prices applied.
   */
  salesPricelistCode?: string | null;
  /** Document-level, and the reason a split order is several documents. */
  warehouse?: string | null;
  profitCenter?: string | null;
  deliveryType?: string | null;
  parcelShopId?: string | null;
  methodOfPayment?: string | null;
  notes?: string | null;
  /**
   * Whether the line prices already include tax, from the shop's own setting.
   *
   * §8.6 asks for both kinds of store to be handled and this is where it bites:
   * MetaKocka takes either `price` (net) or `price_with_tax` (gross), and
   * sending a tax-exclusive shop's net figure in the gross field understates
   * every line by the VAT rate. The documentation says webshop orders should
   * always send gross, which is true of a tax-inclusive shop and wrong for the
   * other kind, so the flag decides rather than the assumption.
   */
  taxesIncluded?: boolean;
  /**
   * Marks the document paid as part of creating it (§8.7).
   *
   * Deliberately part of the create rather than a follow-up update. See
   * `markDocumentPaid` for why an update is dangerous.
   */
  markPaid?: {
    paymentType: string;
    paidAt: Date;
    amountMinor?: number;
  } | null;
  /** Currency minor-unit exponent. Two everywhere this app currently ships. */
  currencyDecimals?: number;
}

export interface DocumentResult {
  mkId: string | null;
  countCode: string | null;
  docNumber: string | null;
}

/**
 * Minor units to the decimal string MetaKocka expects.
 *
 * Built by slicing the integer rather than dividing, because 1999 / 100 is fine
 * but the general case is not, and §8.6 forbids exactly the drift a float
 * round-trip introduces.
 */
export function minorToDecimalString(minor: number, decimals = 2): string {
  const negative = minor < 0;
  const digits = Math.abs(Math.trunc(minor))
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction =
    decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * The timezone MetaKocka keeps its books in.
 *
 * MetaKocka is a Slovenian ERP, so a document date means a Ljubljana calendar
 * date. Overridable per call, because a company keeping books elsewhere should
 * not need a code change.
 */
export const METAKOCKA_TIME_ZONE = "Europe/Ljubljana";

/** The calendar date at an instant, in a given zone, as {day, month, year}. */
function calendarDateIn(date: Date, timeZone: string) {
  // en-CA is the locale that formats as YYYY-MM-DD, which is trivial to split.
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .split("-");

  return { year: year!, month: month!, day: day! };
}

/**
 * MetaKocka's document date, as `dd.mm.yyyy`.
 *
 * **[verified against company 6789 on 2026-08-25]** and this one took three
 * attempts, so the evidence is written down rather than summarised. Probing
 * `put_document` with a deliberately invalid `profit_center` — which MetaKocka
 * refuses before creating anything — gives a clean read on whether a date got
 * past validation:
 *
 * | doc_date                    | result   |
 * |-----------------------------|----------|
 * | `25.08.2026`                | accepted |
 * | `15.01.2026`                | accepted |
 * | `2026-08-25+02:00`          | accepted |
 * | `2026-01-15+02:00`          | accepted |
 * | `2025-08-25+02:00`          | accepted |
 * | `2026-08-25`                | rejected |
 * | `2026-08-25+00:00`          | rejected |
 * | `2026-08-25-04:00`          | rejected |
 * | `2026-08-25+01:00`          | rejected |
 * | `2026-08-25+03:00`          | rejected |
 * | `2025-01-15+01:00`          | rejected |
 * | `2026-08-25+0200`           | rejected |
 * | `2026-08-25T09:52:00+02:00` | rejected |
 *
 * The conclusion that matters: **`+02:00` is a literal MetaKocka insists on,
 * not a timezone it interprets.** `+01:00` is refused in January as readily as
 * in August, and `+02:00` is accepted in January. So the ISO form documented
 * everywhere in MetaKocka's own docs only works if you hardcode an offset that
 * is a lie for five months of the year — and an implementation that computed
 * the real Ljubljana offset would have broken every document between late
 * October and late March.
 *
 * `dd.mm.yyyy` avoids the trap entirely: no offset to be wrong about, and it is
 * the format MetaKocka already requires for `mark_paid`, so the payload now
 * uses one date convention instead of two.
 *
 * The date itself is taken in the ERP's timezone, because the date on a sales
 * order belongs to the ledger it is filed in rather than to wherever the
 * customer was standing. An order placed at 23:00 in New York is the next
 * morning in Ljubljana, and a Slovenian company books it on the next day.
 */
export function toDocumentDate(
  at: Date,
  timeZone: string = METAKOCKA_TIME_ZONE,
): string {
  const { year, month, day } = calendarDateIn(at, timeZone);
  return `${day}.${month}.${year}`;
}

/**
 * `mark_paid.date`, also `dd.mm.yyyy`.
 *
 * Taken in the ERP timezone for the same reason as the document date: a payment
 * recorded at 23:00 in New York belongs to the following day in a Slovenian
 * ledger, and reading it off UTC would file it a day early for anyone west of
 * Greenwich.
 */
export function toPaymentDate(
  date: Date,
  timeZone: string = METAKOCKA_TIME_ZONE,
): string {
  const { year, month, day } = calendarDateIn(date, timeZone);
  return `${day}.${month}.${year}`;
}

function party(input: DocumentParty) {
  // A resolved partner is referenced, not redescribed. The name and street go
  // along because MetaKocka wants an address identification even when it has
  // been handed an id.
  if (input.mkId) {
    return {
      mk_id: input.mkId,
      ...(input.mkAddressId ? { mk_address_id: input.mkAddressId } : {}),
      customer: input.customer,
      ...(input.street ? { street: input.street } : {}),
    };
  }

  return {
    business_entity: input.isBusiness ? "true" : "false",
    taxpayer: input.isBusiness ? "true" : "false",
    foreign_county: "false",
    tax_id_number: input.taxNumber ?? "",
    customer: input.customer,
    ...(input.street ? { street: input.street } : {}),
    ...(input.postNumber ? { post_number: input.postNumber } : {}),
    ...(input.place ? { place: input.place } : {}),
    ...(input.country ? { country: input.country } : {}),
    ...(input.email || input.phone
      ? {
          partner_contact: {
            name: input.customer,
            ...(input.email ? { email: input.email } : {}),
            ...(input.phone ? { phone: input.phone, gsm: input.phone } : {}),
          },
        }
      : {}),
  };
}

/** The exact body sent, built separately so it can be recorded and asserted. */
export function buildSalesOrderBody(input: SalesOrderInput) {
  const decimals = input.currencyDecimals ?? 2;

  return {
    doc_type: "sales_order",
    count_code: input.countCode,
    doc_date: toDocumentDate(input.docDate, input.timeZone),
    currency_code: input.currencyCode,
    // §3, verified: this is the field that links sibling documents and the only
    // one that is searchable. `customer_order` is silently discarded.
    buyer_order: input.buyerOrder,
    partner: party(input.partner),
    ...(input.receiver ? { receiver: party(input.receiver) } : {}),
    ...(input.salesPricelistCode
      ? { sales_pricelist_code: input.salesPricelistCode }
      : {}),
    ...(input.warehouse ? { warehouse: input.warehouse } : {}),
    ...(input.profitCenter ? { profit_center: input.profitCenter } : {}),
    ...(input.deliveryType ? { delivery_type: input.deliveryType } : {}),
    ...(input.parcelShopId ? { parcel_shop_id: input.parcelShopId } : {}),
    ...(input.methodOfPayment
      ? { method_of_payment: input.methodOfPayment }
      : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.markPaid
      ? {
          mark_paid: [
            {
              payment_type: input.markPaid.paymentType,
              date: toPaymentDate(input.markPaid.paidAt, input.timeZone),
              ...(input.markPaid.amountMinor !== undefined
                ? {
                    amount: minorToDecimalString(
                      input.markPaid.amountMinor,
                      decimals,
                    ),
                  }
                : {}),
            },
          ],
        }
      : {}),
    product_list: input.lines.map((line) => ({
      code: line.code,
      amount: String(line.amount),
      // Gross or net, whichever Shopify's figure actually is. Putting a net
      // price in price_with_tax would understate the line by the VAT rate.
      ...(input.taxesIncluded === false
        ? { price: minorToDecimalString(line.priceWithTaxMinor, decimals) }
        : {
            price_with_tax: minorToDecimalString(
              line.priceWithTaxMinor,
              decimals,
            ),
          }),
      // MetaKocka refuses a line whose product has no tax attribute of its own
      // and no tax on the line, so this is always sent. Null never reaches
      // here: the caller raises an exception instead (§11).
      ...(line.taxFactor !== null && line.taxFactor !== undefined
        ? { tax_factor: line.taxFactor }
        : {}),
    })),
  };
}

export async function putSalesOrder(
  client: MetakockaClient,
  input: SalesOrderInput,
): Promise<{ body: object; result: DocumentResult }> {
  const body = buildSalesOrderBody(input);

  const response = await client.call(
    ENDPOINTS.putDocument,
    body,
    documentResponseSchema,
  );

  return {
    body,
    result: {
      mkId: response.mk_id ?? null,
      countCode: response.count_code ?? null,
      docNumber: response.doc_number ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Reading one document back                                                  */
/* -------------------------------------------------------------------------- */

const singleDocumentSchema = mkEnvelopeSchema.and(
  z
    .object({
      mk_id: z.union([z.string(), z.number()]).transform(String).optional(),
      count_code: z.string().optional(),
      doc_number: z.string().optional(),
      product_list: z
        .array(
          z
            .object({
              code: z.string().optional(),
              amount: z.union([z.string(), z.number()]).optional(),
            })
            .passthrough(),
        )
        .optional(),
      // Present once a payment has been recorded. Named for the field the
      // document carries back, which is not the `mark_paid` we send.
      payment_list: z.array(z.record(z.string(), z.unknown())).optional(),
      /*
       * **[verified against company 6789 on 2026-08-25]** `get_document` with
       * `doc_id` set to the `mk_id` returned by `put_document` answers with the
       * whole document at the top level:
       *
       *   mk_id, doc_type, opr_code, count_code, doc_date, partner, receiver,
       *   sales_pricelist_code, currency_code, doc_created_email, buyer_order,
       *   warehouse, product_list, sum_basic, sum_tax_ex4, sum_all,
       *   profit_center, profit_center_desc, bank_ref_number, order_create_ts,
       *   created_ts, fulfillment_user
       *
       * Two things are notable by their absence, and both changed what this
       * poller is for. There is **no status field** on a sales order — no
       * `status`, no `status_code` — and **no tracking field** of any kind. So
       * there is no workflow state to follow here, and the useful questions
       * turn out to be different ones: does the document still exist, and does
       * it still say what we sent? Both are answerable, and both happen.
       */
      sum_all: z.union([z.string(), z.number()]).optional(),
      buyer_order: z.string().optional(),
    })
    .passthrough(),
);

export interface DocumentSnapshot {
  mkId: string | null;
  countCode: string | null;
  docNumber: string | null;
  /**
   * How many lines MetaKocka currently holds on the document.
   *
   * **Null means the response did not say**, which is a different answer from
   * zero and is treated differently by the caller. `get_document`'s exact
   * response shape has not been verified against a live company (CLAUDE.md
   * §14), and a check that cannot read the answer must not report a disaster.
   */
  lineCount: number | null;
  /** Whether MetaKocka reports a payment against it, where it says. */
  hasPayment: boolean | null;
  /** `sum_all`, the document total as MetaKocka now holds it. Minor units. */
  totalMinor: number | null;
  buyerOrder: string | null;
  /**
   * The lines as MetaKocka now holds them, as `code` to total quantity.
   *
   * This rather than the total is what the poller compares, and the reason is
   * tax basis. `sum_all` is always gross, while what this app *sends* is gross
   * or net depending on the shop's `taxesIncluded` setting (§8.6) — so on a
   * tax-exclusive shop a total comparison would differ by the VAT rate on every
   * order and report every document as edited. Codes and quantities mean the
   * same thing on both sides whatever the prices are doing.
   */
  lines: Map<string, number>;
}

/**
 * Reads one sales order back from MetaKocka.
 *
 * **[verified] `get_document` takes `doc_id`, not `mk_id`** (§3). Sending
 * `mk_id` answers "Cannot find document type sales_order with id = null",
 * which reads like a missing document rather than a wrong parameter name.
 *
 * This exists to check an update rather than to fetch data. §7 records the
 * pattern that makes it necessary: MetaKocka reports success for a call that
 * changed nothing, and — verified in `markDocumentPaid` below — reports success
 * for an update that silently deleted every line on the document. `opr_code 0`
 * is not evidence that the right thing happened, so the write is read back.
 */
/**
 * `product_list` as code to quantity, summed.
 *
 * Summed rather than kept per row because MetaKocka is free to hold the same
 * code on two rows where this app sent one, and for the question being asked —
 * does the document still describe the same goods — two rows of one are the
 * same answer as one row of two.
 */
function lineQuantities(
  list: { code?: string; amount?: string | number }[] | undefined,
): Map<string, number> {
  const lines = new Map<string, number>();
  if (!list) return lines;

  for (const row of list) {
    if (!row.code) continue;
    const amount = Number(String(row.amount ?? "0").replace(",", "."));
    if (!Number.isFinite(amount)) continue;
    lines.set(row.code, (lines.get(row.code) ?? 0) + amount);
  }
  return lines;
}

export async function getSalesOrder(
  client: MetakockaClient,
  docId: string,
): Promise<DocumentSnapshot> {
  const response = await client.call(
    ENDPOINTS.getDocument,
    { doc_type: "sales_order", doc_id: docId },
    singleDocumentSchema,
  );

  return {
    mkId: response.mk_id ?? null,
    countCode: response.count_code ?? null,
    docNumber: response.doc_number ?? null,
    lineCount: response.product_list ? response.product_list.length : null,
    hasPayment: response.payment_list
      ? response.payment_list.length > 0
      : null,
    // Parsed at the boundary and never as a float (§15). MetaKocka sends money
    // as a string and sometimes with a decimal comma.
    totalMinor:
      response.sum_all === undefined
        ? null
        : toMinorUnits(String(response.sum_all)),
    buyerOrder: response.buyer_order ?? null,
    lines: lineQuantities(response.product_list),
  };
}

/**
 * Whether a MetaKocka rejection means "that document does not exist".
 *
 * **[verified]** A `doc_id` MetaKocka does not have answers `opr_code 2` with
 * `"Cannot find document type sales_order with id = 1200049905201"` — the same
 * code it uses for a malformed request, so the code alone cannot be trusted and
 * the description has to be read (§3, and the same lesson as code 6).
 *
 * It is worth telling apart because it is not a failure: a document deleted in
 * the MetaKocka UI is a thing merchants do, and this app went on reporting the
 * order as sent regardless.
 */
export function isDocumentMissing(error: unknown): boolean {
  if (!(error instanceof MetakockaError)) return false;
  const description = (error.oprDesc ?? "").toLowerCase();
  return (
    description.includes("cannot find document") ||
    description.includes("cannot find sales order")
  );
}

/** `getSalesOrder`, but a document MetaKocka no longer has is null, not a throw. */
export async function findSalesOrder(
  client: MetakockaClient,
  docId: string,
): Promise<DocumentSnapshot | null> {
  try {
    return await getSalesOrder(client, docId);
  } catch (error) {
    if (isDocumentMissing(error)) return null;
    throw error;
  }
}

/**
 * Replaces a sales order MetaKocka already holds with a corrected version.
 *
 * The mechanism is the one verified for `markDocumentPaid` below, used
 * deliberately rather than discovered by accident: **MetaKocka treats an update
 * as a replacement**, so `put_document` with `mk_id` and a complete body swaps
 * the document for the body sent. That is a trap when the body is a patch — it
 * silently deletes everything left out — and exactly the right tool when the
 * body is a whole, freshly built document.
 *
 * Two things the caller must get right, and both are about what a replacement
 * takes with it:
 *
 *  - **The payment goes back on.** §8.7: `mark_paid` on an update deletes the
 *    previous payment and replaces it. A document that was paid and is updated
 *    without one is a document that is no longer paid, silently. `input.body`
 *    must carry the `mark_paid` the document already had.
 *  - **The result is read back.** `opr_code 0` is not evidence the right thing
 *    happened — §7 records MetaKocka reporting success for a call that changed
 *    nothing, and the note below records it reporting success for one that
 *    emptied a document.
 *
 * This is the one place in the app that changes a document MetaKocka has
 * accepted. Everything about it assumes the caller has decided that is
 * appropriate (§8.8: the document may already be invoiced).
 */
export async function updateSalesOrder(
  client: MetakockaClient,
  input: {
    mkId: string;
    /** A complete document, built the same way a create is. Never a patch. */
    body: Record<string, unknown>;
  },
): Promise<{ body: Record<string, unknown>; verified: DocumentSnapshot }> {
  const expectedLines = Array.isArray(input.body.product_list)
    ? input.body.product_list.length
    : 0;

  const body: Record<string, unknown> = { ...input.body, mk_id: input.mkId };

  await client.call(ENDPOINTS.putDocument, body, documentResponseSchema);

  const verified = await getSalesOrder(client, input.mkId);

  if (
    expectedLines > 0 &&
    verified.lineCount !== null &&
    verified.lineCount < expectedLines
  ) {
    throw new MetakockaError(
      `MetaKocka accepted the update but the document now holds ${verified.lineCount} of ${expectedLines} lines`,
      {
        endpoint: ENDPOINTS.putDocument,
        kind: "exception",
        oprDesc: `Document ${input.mkId} lost lines when it was updated. MetaKocka treats an update as a replacement and reported success regardless. Check the document in MetaKocka before doing anything else with this order.`,
      },
    );
  }

  return { body, verified };
}

/**
 * Marks an already-written document paid, and checks that it survived.
 *
 * **[verified] A partial update destroys the document.** Sending
 * `put_document` with `mk_id` and `mark_paid` and nothing else answered
 * "Partner data are missing"; adding the partner answered "Value is require for
 * doc_date"; adding that succeeded — and **deleted every line on the
 * document**. A five-line order came back with no `product_list` and no totals,
 * silently, reported as success. MetaKocka treats an update as a replacement,
 * so anything left out is removed.
 *
 * Two things follow, and both are load-bearing:
 *
 *  - **The whole document goes with the payment.** `body` is the complete
 *    document, not a patch. The caller sends back the exact body MetaKocka
 *    accepted when the document was created, so a replacement replaces it with
 *    itself.
 *  - **The result is read back.** `expectedLines` is checked against what
 *    MetaKocka holds afterwards, because the failure mode above reported
 *    success. A merchant finding out at the end of the quarter that a document
 *    lost its lines is not an acceptable way to learn this.
 *
 * §8.7 also warns that `mark_paid` on an update deletes the previous payment
 * and replaces it, so this is only ever sent once per document — the caller
 * claims the document before calling and records `payment_marked_at` after.
 */
export async function markDocumentPaid(
  client: MetakockaClient,
  input: {
    mkId: string;
    /** The complete document body, as originally sent. Never a subset. */
    body: Record<string, unknown>;
    payment: NonNullable<SalesOrderInput["markPaid"]>;
    timeZone?: string;
    currencyDecimals?: number;
  },
): Promise<{ body: Record<string, unknown>; verified: DocumentSnapshot }> {
  const decimals = input.currencyDecimals ?? 2;

  const expectedLines = Array.isArray(input.body.product_list)
    ? input.body.product_list.length
    : 0;

  const body: Record<string, unknown> = {
    ...input.body,
    mk_id: input.mkId,
    mark_paid: [
      {
        payment_type: input.payment.paymentType,
        date: toPaymentDate(input.payment.paidAt, input.timeZone),
        ...(input.payment.amountMinor !== undefined
          ? { amount: minorToDecimalString(input.payment.amountMinor, decimals) }
          : {}),
      },
    ],
  };

  await client.call(ENDPOINTS.putDocument, body, documentResponseSchema);

  const verified = await getSalesOrder(client, input.mkId);

  /*
   * Only an answer counts as a failure.
   *
   * `null` means `get_document` did not return a `product_list` at all, which
   * says nothing about the document and everything about a response shape this
   * app has not verified (§14). Treating that as "the lines are gone" would
   * raise an alarming exception immediately after a payment that went through
   * perfectly, which is its own kind of damage.
   */
  if (
    expectedLines > 0 &&
    verified.lineCount !== null &&
    verified.lineCount < expectedLines
  ) {
    throw new MetakockaError(
      `MetaKocka accepted the payment but the document now holds ${verified.lineCount} of ${expectedLines} lines`,
      {
        endpoint: ENDPOINTS.putDocument,
        kind: "exception",
        oprDesc: `Document ${input.mkId} lost lines when the payment was recorded. MetaKocka treats an update as a replacement and reported success regardless. Check the document in MetaKocka before doing anything else with this order.`,
      },
    );
  }

  return { body, verified };
}

const searchResponseSchema = mkEnvelopeSchema.and(
  z
    .object({
      result_list: z
        .array(
          z
            .object({
              mk_id: z.union([z.string(), z.number()]).transform(String),
              count_code: z.string().optional(),
              doc_number: z.string().optional(),
            })
            .passthrough(),
        )
        .default([]),
    })
    .passthrough(),
);

/**
 * Looks a document up by the reference we sent.
 *
 * This exists for one situation and it is important: a `put_document` that
 * times out is ambiguous. §3 says re-sending the same `count_code` creates a
 * *second* document rather than failing, so a blind retry is how one Shopify
 * order becomes two sales orders in the ERP. An ambiguous write is resolved by
 * looking, never by sending again.
 */
export async function findDocumentByBuyerOrder(
  client: MetakockaClient,
  buyerOrder: string,
): Promise<DocumentResult[]> {
  const response = await client.call(
    ENDPOINTS.getDocument,
    { doc_type: "sales_order", buyer_order: buyerOrder },
    searchResponseSchema,
  );

  return response.result_list.map((row) => ({
    mkId: row.mk_id,
    countCode: row.count_code ?? null,
    docNumber: row.doc_number ?? null,
  }));
}

/**
 * Where a document lives in MetaKocka's own interface.
 *
 * A link out, deliberately, and one of the few this app has. §2.7 requires the
 * primary workflows to be completable inside the Shopify admin, and they are —
 * this is not a workflow. It is the answer to "let me look at the actual
 * document", which no amount of summarising here replaces, and which a merchant
 * otherwise reaches by searching MetaKocka for a reference they have to copy by
 * hand.
 *
 * The `mk_id` returned by `put_document` is the id this URL takes.
 */
export function metakockaDocumentUrl(mkId: string): string {
  return `https://main.metakocka.si/index.jsp#prodaja_salesorder?id=${encodeURIComponent(mkId)}`;
}
