import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { test as base, expect } from "@playwright/test";

import { prisma } from "~/adapters/db/client.server";

import type {
  MetakockaCompany,
  RecordedCall,
  ResetRequest,
  ShopifyStore,
} from "../fake-services/state";
import { BASE_URL, FAKE_SERVICES_URL, SHOP_COOKIE } from "./env";
import { settleJobs } from "./jobs";

/**
 * `test` for e2e specs. Every test gets:
 *
 *  - `shop`: a fresh tenant of its own — a `shop` row in the e2e database, an
 *    empty store in the fake services, and the cookie that signs the browser
 *    in as it. Specs add what they need with the seed helpers. Afterwards the
 *    shop is deleted, and every tenant table cascades from it, so nothing a
 *    test wrote outlives it;
 *  - App Bridge replaced by tests/e2e/support/app-bridge-stub.js;
 *  - checks after the test: no uncaught error in the page, no background job
 *    of the shop's that failed (the test waits for its jobs to settle), and
 *    no call to the fake services that nobody wrote a handler for.
 */

const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
const appBridgeStub = readFileSync(
  fileURLToPath(new URL("./app-bridge-stub.js", import.meta.url)),
  "utf8",
);

export interface TestShop {
  id: string;
  domain: string;
  /** The MetaKocka company id the fake MetaKocka answers for this shop. */
  metakockaCompanyId: string;
  /** Replaces the shop's fake Shopify store and MetaKocka company. */
  resetServices(
    request?: Omit<ResetRequest, "metakockaCompanyId">,
  ): Promise<void>;
  /** Every call the fake services received for this shop. */
  calls(): Promise<RecordedCall[]>;
  /** The fake store and company as they are now, after whatever wrote to them. */
  services(): Promise<{ shopify: ShopifyStore; metakocka: MetakockaCompany }>;
  /**
   * Waits for the shop's background jobs to finish and fails on any that
   * failed. The fixture does this after every test anyway; a spec calls it to
   * look at what the jobs did.
   */
  settleJobs(): Promise<void>;
}

async function resetServices(
  domain: string,
  request: ResetRequest = {},
): Promise<void> {
  const response = await fetch(
    `${FAKE_SERVICES_URL}/__shops/${encodeURIComponent(domain)}/reset`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok)
    throw new Error(`fake services reset: ${await response.text()}`);
}

async function recordedCalls(domain: string): Promise<RecordedCall[]> {
  const response = await fetch(
    `${FAKE_SERVICES_URL}/__shops/${encodeURIComponent(domain)}/calls`,
  );
  const calls = (await response.json()) as RecordedCall[] | null;
  return calls ?? [];
}

export const test = base.extend<{ shop: TestShop }>({
  shop: async ({ context }, use) => {
    const id = randomUUID().slice(0, 8);
    const domain = `e2e-${id}.myshopify.com`;
    const metakockaCompanyId = `e2e-company-${id}`;
    const row = await prisma.shop.create({
      data: { domain },
      select: { id: true },
    });
    const reset = (request: Omit<ResetRequest, "metakockaCompanyId"> = {}) =>
      resetServices(domain, { ...request, metakockaCompanyId });
    await reset();

    await context.addCookies([
      { name: SHOP_COOKIE, value: domain, url: BASE_URL },
    ]);
    await context.route(APP_BRIDGE_URL, (route) =>
      route.fulfill({ contentType: "text/javascript", body: appBridgeStub }),
    );

    await use({
      id: row.id,
      domain,
      metakockaCompanyId,
      resetServices: reset,
      calls: () => recordedCalls(domain),
      services: async () => {
        const response = await fetch(
          `${FAKE_SERVICES_URL}/__shops/${encodeURIComponent(domain)}/state`,
        );
        return (await response.json()) as {
          shopify: ShopifyStore;
          metakocka: MetakockaCompany;
        };
      },
      settleJobs: async () => {
        expect(
          await settleJobs(domain),
          "background jobs of this shop that failed",
        ).toEqual([]);
      },
    });

    const failedJobs = await settleJobs(domain);
    const calls = await recordedCalls(domain);
    await prisma.shop.delete({ where: { id: row.id } });

    expect(failedJobs, "background jobs of this shop that failed").toEqual([]);

    const unhandled = calls.filter((call) => !call.handled);
    expect(
      unhandled.map((call) => `${call.service}: ${call.operation}`),
      "calls the fake services have no handler for (add one in tests/e2e/fake-services)",
    ).toEqual([]);
  },

  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    await use(page);
    expect(errors, "uncaught errors in the page").toEqual([]);
  },
});

export { expect };
