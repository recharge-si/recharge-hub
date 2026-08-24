import { describe, expect, it } from "vitest";

import {
  customersDataRequestSchema,
  customersRedactSchema,
  shopRedactSchema,
  webhookJobSchema,
} from "~/adapters/shopify/compliance-payloads";

import dataRequestFixture from "../fixtures/shopify/customers_data_request.json";
import redactFixture from "../fixtures/shopify/customers_redact.json";
import shopRedactFixture from "../fixtures/shopify/shop_redact.json";

describe("compliance webhook payloads", () => {
  it("parses customers/data_request", () => {
    const parsed = customersDataRequestSchema.parse(dataRequestFixture);

    expect(parsed.shop_domain).toBe("test-store.myshopify.com");
    expect(parsed.orders_requested).toHaveLength(3);
    expect(parsed.data_request?.id).toBe(9999);
  });

  it("parses customers/redact", () => {
    const parsed = customersRedactSchema.parse(redactFixture);

    expect(parsed.customer.id).toBe(191167);
    expect(parsed.orders_to_redact).toHaveLength(3);
  });

  it("parses shop/redact", () => {
    const parsed = shopRedactSchema.parse(shopRedactFixture);

    expect(parsed.shop_domain).toBe("test-store.myshopify.com");
  });

  it("keeps unknown fields rather than failing on a new one", () => {
    // Shopify adds fields over time. A strict schema would turn a new field into
    // a failed redaction, which is the one outcome we cannot accept.
    const parsed = shopRedactSchema.parse({
      ...shopRedactFixture,
      some_future_field: "value",
    });

    expect(parsed).toMatchObject({ shop_domain: "test-store.myshopify.com" });
  });

  it("defaults an absent order list to empty", () => {
    const parsed = customersRedactSchema.parse({
      shop_id: 1,
      shop_domain: "test-store.myshopify.com",
      customer: { id: 2 },
    });

    expect(parsed.orders_to_redact).toEqual([]);
  });

  it("rejects a job envelope with no shop", () => {
    expect(() =>
      webhookJobSchema.parse({ webhookId: "abc", topic: "SHOP_REDACT" }),
    ).toThrow();
  });

  it("accepts a complete job envelope", () => {
    const parsed = webhookJobSchema.parse({
      shopDomain: "test-store.myshopify.com",
      webhookId: "b54557e4-bdd9-4b37-8d5f-8b8b1a1b1b1b",
      topic: "SHOP_REDACT",
      payload: shopRedactFixture,
    });

    expect(parsed.shopDomain).toBe("test-store.myshopify.com");
  });
});
