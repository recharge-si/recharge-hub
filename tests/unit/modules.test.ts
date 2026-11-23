import { describe, expect, it } from "vitest";

import { QUEUES, queueEnabled } from "~/adapters/queue/queues";
import {
  ALL_MODULES,
  moduleForPath,
  parseModules,
  pathEnabled,
} from "~/domain/modules";
import { APP_NAV, navFor } from "~/web/lib/navigation";

const labels = (items: readonly { label: string }[]) =>
  items.map((item) => item.label);

describe("parseModules", () => {
  it("runs everything when blank or all", () => {
    expect(parseModules(undefined)).toEqual(ALL_MODULES);
    expect(parseModules("")).toEqual(ALL_MODULES);
    expect(parseModules(" ALL ")).toEqual(ALL_MODULES);
  });

  it("runs only the connector for none", () => {
    expect(parseModules("none").size).toBe(0);
  });

  it("reads a list", () => {
    expect([...parseModules("sales, translations")]).toEqual([
      "sales",
      "translations",
    ]);
  });

  it("refuses an unknown name instead of ignoring it", () => {
    expect(() => parseModules("sales,translatoins")).toThrow(/translatoins/);
  });
});

describe("module paths", () => {
  it("maps module pages and leaves the core alone", () => {
    expect(moduleForPath("/app/sales")).toBe("sales");
    expect(moduleForPath("/app/sales/abc/variants")).toBe("sales");
    expect(moduleForPath("/app/products/1")).toBe("catalogue");
    expect(moduleForPath("/app/product-setup/schema.csv")).toBe("catalogue");
    expect(moduleForPath("/app/translations.data")).toBe("translations");
    expect(moduleForPath("/app/sources/connection")).toBe("sources");
    expect(moduleForPath("/app/metakocka/products")).toBeNull();
    expect(moduleForPath("/app/orders")).toBeNull();
    expect(moduleForPath("/app/salesorders")).toBeNull();
  });

  it("closes only what is switched off", () => {
    const none = parseModules("none");
    expect(pathEnabled("/app/sales", none)).toBe(false);
    expect(pathEnabled("/app/orders", none)).toBe(true);
    expect(pathEnabled("/app/sales", ALL_MODULES)).toBe(true);
  });
});

describe("navigation by module", () => {
  it("is unchanged with every module on", () => {
    expect(navFor({ transferOrders: true }, ALL_MODULES)).toEqual(APP_NAV);
  });

  it("shows only the MetaKocka part with none", () => {
    expect(
      labels(navFor({ transferOrders: true }, parseModules("none"))),
    ).toEqual(["Home", "Needs attention", "Orders", "MetaKocka", "Settings"]);
  });
});

describe("queues by module", () => {
  it("drops module queues and keeps core ones", () => {
    const none = parseModules("none");
    expect(queueEnabled(QUEUES.saleProductEvent, none)).toBe(false);
    expect(queueEnabled(QUEUES.translationResourceEvent, none)).toBe(false);
    expect(queueEnabled(QUEUES.sourceProductAutofill, none)).toBe(false);
    expect(queueEnabled(QUEUES.syncOrderState, none)).toBe(true);
    expect(queueEnabled(QUEUES.syncInventory, none)).toBe(true);
  });
});
