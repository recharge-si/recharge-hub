import { boundary } from "@shopify/shopify-app-react-router/server";
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
  deleteSupplySource,
  listCachedWarehouses,
  listSupplySources,
  replaceCachedWarehouses,
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
 * Supply sources: the mapping between a MetaKocka warehouse, a Shopify location
 * and the allocation settings for that source (CLAUDE.md §6, M2).
 *
 * The MetaKocka warehouse list is read from our cache, never from MetaKocka
 * during a page load (§2.5). Refreshing it is an explicit action.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [sources, warehouses, locations] = await Promise.all([
    listSupplySources(principal),
    listCachedWarehouses(principal),
    listLocations(admin),
  ]);

  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  return {
    sources: sources.map((source) => ({
      id: source.id,
      code: source.code,
      name: source.name,
      kind: source.kind,
      enabled: source.enabled,
      priority: source.priority,
      canSplit: source.canSplit,
      inventoryWriter: source.inventoryWriter,
      warehouse: source.metakockaWarehouse,
      locationName: source.shopifyLocationId
        ? (locationName.get(source.shopifyLocationId) ?? "Location not found")
        : null,
    })),
    warehouseCount: warehouses.length,
    warehousesSyncedAt: warehouses[0]?.syncedAt.toISOString() ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    await deleteSupplySource(principal, id);
    await appendEvent(principal, {
      entityType: "supply_source",
      entityId: id,
      event: "supply_source.deleted",
    });
    return { ok: true, message: "Supply source removed." };
  }

  if (intent === "refresh-warehouses") {
    const credential = await getCredential(principal);
    if (!credential) {
      return {
        ok: false,
        message:
          "Connect MetaKocka first. The warehouse list comes from your ERP.",
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

      await appendEvent(principal, {
        entityType: "metakocka_warehouse",
        event: "metakocka.warehouses_refreshed",
        detail: { count: warehouses.length },
      });

      return {
        ok: true,
        message: `Warehouse list updated. ${warehouses.length} ${
          warehouses.length === 1 ? "warehouse" : "warehouses"
        } available.`,
      };
    } catch (error) {
      if (error instanceof MetakockaError) {
        return { ok: false, message: describeForMerchant(error) };
      }
      throw error;
    }
  }

  return { ok: false, message: "Unknown action." };
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function SupplySources() {
  const { sources, warehouseCount, warehousesSyncedAt } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <s-page heading="Supply sources">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-stack direction="block" gap="large">
        {result?.message ? (
          <s-banner tone={result.ok ? "success" : "critical"}>
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="MetaKocka warehouses">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {warehouseCount === 0
                ? "No warehouses loaded yet. Refresh to read them from MetaKocka."
                : `${warehouseCount} ${warehouseCount === 1 ? "warehouse" : "warehouses"} available, last read ${
                    warehousesSyncedAt
                      ? formatDateTime(warehousesSyncedAt)
                      : "never"
                  }.`}
            </s-paragraph>
            <s-paragraph>
              MetaKocka accepts a warehouse name that does not exist and files the
              order against the company default instead, so a source can only be
              pointed at a warehouse from this list.
            </s-paragraph>
            <Form method="post">
              <input type="hidden" name="intent" value="refresh-warehouses" />
              <s-button type="submit" {...(busy ? { disabled: true } : {})}>
                Refresh warehouse list
              </s-button>
            </Form>
          </s-stack>
        </s-section>

        <s-section heading="Sources">
          <s-stack direction="block" gap="base">
            {sources.length === 0 ? (
              <s-paragraph>
                No supply sources yet. Add one for each warehouse or partner that
                can fulfil an order.
              </s-paragraph>
            ) : (
              <s-stack direction="block" gap="small">
                {sources.map((source) => (
                  <s-box key={source.id} padding="base" borderWidth="base">
                    <s-stack direction="block" gap="small">
                      <s-stack
                        direction="inline"
                        gap="base"
                        alignItems="center"
                      >
                        <s-link href={`/app/settings/supply-sources/${source.id}`}>
                          {source.code}
                        </s-link>
                        <s-text>{source.name}</s-text>
                        <s-badge
                          tone={source.kind === "own" ? "info" : "neutral"}
                        >
                          {source.kind === "own" ? "Own" : "Partner"}
                        </s-badge>
                        {source.enabled ? null : (
                          <s-badge tone="caution">Disabled</s-badge>
                        )}
                      </s-stack>
                      <s-text>
                        Priority {source.priority}
                        {" · "}
                        Warehouse {source.warehouse ?? "not set"}
                        {" · "}
                        Location {source.locationName ?? "not set"}
                        {" · "}
                        {source.canSplit ? "Splitting allowed" : "No splitting"}
                        {" · "}
                        Inventory written by {source.inventoryWriter}
                      </s-text>
                      <Form method="post">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={source.id} />
                        <s-button
                          type="submit"
                          variant="secondary"
                          tone="critical"
                          {...(busy ? { disabled: true } : {})}
                        >
                          Remove
                        </s-button>
                      </Form>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}

            <s-link href="/app/settings/supply-sources/new">
              Add supply source
            </s-link>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
