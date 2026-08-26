import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getSupplyDefaults } from "~/adapters/db/repositories/supply-setting.server";
import {
  detachSupplySource,
  listCachedWarehouses,
  listSupplySources,
  upsertSupplySource,
  writerForDirection,
} from "~/adapters/db/repositories/supply-source.server";
import type { Principal } from "~/domain/types";
import { INHERIT, codeForMark, toDirection } from "~/web/lib/locations";

/**
 * Connecting one Shopify location to one MetaKocka warehouse, in one place.
 *
 * The locations page and guided setup both do this, and the rules that hold it
 * together are not the kind worth writing twice: one writer per Shopify
 * location (docs/BUILD_SPEC.md section 7), a location released before another
 * source claims it, and a warehouse validated against the cached list because
 * MetaKocka accepts an unknown mark silently (section 3). A second
 * implementation of any of those is a way to publish the wrong stock.
 */

export interface SaveLocationMappingInput {
  shopifyLocationId: string;
  /** Empty disconnects whatever the location had. */
  warehouseMark: string;
  /** For the audit trail. Falls back to the location id. */
  locationName?: string;
  /** `INHERIT`, or one of the three directions. */
  direction?: string;
  /** `INHERIT`, a profit centre name, or empty for none. */
  profitCenter?: string;
  /**
   * True when the merchant is connecting a warehouse from the "not connected"
   * list rather than editing a location.
   *
   * The two want opposite things from a location that is already taken. Editing
   * location L to use warehouse W is a request to change what L uses, so
   * whatever L had must let go. Connecting W is not: nobody asking to connect a
   * warehouse is asking to disconnect another one, and doing it quietly is how
   * a merchant loses a mapping they never touched.
   */
  viaConnect?: boolean;
}

export type SaveLocationMappingResult =
  { ok: true; message: string } | { ok: false; message: string };

export async function saveLocationMapping(
  principal: Principal,
  input: SaveLocationMappingInput,
): Promise<SaveLocationMappingResult> {
  const locationId = input.shopifyLocationId.trim();
  const mark = input.warehouseMark.trim();

  if (!locationId) {
    return { ok: false, message: "Choose a Shopify location." };
  }

  const [warehouses, sources, defaults] = await Promise.all([
    listCachedWarehouses(principal),
    listSupplySources(principal),
    getSupplyDefaults(principal),
  ]);

  const atLocation =
    sources.find((source) => source.shopifyLocationId === locationId) ?? null;

  // No warehouse chosen: disconnect whatever this location had. The source row
  // survives -- allocations and the audit trail reference it -- but it stops
  // syncing and gives the location up.
  if (!mark) {
    if (atLocation) {
      await detachSupplySource(principal, atLocation.id);
      await appendEvent(principal, {
        entityType: "supply_source",
        entityId: atLocation.id,
        event: "warehouse_mapping.saved",
        detail: {
          mark: atLocation.metakockaWarehouse,
          warehouse: atLocation.name,
          location: null,
        },
      });
    }
    return { ok: true, message: "Disconnected the location." };
  }

  const warehouse = warehouses.find((entry) => entry.mark === mark) ?? null;
  if (!warehouse) {
    return {
      ok: false,
      message:
        "That warehouse is no longer in the list. Reload it and try again.",
    };
  }

  const forWarehouse =
    sources.find((source) => source.metakockaWarehouse === mark) ?? null;

  if (input.viaConnect && atLocation && atLocation.id !== forWarehouse?.id) {
    return {
      ok: false,
      message: `${atLocation.name} already uses that location. Edit the location to change its warehouse.`,
    };
  }

  // Both fields fall back to the shop default unless overridden.
  const directionRaw = input.direction ?? INHERIT;
  const directionInherited = directionRaw === INHERIT;
  const direction = directionInherited
    ? defaults.defaultStockDirection
    : toDirection(directionRaw);

  const profitCenterRaw = input.profitCenter ?? INHERIT;
  const profitCenterInherited = profitCenterRaw === INHERIT;
  const profitCenter = profitCenterInherited
    ? defaults.defaultProfitCenter
    : profitCenterRaw.trim() || null;

  /*
   * Section 7: one writer per Shopify location. Two warehouses publishing into
   * the same location would overwrite each other's numbers.
   *
   * The location's own source is excluded because it is about to be detached,
   * and the warehouse's own source because it is the one being saved. A source
   * whose warehouse MetaKocka no longer has is excluded too: it writes nothing,
   * and blocking on it would name a warehouse the merchant cannot see, let
   * alone turn off.
   */
  if (direction === "mk_to_shopify") {
    const live = new Set(warehouses.map((entry) => entry.mark));
    const clash = sources.find(
      (source) =>
        source.id !== forWarehouse?.id &&
        source.id !== atLocation?.id &&
        source.shopifyLocationId === locationId &&
        source.stockDirection === "mk_to_shopify" &&
        source.metakockaWarehouse !== null &&
        live.has(source.metakockaWarehouse),
    );
    if (clash) {
      return {
        ok: false,
        message: `${clash.name} already writes stock to this location. Turn its sync off first.`,
      };
    }
  }

  // The location is changing hands, so release it before the new source claims
  // it. Two sources holding one location is the state section 7 forbids.
  if (atLocation && atLocation.id !== forWarehouse?.id) {
    await detachSupplySource(principal, atLocation.id);
  }

  await upsertSupplySource(principal, forWarehouse?.id ?? null, {
    code: codeForMark(mark),
    name: warehouse.name,
    // Everything offered here is a warehouse of the merchant's own company.
    // A partner source is added by hand on the advanced screen.
    kind: "own",
    shopifyLocationId: locationId,
    stockDirection: direction,
    stockDirectionInherited: directionInherited,
    // Section 7 guards our writes into Shopify, so the writer follows from the
    // direction rather than being a fourth question the merchant can get wrong.
    inventoryWriter: writerForDirection(direction),
    metakockaWarehouse: mark,
    // The stable id, so a later rename in MetaKocka updates the mark above
    // instead of looking like the warehouse was deleted.
    metakockaWarehouseMkId: warehouse.mkId,
    metakockaProfitCenter: profitCenter,
    profitCenterInherited,
    priority: 100,
    leadTimeDays: 0,
    defaultDeliveryType: null,
    canSplit: true,
    enabled: true,
  });

  await appendEvent(principal, {
    entityType: "supply_source",
    event: "warehouse_mapping.saved",
    detail: {
      mark,
      warehouse: warehouse.name,
      location: input.locationName || locationId,
      direction,
      inherited: directionInherited,
    },
  });

  return { ok: true, message: `Saved ${warehouse.name}.` };
}
