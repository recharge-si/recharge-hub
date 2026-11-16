import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertClaimResult } from "~/adapters/db/repositories/exception.server";
import { alertLink, formatAlert, isAlertKind } from "~/domain/alerts";

/**
 * Operator alerts (docs/architecture.md § Operator alerts): one Slack message
 * per newly opened severe exception, sent from a job, carrying the kind, the
 * shop, the order number and a link — never the exception's own text. No
 * request ever leaves the test: the fetch is a recorder.
 */

const state = vi.hoisted(() => ({
  webhook: "https://hooks.slack.test/services/T000/B000/secret" as
    string | undefined,
  claim: null as AlertClaimResult | null,
  claims: 0,
  released: [] as string[],
}));

vi.mock("~/adapters/config/env.server", () => ({
  getEnv: () => ({
    ALERT_SLACK_WEBHOOK_URL: state.webhook,
    SHOPIFY_API_KEY: "api-key-123",
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
  }),
}));
vi.mock("~/adapters/db/repositories/exception.server", () => ({
  claimExceptionAlert: async () => {
    state.claims += 1;
    return state.claim;
  },
  releaseExceptionAlert: async (_p: unknown, id: string) => {
    state.released.push(id);
  },
}));

const { handleNotifyException } =
  await import("~/jobs/handlers/notify-exception");

const job = {
  data: { shopDomain: "recharge-test.myshopify.com", exceptionId: "exc_1" },
} as Job<unknown>;

function recorder(
  response: { ok: boolean; status: number; body?: string } = {
    ok: true,
    status: 200,
  },
) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body ?? "",
    };
  };
  return { calls, fetchImpl };
}

beforeEach(() => {
  state.webhook = "https://hooks.slack.test/services/T000/B000/secret";
  state.claim = {
    claimed: true,
    alert: {
      kind: "order_not_transferred",
      orderId: "ord_1006",
      orderNumber: "#1006",
      queue: null,
    },
  };
  state.claims = 0;
  state.released = [];
});

describe("alert kinds and wording", () => {
  it("alerts only the kinds that mean the integration stopped", () => {
    expect(isAlertKind("order_not_transferred")).toBe(true);
    expect(isAlertKind("job_failed")).toBe(true);
    expect(isAlertKind("stock_sync_failed")).toBe(true);
    expect(isAlertKind("sync_inconsistent")).toBe(true);
    expect(isAlertKind("insufficient_stock")).toBe(false);
    expect(isAlertKind("refund_received")).toBe(false);
  });

  it("links to the order inside the Shopify admin, or to Needs attention", () => {
    expect(
      alertLink({
        shopDomain: "recharge-test.myshopify.com",
        apiKey: "k",
        orderId: "ord_1",
      }),
    ).toBe(
      "https://admin.shopify.com/store/recharge-test/apps/k/app/orders/ord_1",
    );
    expect(
      alertLink({
        shopDomain: "recharge-test.myshopify.com",
        apiKey: "k",
        orderId: null,
      }),
    ).toBe(
      "https://admin.shopify.com/store/recharge-test/apps/k/app/exceptions",
    );
  });

  it("says the kind, the shop and the order number, and escapes what Slack reads", () => {
    const text = formatAlert({
      kind: "job_failed",
      shopDomain: "a&b.myshopify.com",
      orderNumber: "1006",
      queue: "write-metakocka-order",
      link: "https://admin.shopify.com/x",
    });
    expect(text).toBe(
      "*Background work stopped*: a&amp;b.myshopify.com order #1006 (write-metakocka-order) · `job_failed` · <https://admin.shopify.com/x|Open in Recharge Hub>",
    );
  });
});

describe("handleNotifyException", () => {
  it("posts one concise message with the order number and link", async () => {
    const { calls, fetchImpl } = recorder();

    await handleNotifyException(job, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(state.webhook);
    const payload = JSON.parse(calls[0]!.body) as { text: string };
    expect(payload.text).toContain("Order not in MetaKocka");
    expect(payload.text).toContain("recharge-test.myshopify.com order #1006");
    expect(payload.text).toContain(
      "https://admin.shopify.com/store/recharge-test/apps/api-key-123/app/orders/ord_1006",
    );
  });

  it("is a no-op without ALERT_SLACK_WEBHOOK_URL, and claims nothing", async () => {
    state.webhook = undefined;
    const { calls, fetchImpl } = recorder();

    await handleNotifyException(job, { fetchImpl });

    expect(calls).toEqual([]);
    expect(state.claims).toBe(0);
  });

  it("sends nothing when the claim is refused (already announced, closed, repeat)", async () => {
    state.claim = { claimed: false, why: "already_alerted" };
    const { calls, fetchImpl } = recorder();

    await handleNotifyException(job, { fetchImpl });

    expect(calls).toEqual([]);
  });

  it("gives the claim back and throws when Slack refuses, so the retry can send it", async () => {
    const { fetchImpl } = recorder({
      ok: false,
      status: 500,
      body: "server error",
    });

    await expect(handleNotifyException(job, { fetchImpl })).rejects.toThrow(
      "Slack refused the alert: HTTP 500",
    );
    expect(state.released).toEqual(["exc_1"]);
  });

  it("never repeats the webhook URL in an error", async () => {
    const { fetchImpl } = recorder({
      ok: false,
      status: 404,
      body: "no_service",
    });

    const error = await handleNotifyException(job, { fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(String(error)).not.toContain("secret");
  });
});
