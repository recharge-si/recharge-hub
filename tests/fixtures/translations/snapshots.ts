import type {
  SnapshotMenuItem,
  SnapshotProduct,
  StoreSnapshot,
} from "~/domain/translations/snapshot";

/**
 * Three stores that share words and mean different things by them. "Wing",
 * "Foil" and "Kite" are watersports disciplines in the first, an aircraft
 * part, a kitchen consumable and a toy in the others. Nothing in production
 * knows any of these words; the tests show that the store's own data is
 * what decides.
 */

let nextId = 1;

function item(title: string, children: SnapshotMenuItem[] = []): SnapshotMenuItem {
  return {
    id: `gid://shopify/MenuItem/${nextId++}`,
    title,
    type: "COLLECTION",
    resourceId: `gid://shopify/Collection/${nextId}`,
    items: children,
  };
}

function product(
  title: string,
  vendor: string,
  productType: string,
  tags: string[] = [],
  options: SnapshotProduct["options"] = [],
): SnapshotProduct {
  return { id: `gid://shopify/Product/${nextId++}`, title, vendor, productType, tags, options };
}

export const WATERSPORTS_MENU = [
  "All Products",
  "Windsurf",
  "Wing",
  "Foil",
  "SUP",
  "Kite",
  "Neoprene Suits",
  "Clothing",
  "Other",
  "Used",
];

export function watersportsStore(): StoreSnapshot {
  const products: SnapshotProduct[] = [];
  for (let i = 0; i < 12; i += 1) {
    products.push(
      product(`Duotone Wing Unit ${3 + (i % 4)}.0 D/LAB`, "Duotone", "Wing", ["wing", "wingfoil"], [
        { name: "Size", values: ["3.0", "4.0", "5.0"] },
      ]),
      product(`Fanatic Sky Wing ${5 + (i % 3)}'2" Foil Board`, "Fanatic", "Wing", ["wing", "board"]),
      product(`Severne Blade ${4 + (i % 5)}.7 Wave Sail`, "Severne", "Windsurf", ["windsurf", "wave", "sail"]),
      product(`Starboard Kode ${80 + i * 5} Freeride Board`, "Starboard", "Windsurf", ["windsurf", "freeride"]),
      product(`F-One Gravity FCT 1800 Front Wing`, "F-One", "Foil", ["foil", "front wing"]),
      product(`F-One Bandit S${i % 3} Kite`, "F-One", "Kite", ["kite", "freeride"]),
      product(`Starboard Touring ${12 + (i % 2)}'6" Inflatable SUP`, "Starboard", "SUP", ["sup", "touring"]),
      product(`ION Element ${3 + (i % 3)}/2 Neoprene Suit`, "ION", "Neoprene Suits", ["neoprene", "wetsuit"], [
        { name: "Size", values: ["S", "M", "L", "XL"] },
      ]),
      product(`Severne Carbon Mast ${400 + (i % 3) * 30} RDM`, "Severne", "Windsurf", ["windsurf", "mast", "carbon"]),
    );
  }
  return {
    shopName: "Recharge Watersports",
    shopDescription: "Windsurf, wing, foil, SUP and kite gear for the Adriatic coast.",
    primaryLocale: "en",
    menus: [
      {
        id: "gid://shopify/Menu/1",
        handle: "main-menu",
        title: "Main menu",
        items: WATERSPORTS_MENU.map((title) => item(title)),
      },
    ],
    collections: [
      { id: "gid://shopify/Collection/101", title: "Windsurf", description: "Boards, sails, masts and booms.", productsCount: 48 },
      { id: "gid://shopify/Collection/102", title: "Wing", description: "Wings and wing foil boards.", productsCount: 24 },
      { id: "gid://shopify/Collection/103", title: "Foil", description: "Hydrofoils, front wings and masts.", productsCount: 12 },
      { id: "gid://shopify/Collection/104", title: "SUP", description: "Stand-up paddleboards.", productsCount: 12 },
      { id: "gid://shopify/Collection/105", title: "Kite", description: null, productsCount: 12 },
      { id: "gid://shopify/Collection/106", title: "Used", description: "Second-hand gear.", productsCount: 9 },
    ],
    products,
    productsTotal: products.length,
    blogs: [{ id: "gid://shopify/Blog/1", title: "Spot guide" }],
  };
}

export function aviationStore(): StoreSnapshot {
  const products: SnapshotProduct[] = [];
  for (let i = 0; i < 8; i += 1) {
    products.push(
      product(`Cessna 172 Wing Strut Fairing ${i}`, "Cessna", "Airframe parts", ["wing", "fairing"]),
      product(`Piper PA-28 Wing Tip Lens ${i}`, "Piper", "Airframe parts", ["wing", "lighting"]),
      product(`Champion REM40E Spark Plug`, "Champion", "Engine parts", ["engine"]),
      product(`Garmin GTN 650Xi Navigator`, "Garmin", "Avionics", ["avionics", "gps"]),
    );
  }
  return {
    shopName: "Skyward Parts",
    shopDescription: "Certified spare parts for general aviation aircraft.",
    primaryLocale: "en",
    menus: [
      {
        id: "gid://shopify/Menu/2",
        handle: "main-menu",
        title: "Main menu",
        items: [item("Airframe"), item("Wing"), item("Engine"), item("Avionics"), item("Consumables")],
      },
    ],
    collections: [
      { id: "gid://shopify/Collection/201", title: "Wing", description: "Wing struts, tips, fairings and hardware.", productsCount: 16 },
      { id: "gid://shopify/Collection/202", title: "Engine", description: null, productsCount: 8 },
    ],
    products,
    productsTotal: products.length,
    blogs: [],
  };
}

export function kitchenStore(): StoreSnapshot {
  const products: SnapshotProduct[] = [];
  for (let i = 0; i < 8; i += 1) {
    products.push(
      product(`Aluminium Foil Roll ${20 + i * 10}m`, "WrapCo", "Foil & Film", ["foil", "wrap"]),
      product(`Baking Paper ${30 + i}m`, "WrapCo", "Foil & Film", ["baking"]),
      product(`Cast Iron Skillet ${24 + i}cm`, "Lodge", "Cookware", ["cast iron"]),
      product(`Chef Knife ${18 + i}cm`, "Wüsthof", "Knives", ["knife"]),
    );
  }
  return {
    shopName: "Kitchen Corner",
    shopDescription: "Cookware, knives and kitchen consumables.",
    primaryLocale: "en",
    menus: [
      {
        id: "gid://shopify/Menu/3",
        handle: "main-menu",
        title: "Main menu",
        items: [item("Cookware"), item("Knives"), item("Foil & Film"), item("Baking"), item("Sale")],
      },
    ],
    collections: [
      { id: "gid://shopify/Collection/301", title: "Foil & Film", description: "Aluminium foil, cling film, baking paper.", productsCount: 16 },
    ],
    products,
    productsTotal: products.length,
    blogs: [],
  };
}

export function toyStore(): StoreSnapshot {
  const products: SnapshotProduct[] = [];
  for (let i = 0; i < 6; i += 1) {
    products.push(
      product(`Rainbow Delta Kite ${100 + i * 10}cm`, "SkyPlay", "Kites", ["kite", "outdoor"]),
      product(`Wooden Puzzle ${20 + i} pieces`, "Woodly", "Puzzles", ["puzzle"]),
    );
  }
  return {
    shopName: "Little Wonders",
    shopDescription: "Toys for curious children.",
    primaryLocale: "en",
    menus: [
      {
        id: "gid://shopify/Menu/4",
        handle: "main-menu",
        title: "Main menu",
        items: [item("Kites"), item("Puzzles"), item("Outdoor"), item("Sale")],
      },
    ],
    collections: [],
    products,
    productsTotal: products.length,
    blogs: [],
  };
}
