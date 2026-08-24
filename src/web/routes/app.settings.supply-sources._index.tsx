import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  listCachedWarehouses,
  listSupplySources,
  replaceCachedWarehouses,
  upsertSupplySource,
} from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  MetakockaError,
  describeForMerchant,
} from "~/adapters/metakocka/errors";
import { listWarehouses } from "~/adapters/metakocka/warehouses";
import { listLocations } from "~/adapters/shopify/locations";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Connect each MetaKocka warehouse to a Shopify location.
 *
 * One block per warehouse rather than a form full of fields, and no second
 * screen behind it. The merchant answers three things: which Shopify location
 * this warehouse fulfils, which side holds the true stock, and the profit
 * centre orders should carry. Priority, lead time and splitting keep their
 * defaults until allocation exists to use them.
 *
 * The warehouse list comes from our cache, never from MetaKocka during a page
 * load (CLAUDE.md §2.5).
 */

/** Derived from the warehouse mark so nobody has to invent a code. */
function codeForMark(mark: string): string {
  const cleaned = mark
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "SOURCE";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [warehouses, sources, locations] = await Promise.all([
    listCachedWarehouses(principal),
    listSupplySources(principal),
    listLocations(admin),
  ]);

  const sourceByMark = new Map(
    sources
      .filter((source) => source.metakockaWarehouse)
      .map((source) => [source.metakockaWarehouse!, source]),
  );

  return {
    warehouses: warehouses.map((warehouse) => {
      const source = sourceByMark.get(warehouse.mark);
      return {
        mark: warehouse.mark,
        name: warehouse.name,
        isMain: warehouse.isMain,
        isActive: warehouse.isActive,
        sourceId: source?.id ?? null,
        locationId: source?.shopifyLocationId ?? "",
        direction: String(source?.stockDirection ?? "none"),
        profitCenter: source?.metakockaProfitCenter ?? null,
      };
    }),
    locations: locations.map((location) => ({
      id: location.id,
      name: location.name,
      isActive: location.isActive,
      fulfillmentServiceName: location.fulfillmentServiceName,
    })),
    syncedAt: warehouses[0]?.syncedAt.toISOString() ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  if (intent === "refresh") {
    const credential = await getCredential(principal);
    if (!credential) {
      return {
        ok: false,
        message: "Connect MetaKocka first. The warehouse list comes from there.",
      };
    }

    try {
      const client = new MetakockaClient(
        { companyId: credential.companyId, secretKey: credential.secretKey },
        { timeoutMs: 15_000 },
      );
      const warehouses = await listWarehouses(client);

      await replaceCachedWarehouses(
        principal,
        warehouses.map((w) => ({
          mkId: w.mkId,
          mark: w.mark,
          name: w.name,
          isMain: w.isMain,
          isActive: w.isActive,
          includeInStockInfo: w.includeInStockInfo,
        })),
      );

      return {
        ok: true,
        message: `Found ${warehouses.length} ${warehouses.length === 1 ? "warehouse" : "warehouses"} in MetaKocka.`,
      };
    } catch (error) {
      if (error instanceof MetakockaError) {
        return { ok: false, message: describeForMerchant(error) };
      }
      throw error;
    }
  }

  const marks = formData.getAll("mark").map(String);
  const owners = new Map<string, string>();
  let saved = 0;

  for (const mark of marks) {
    const locationId = String(formData.get(`location:${mark}`) ?? "").trim();
    const direction = String(formData.get(`direction:${mark}`) ?? "none");
    const sourceId = String(formData.get(`sourceId:${mark}`) ?? "").trim();

    // Nothing chosen and nothing stored: leave it alone rather than creating an
    // empty record for every warehouse in the ERP.
    if (!locationId && !sourceId) continue;

    // §7: one writer per location. Two warehouses writing the same Shopify
    // location would fight over the same numbers.
    if (locationId && direction === "mk_to_shopify") {
      const already = owners.get(locationId);
      if (already) {
        return {
          ok: false,
          message: `"${already}" and "${mark}" would both write stock to the same Shopify location. Only one warehouse can own a location's stock.`,
        };
      }
      owners.set(locationId, mark);
    }

    await upsertSupplySource(principal, sourceId || null, {
      code: codeForMark(mark),
      name: String(formData.get(`name:${mark}`) ?? mark),
      // Everything in this list is a warehouse of the merchant's own company.
      // A partner source is added by hand on the advanced screen.
      kind: "own",
      shopifyLocationId: locationId || null,
      stockDirection:
        direction === "mk_to_shopify"
          ? "mk_to_shopify"
          : direction === "shopify_to_mk"
            ? "shopify_to_mk"
            : "none",
      // §7 guards our writes into Shopify, so it follows from the direction:
      // only "copy MetaKocka into Shopify" gives this app the pen. Deriving it
      // means the merchant cannot trip that rule and be shown a validation
      // error for a choice they were never offered.
      inventoryWriter:
        direction === "mk_to_shopify"
          ? "metakocka"
          : direction === "shopify_to_mk"
            ? "manual"
            : "external",
      metakockaWarehouse: mark,
      metakockaProfitCenter:
        String(formData.get(`profitCenter:${mark}`) ?? "").trim() || null,
      priority: 100,
      leadTimeDays: 0,
      defaultDeliveryType: null,
      canSplit: true,
      enabled: Boolean(locationId),
    });
    saved += 1;
  }

  await appendEvent(principal, {
    entityType: "supply_source",
    event: "warehouse_mapping.saved",
    detail: { count: saved },
  });

  return {
    ok: true,
    message: `Saved ${saved} ${saved === 1 ? "warehouse" : "warehouses"}.`,
  };
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Plain-language explanation of each direction, shown under the choice. */
const DIRECTION_HELP: Record<string, string> = {
  mk_to_shopify:
    "Stock is counted in MetaKocka. Shopify is updated to match it.",
  shopify_to_mk:
    "Stock is counted in Shopify. MetaKocka is updated to match it.",
  none: "Neither side is updated from the other.",
};

const DIRECTION_BADGE: Record<string, string> = {
  mk_to_shopify: "MetaKocka to Shopify",
  shopify_to_mk: "Shopify to MetaKocka",
  none: "No stock sync",
};

interface BlockState {
  locationId: string;
  direction: string;
  profitCenter: string;
}

type LoadedWarehouse = {
  mark: string;
  locationId: string;
  direction: string;
  profitCenter: string | null;
};

function toState(warehouses: LoadedWarehouse[]): Record<string, BlockState> {
  return Object.fromEntries(
    warehouses.map((w) => [
      w.mark,
      {
        locationId: w.locationId,
        direction: w.direction,
        profitCenter: w.profitCenter ?? "",
      },
    ]),
  );
}

export default function Warehouses() {
  const { warehouses, locations, syncedAt } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const formRef = useRef<HTMLFormElement>(null);

  const [state, setState] = useState<Record<string, BlockState>>(() =>
    toState(warehouses),
  );

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const handleReset = () => setState(toState(warehouses));
    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [warehouses]);

  const set = (mark: string, patch: Partial<BlockState>) =>
    setState((current) => ({
      ...current,
      [mark]: {
        locationId: current[mark]?.locationId ?? "",
        direction: current[mark]?.direction ?? "none",
        profitCenter: current[mark]?.profitCenter ?? "",
        ...patch,
      },
    }));

  return (
    <s-page heading="Warehouses">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-stack direction="block" gap="large">
        {result?.message ? (
          <s-banner tone={result.ok ? "success" : "critical"}>
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Connect your warehouses">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Choose which Shopify location each MetaKocka warehouse fulfils, and
              who keeps the stock numbers up to date.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="center">
              <Form method="post">
                <input type="hidden" name="intent" value="refresh" />
                <s-button
                  type="submit"
                  variant="secondary"
                  {...(busy ? { disabled: true } : {})}
                >
                  Reload from MetaKocka
                </s-button>
              </Form>
              <s-text>
                {syncedAt
                  ? `Last loaded ${formatDateTime(syncedAt)}`
                  : "Not loaded yet"}
              </s-text>
            </s-stack>
          </s-stack>
        </s-section>

        {warehouses.length === 0 ? (
          <s-section heading="No warehouses yet">
            <s-paragraph>
              Reload from MetaKocka to see your warehouses here. If nothing
              appears, check the connection on the Connection page.
            </s-paragraph>
          </s-section>
        ) : (
          <Form method="post" data-save-bar ref={formRef}>
            <input type="hidden" name="intent" value="save" />
            <s-stack direction="block" gap="large">
              {warehouses.map((warehouse) => {
                const current = state[warehouse.mark] ?? {
                  locationId: "",
                  direction: "none",
                  profitCenter: "",
                };
                const connected = current.locationId !== "";

                return (
                  <s-section
                    key={warehouse.mark}
                    heading={`${warehouse.name} (${warehouse.mark})`}
                  >
                    <input type="hidden" name="mark" value={warehouse.mark} />
                    <input
                      type="hidden"
                      name={`sourceId:${warehouse.mark}`}
                      value={warehouse.sourceId ?? ""}
                    />
                    <input
                      type="hidden"
                      name={`name:${warehouse.mark}`}
                      value={warehouse.name}
                    />

                    <s-stack direction="block" gap="base">
                      <s-stack direction="inline" gap="base" alignItems="center">
                        <s-badge
                          tone={
                            connected && current.direction !== "none"
                              ? "success"
                              : "neutral"
                          }
                        >
                          {!connected
                            ? "Not connected"
                            : (DIRECTION_BADGE[current.direction] ??
                              DIRECTION_BADGE.none)}
                        </s-badge>
                        {warehouse.isMain ? (
                          <s-badge tone="info">Main warehouse</s-badge>
                        ) : null}
                        {warehouse.isActive ? null : (
                          <s-badge tone="caution">Inactive in MetaKocka</s-badge>
                        )}
                      </s-stack>

                      <s-box maxInlineSize="520px">
                        <s-stack direction="block" gap="base">
                          <s-select
                            name={`location:${warehouse.mark}`}
                            label="Fulfils this Shopify location"
                            value={current.locationId}
                            onChange={(e) =>
                              set(warehouse.mark, {
                                locationId: e.currentTarget.value,
                              })
                            }
                          >
                            <s-option value="">Not connected</s-option>
                            {locations.map((location) => (
                              <s-option key={location.id} value={location.id}>
                                {location.name}
                                {location.isActive ? "" : " (inactive)"}
                                {location.fulfillmentServiceName
                                  ? ` — ${location.fulfillmentServiceName}`
                                  : ""}
                              </s-option>
                            ))}
                          </s-select>

                          <s-select
                            name={`direction:${warehouse.mark}`}
                            label="Where are the stock numbers counted?"
                            details="Whichever side is counted gets copied to the other. Stock is never copied both ways."
                            value={current.direction}
                            onChange={(e) =>
                              set(warehouse.mark, {
                                direction: e.currentTarget.value,
                              })
                            }
                          >
                            <s-option value="none">Do not sync stock</s-option>
                            <s-option value="mk_to_shopify">
                              MetaKocka to Shopify
                            </s-option>
                            <s-option value="shopify_to_mk">
                              Shopify to MetaKocka
                            </s-option>
                          </s-select>
                          <s-text>{DIRECTION_HELP[current.direction] ?? DIRECTION_HELP.none}</s-text>
                          <s-text-field
                            name={`profitCenter:${warehouse.mark}`}
                            label="Profit centre (optional)"
                            details="Used when orders are sent to MetaKocka. Type it exactly as it appears there; MetaKocka rejects one that does not exist."
                            value={current.profitCenter}
                            onChange={(e) =>
                              set(warehouse.mark, {
                                profitCenter: e.currentTarget.value,
                              })
                            }
                          />
                        </s-stack>
                      </s-box>
                    </s-stack>
                  </s-section>
                );
              })}
            </s-stack>
          </Form>
        )}

      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
