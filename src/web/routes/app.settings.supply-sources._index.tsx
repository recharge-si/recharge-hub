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
 * One block per warehouse rather than a form full of fields. The merchant's
 * question is "where does this warehouse go in Shopify, and who owns the
 * numbers"; everything else has a sensible default and lives behind Advanced.
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
        writer: String(source?.inventoryWriter ?? "external"),
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
    otherSources: sources
      .filter((source) => !source.metakockaWarehouse)
      .map((source) => ({
        id: source.id,
        code: source.code,
        name: source.name,
      })),
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
    const writer = String(formData.get(`writer:${mark}`) ?? "external");
    const sourceId = String(formData.get(`sourceId:${mark}`) ?? "").trim();

    // Nothing chosen and nothing stored: leave it alone rather than creating an
    // empty record for every warehouse in the ERP.
    if (!locationId && !sourceId) continue;

    // §7: one writer per location. Two warehouses writing the same Shopify
    // location would fight over the same numbers.
    if (locationId && writer === "metakocka") {
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
      // §7 again: only a warehouse we own may have its stock written by us.
      // Deriving this from the writer choice means the merchant cannot trip
      // that rule and be shown a validation error for it.
      kind: writer === "metakocka" ? "own" : "partner",
      shopifyLocationId: locationId || null,
      inventoryWriter:
        writer === "metakocka"
          ? "metakocka"
          : writer === "manual"
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

interface BlockState {
  locationId: string;
  writer: string;
}

type LoadedWarehouse = {
  mark: string;
  locationId: string;
  writer: string;
};

function toState(warehouses: LoadedWarehouse[]): Record<string, BlockState> {
  return Object.fromEntries(
    warehouses.map((w) => [
      w.mark,
      { locationId: w.locationId, writer: w.writer },
    ]),
  );
}

export default function Warehouses() {
  const { warehouses, locations, syncedAt, otherSources } =
    useLoaderData<typeof loader>();
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
        writer: current[mark]?.writer ?? "external",
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
                  writer: "external",
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
                    <input
                      type="hidden"
                      name={`profitCenter:${warehouse.mark}`}
                      value={warehouse.profitCenter ?? ""}
                    />

                    <s-stack direction="block" gap="base">
                      <s-stack direction="inline" gap="base" alignItems="center">
                        <s-badge tone={connected ? "success" : "neutral"}>
                          {connected ? "Connected" : "Not connected"}
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
                            name={`writer:${warehouse.mark}`}
                            label="Who updates stock in Shopify"
                            details="Only one app or person can own a location's stock. Choose this app only if nothing else already writes it."
                            value={current.writer}
                            onChange={(e) =>
                              set(warehouse.mark, {
                                writer: e.currentTarget.value,
                              })
                            }
                          >
                            <s-option value="metakocka">
                              This app, from MetaKocka
                            </s-option>
                            <s-option value="external">Another app</s-option>
                            <s-option value="manual">A person, by hand</s-option>
                          </s-select>
                        </s-stack>
                      </s-box>

                      {warehouse.sourceId ? (
                        <s-link
                          href={`/app/settings/supply-sources/${warehouse.sourceId}`}
                        >
                          Advanced settings
                        </s-link>
                      ) : (
                        <s-text>
                          Advanced settings appear once this warehouse is saved.
                        </s-text>
                      )}
                    </s-stack>
                  </s-section>
                );
              })}
            </s-stack>
          </Form>
        )}

        {otherSources.length > 0 ? (
          <s-section heading="Set up by hand">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                These are not tied to a warehouse in the list above.
              </s-paragraph>
              <s-unordered-list>
                {otherSources.map((source) => (
                  <s-list-item key={source.id}>
                    <s-link href={`/app/settings/supply-sources/${source.id}`}>
                      {source.code} — {source.name}
                    </s-link>
                  </s-list-item>
                ))}
              </s-unordered-list>
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
