import { describe, expect, it, vi } from "vitest";

import { MetakockaClient } from "~/adapters/metakocka/client";
import { lookupSalesOrderByBuyerOrder } from "~/adapters/metakocka/documents";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { isDefinitiveRejection } from "~/adapters/db/repositories/order.server";

const CREDENTIALS = { companyId: "6789", secretKey: "test-secret" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof fetch) {
  return new MetakockaClient(CREDENTIALS, { fetchImpl, timeoutMs: 1000 });
}

/**
 * The shape `get_document` answers with, per the live verification of
 * 2026-08-25 (docs/metakocka-verification.md): the whole document at the top
 * level, no list wrapper.
 */
const DOCUMENT_RESPONSE = {
  opr_code: "0",
  mk_id: "1200049884744",
  count_code: "SH-1006-GLAVNO",
  doc_type: "sales_order",
  buyer_order: "SH-1006",
  sum_all: "209,00",
  product_list: [{ code: "SKU-1", amount: "2" }],
};

describe("lookupSalesOrderByBuyerOrder", () => {
  it("asks get_document by buyer_order and returns the document it holds", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DOCUMENT_RESPONSE));

    const found = await lookupSalesOrderByBuyerOrder(
      clientWith(fetchImpl as unknown as typeof fetch),
      "SH-1006",
    );

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    // get_document lives on the no-json base-path family (endpoints.ts).
    expect(url).toBe("https://main.metakocka.si/rest/eshop/v1/get_document");
    expect(JSON.parse(String(init.body))).toMatchObject({
      doc_type: "sales_order",
      buyer_order: "SH-1006",
    });

    expect(found).not.toBeNull();
    expect(found?.mkId).toBe("1200049884744");
    expect(found?.countCode).toBe("SH-1006-GLAVNO");
    // Payment absence must read as "not confirmed", never as confirmed —
    // adoption only records a payment mark on an explicit true.
    expect(found?.hasPayment).not.toBe(true);
  });

  it("reads MetaKocka's 'cannot find' rejection as the definitive absent", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        opr_code: "2",
        opr_desc: "Cannot find document type sales_order with id = null",
      }),
    );

    const found = await lookupSalesOrderByBuyerOrder(
      clientWith(fetchImpl as unknown as typeof fetch),
      "SH-9999",
    );

    expect(found).toBeNull();
  });

  it("lets every other failure escape rather than reading it as absent", async () => {
    // Absent-by-error is what authorises a re-send, so an outage, a 5xx or an
    // unrecognised rejection must throw — treating them as "no document" is
    // exactly the blind retry section 3 forbids.
    const fetchImpl = vi.fn(async () => jsonResponse({ opr_code: "0" }, 503));

    await expect(
      lookupSalesOrderByBuyerOrder(
        clientWith(fetchImpl as unknown as typeof fetch),
        "SH-1006",
      ),
    ).rejects.toBeInstanceOf(MetakockaError);
  });
});

describe("isDefinitiveRejection", () => {
  it("is true only for a recorded validation refusal", () => {
    // The write handler records {oprCode, oprDesc} for a rejection, and the
    // observed validation codes (2, 6, 8) are the ones that prove MetaKocka
    // refused before filing anything.
    expect(
      isDefinitiveRejection({ oprCode: "6", oprDesc: "Profit center..." }),
    ).toBe(true);
    expect(isDefinitiveRejection({ oprCode: "2" })).toBe(true);
    expect(isDefinitiveRejection({ oprCode: "8" })).toBe(true);

    // An unrecognised code is an answer whose consequences nobody has observed
    // — "1 Internal server error" says nothing about whether a document was
    // filed — so it must route through the lookup, not license a re-send.
    expect(isDefinitiveRejection({ oprCode: "1" })).toBe(false);

    // And everything ambiguous carries none: a timeout ({} after undefined
    // keys are dropped), a crash ({error}), or nothing recorded at all.
    expect(isDefinitiveRejection({})).toBe(false);
    expect(isDefinitiveRejection({ error: "AbortError: timeout" })).toBe(false);
    expect(isDefinitiveRejection(null)).toBe(false);
    expect(isDefinitiveRejection(undefined)).toBe(false);
    expect(isDefinitiveRejection({ oprCode: "" })).toBe(false);
    expect(isDefinitiveRejection("failed")).toBe(false);
  });
});
