import { z } from "zod";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { mkBoolean } from "~/adapters/metakocka/values";

/**
 * `warehouse_list`, per
 * https://github.com/metakocka/metakocka_api_base/blob/master/docs/warehouse_list.md
 *
 * This is the call behind "Test connection" (CLAUDE.md section 13, M2): it is
 * read-only, needs no arguments beyond the credentials, and proves both that the
 * secret key is valid and that the company ID resolves.
 */
export const warehouseSchema = z
  .object({
    mk_id: z.string(),
    /** The short code the merchant sees. `supply_source.metakocka_warehouse`. */
    mark: z.string(),
    name: z.string(),
    main_warehouse: mkBoolean.optional(),
    include_in_stock_info: mkBoolean.optional(),
    active: mkBoolean.optional(),
    warehouse_type: z.string().optional(),
    show_product_free_stock: mkBoolean.optional(),
  })
  .passthrough();

export const warehouseListResponseSchema = z
  .object({
    warehouse_list: z.array(warehouseSchema).default([]),
  })
  .passthrough();

export type MetakockaWarehouseRaw = z.infer<typeof warehouseSchema>;

/** The shape the rest of the app uses. No MetaKocka string types escape here. */
export interface Warehouse {
  mkId: string;
  mark: string;
  name: string;
  isMain: boolean;
  isActive: boolean;
  includeInStockInfo: boolean;
  warehouseType: string | null;
}

function toWarehouse(raw: MetakockaWarehouseRaw): Warehouse {
  return {
    mkId: raw.mk_id,
    mark: raw.mark,
    name: raw.name,
    isMain: raw.main_warehouse ?? false,
    isActive: raw.active ?? true,
    includeInStockInfo: raw.include_in_stock_info ?? false,
    warehouseType: raw.warehouse_type ?? null,
  };
}

export async function listWarehouses(
  client: MetakockaClient,
): Promise<Warehouse[]> {
  const response = await client.call(
    "warehouse_list",
    {},
    warehouseListResponseSchema,
  );

  return response.warehouse_list.map(toWarehouse);
}
