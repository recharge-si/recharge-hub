import type { ReadinessComponent, ReadinessKey } from "~/domain/readiness";
import type { CampaignStatus, VariantState } from "~/domain/sales/types";
import {
  attentionGroups,
  type AttentionArea,
  type AttentionGroup,
} from "~/web/lib/exceptions";

/**
 * What the home page says, decided from state that other pages own
 * (docs/BUILD_SPEC.md § 2.7, docs/ui-conventions.md § Setup state).
 *
 * Nothing here reads anything: the loader gathers readiness, the dashboard
 * figures, the exception counts and the campaign, translation and product
 * sync state, and these functions turn them into the page's rows. A module
 * that is switched off says so in one line — no figures, no timestamp — and
 * readiness is the one place that decides what "off" means.
 */

export interface CampaignFacts {
  id: string;
  name: string;
  status: CampaignStatus;
  discount: string;
  startsAt: string | null;
  endsAt: string | null;
  counts: Partial<Record<VariantState, number>>;
}

export interface SalesOverview {
  /** Live campaigns, most variants on sale first. */
  active: Array<{
    id: string;
    name: string;
    discount: string;
    onSale: number;
    endsAt: string | null;
  }>;
  /** The next campaign due to start, if any. */
  next: { id: string; name: string; discount: string; startsAt: string } | null;
  /** Variants currently at a sale price, across every live campaign. */
  onSale: number;
  /** Variants waiting for a person, across every campaign. */
  needsDecision: number;
  failed: number;
  total: number;
}

/** Sale campaigns as the home page states them: what is live, what is next. */
export function salesOverview(campaigns: CampaignFacts[]): SalesOverview {
  const active = campaigns
    .filter((campaign) => campaign.status === "active")
    .map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      discount: campaign.discount,
      onSale: (campaign.counts.applied ?? 0) + (campaign.counts.applying ?? 0),
      endsAt: campaign.endsAt,
    }))
    .sort((a, b) => b.onSale - a.onSale || a.name.localeCompare(b.name));

  const scheduled = campaigns
    .filter(
      (campaign): campaign is CampaignFacts & { startsAt: string } =>
        campaign.status === "scheduled" && campaign.startsAt !== null,
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const first = scheduled[0];

  let needsDecision = 0;
  let failed = 0;
  for (const campaign of campaigns) {
    needsDecision += campaign.counts.review ?? 0;
    failed +=
      (campaign.counts.failed ?? 0) + (campaign.counts.restore_failed ?? 0);
  }

  return {
    active,
    next: first
      ? {
          id: first.id,
          name: first.name,
          discount: first.discount,
          startsAt: first.startsAt,
        }
      : null,
    onSale: active.reduce((sum, campaign) => sum + campaign.onSale, 0),
    needsDecision,
    failed,
    total: campaigns.length,
  };
}

/** How long ago, in the words a person would use. */
export function ago(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const n = (value: number) => value.toLocaleString("en");

/* -------------------------------------------------------------------------- */
/* Needs attention                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where a readiness component's problem overlaps an exception area. When
 * that area already has a row, the row is the one statement of the problem:
 * the taxes component's "3 orders are held" and the taxes row's 3 are the
 * same fact, and it is stated once.
 */
const AREA_OF_COMPONENT: Partial<Record<ReadinessKey, AttentionArea>> = {
  stock: "inventory",
  taxes: "taxes",
  payments: "payments",
  products: "products",
};

export interface SetupProblem {
  key: ReadinessKey;
  title: string;
  text: string;
  action: { label: string; href: string } | null;
}

export interface HomeAttention {
  /** Configuration that has stopped being true since setup was finished. */
  setup: SetupProblem[];
  /** Open exceptions, one row per area. */
  groups: AttentionGroup[];
  /** Every open exception, for the section heading. */
  total: number;
}

/**
 * Everything that wants a person, as Home lists it.
 *
 * Before Finish setup the setup banner owns readiness, so nothing of it is
 * repeated here; after it, a component that needs attention is a row of its
 * own with the component's own reason and link.
 */
export function homeAttention(
  readiness: { components: ReadinessComponent[]; activated: boolean },
  byKind: ReadonlyArray<{ kind: string; count: number }>,
): HomeAttention {
  const groups = attentionGroups(byKind);
  const covered = new Set(groups.map((group) => group.area));
  const setup = readiness.activated
    ? readiness.components
        .filter((component) => component.status === "needs_attention")
        .filter((component) => {
          const area = AREA_OF_COMPONENT[component.key];
          return !area || !covered.has(area);
        })
        .map((component) => ({
          key: component.key,
          title: component.title,
          text: component.reason ?? component.summary,
          action: component.action,
        }))
    : [];
  return {
    setup,
    groups,
    total: groups.reduce((sum, group) => sum + group.count, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Store operations                                                           */
/* -------------------------------------------------------------------------- */

export interface OperationLine {
  text: string;
  /** Only for a line that states a problem. Healthy is uncoloured. */
  tone?: "critical" | "caution";
}

export interface OperationTile {
  key:
    | "metakocka"
    | "orders"
    | "inventory"
    | "products"
    | "translations"
    | "sales"
    | "rig";
  title: string;
  /** The first line is the area's state; the rest support it. At most three. */
  lines: OperationLine[];
  /** Where the whole tile goes. */
  href: string;
}

/** What the Rig builder tile states; only read when the builder is on. */
export interface RigHomeSummary {
  buildsToday: number;
  /** Explained requests answered in plain wording, of the last `of`. */
  plain: { plain: number; of: number };
  /** The last time the pool answered "every account is full" (ISO). */
  lastExhaustedAt: string | null;
}

/**
 * The Rig builder line: requests today, how often the words fell back to
 * templates, and when the AI pool last ran out. Healthy is calm, so the
 * pool line is only toned when it ran out in the last day.
 */
export function rigTile(summary: RigHomeSummary, now: Date): OperationTile {
  const lines: OperationLine[] = [
    {
      text:
        summary.buildsToday === 0
          ? "No builds today"
          : `${n(summary.buildsToday)} ${summary.buildsToday === 1 ? "build" : "builds"} today`,
    },
  ];
  if (summary.plain.of > 0) {
    const share = Math.round((summary.plain.plain / summary.plain.of) * 100);
    lines.push({
      text: `Plain wording in ${share}% of the last ${summary.plain.of} explanations`,
    });
  }
  if (summary.lastExhaustedAt) {
    const hours =
      (now.getTime() - new Date(summary.lastExhaustedAt).getTime()) / 3_600_000;
    lines.push({
      text: `AI pool was full ${ago(summary.lastExhaustedAt, now)}`,
      ...(hours < 24 ? { tone: "caution" as const } : {}),
    });
  }
  return {
    key: "rig",
    title: "Rig builder",
    href: "/app/product-setup/settings",
    lines,
  };
}

/** The figures Home reads from `getDashboard`, as strings the page can carry. */
export interface HomeFigures {
  counts: {
    receivedToday: number;
    writtenToday: number;
    stockUpdatesToday: number;
    waiting: number;
  };
  lastMetakockaWriteAt: string | null;
  lastStockSyncAt: string | null;
  lastStockSyncOk: boolean | null;
  lastCatalogueMatchAt: string | null;
  lastOrderSyncAt: string | null;
  ordersAwaitingPayment: number;
}

export interface TranslationsFacts {
  /** Whole-store percentage from the coverage count; null before one exists. */
  coverage: number | null;
  /** Languages other than the default one. */
  languages: number;
  syncing: boolean;
  lastSyncAt: string | null;
}

/**
 * The translation summary from the stored coverage count and language
 * settings — never from Shopify, which the Translations page reads live.
 */
export function translationsFacts(input: {
  coverageRows: ReadonlyArray<{
    locale: string;
    fields: number;
    translated: number;
  }>;
  languages: ReadonlyArray<{
    locale: string;
    lastSuccessfulSyncAt: string | null;
  }>;
  activeSyncs: number;
}): TranslationsFacts {
  let fields = 0;
  let translated = 0;
  const locales = new Set<string>();
  for (const row of input.coverageRows) {
    fields += row.fields;
    translated += row.translated;
    locales.add(row.locale);
  }
  for (const language of input.languages) locales.add(language.locale);
  const lastSyncAt = input.languages.reduce<string | null>(
    (latest, language) =>
      language.lastSuccessfulSyncAt &&
      (!latest || language.lastSuccessfulSyncAt > latest)
        ? language.lastSuccessfulSyncAt
        : latest,
    null,
  );
  return {
    coverage: fields === 0 ? null : Math.floor((translated / fields) * 100),
    languages: locales.size,
    syncing: input.activeSyncs > 0,
    lastSyncAt,
  };
}

/**
 * Six summaries, one per part of the store this app runs, two or three facts
 * each. Problems are not counted here — Needs attention states them once —
 * so a tile says what the area is doing and when it last did it.
 */
export function storeOperations(input: {
  components: ReadinessComponent[];
  figures: HomeFigures;
  productSync: { enabled: boolean; lastRunAt: string | null };
  translations: TranslationsFacts;
  sales: SalesOverview;
  /** Present only when the rig builder is on. */
  rig?: RigHomeSummary | null;
  timeZone: string;
  formatDate: (iso: string, timeZone: string) => string;
  now: Date;
}): OperationTile[] {
  const { components, figures, productSync, translations, sales, now } = input;
  const component = (key: ReadinessKey) =>
    components.find((entry) => entry.key === key) ?? null;
  const since = (iso: string | null) => ago(iso, now);
  const tiles: OperationTile[] = [];

  /* MetaKocka: the connection, and the last time anything reached it. */
  const metakocka = component("metakocka");
  if (metakocka) {
    const connected = metakocka.status !== "needs_attention";
    tiles.push({
      key: "metakocka",
      title: "MetaKocka",
      href: connected ? "/app/metakocka" : "/app/settings/metakocka",
      lines: [
        { text: metakocka.summary },
        ...(connected
          ? [
              {
                text: figures.lastMetakockaWriteAt
                  ? `Last sent ${since(figures.lastMetakockaWriteAt)}`
                  : "Nothing sent yet",
              },
            ]
          : []),
      ],
    });
  }

  /* Orders: today's intake, what is still waiting, when Shopify was checked. */
  const orders = component("orders");
  if (orders) {
    const lines: OperationLine[] = [];
    let href = "/app/orders";
    if (orders.status === "disabled") {
      lines.push({ text: "Order transfer is off" });
      href = "/app/orders/settings";
    } else if (orders.status === "needs_attention") {
      lines.push({ text: orders.summary });
    } else {
      const { receivedToday, writtenToday, waiting } = figures.counts;
      lines.push({
        text:
          receivedToday === 0
            ? "No orders today"
            : `${n(receivedToday)} received today · ${n(writtenToday)} sent`,
      });
      const payments = component("payments");
      if (
        payments &&
        payments.status !== "disabled" &&
        figures.ordersAwaitingPayment > 0
      ) {
        lines.push({
          text: `${n(figures.ordersAwaitingPayment)} paid, payment not yet in MetaKocka`,
          tone: "critical",
        });
      } else if (waiting > 0) {
        lines.push({ text: `${n(waiting)} waiting to be sent` });
      }
      lines.push({
        text: `Checked with Shopify ${since(figures.lastOrderSyncAt)}`,
      });
    }
    tiles.push({ key: "orders", title: "Orders", href, lines });
  }

  /* Inventory: the direction, the last run and its result, today's moves. */
  const stock = component("stock");
  const warehouses = component("warehouses");
  if (stock) {
    const lines: OperationLine[] = [];
    if (stock.status === "disabled" || figures.lastStockSyncAt === null) {
      lines.push({ text: stock.summary });
      if (warehouses) lines.push({ text: warehouses.summary });
    } else {
      lines.push({ text: stock.summary });
      lines.push(
        figures.lastStockSyncOk === false
          ? {
              text: `Last run failed, ${since(figures.lastStockSyncAt)}`,
              tone: "caution",
            }
          : { text: `Synced ${since(figures.lastStockSyncAt)}` },
      );
      if (figures.counts.stockUpdatesToday > 0) {
        const updated = figures.counts.stockUpdatesToday;
        lines.push({
          text: `${n(updated)} ${updated === 1 ? "product" : "products"} updated today`,
        });
      }
    }
    tiles.push({
      key: "inventory",
      title: "Inventory",
      href: "/app/metakocka/locations",
      lines,
    });
  }

  /* Products: the match, when it was made, and whether names are sent. */
  const products = component("products");
  if (products) {
    tiles.push({
      key: "products",
      title: "Products",
      href: "/app/metakocka/products",
      lines: [
        { text: products.summary },
        ...(figures.lastCatalogueMatchAt
          ? [{ text: `Matched ${since(figures.lastCatalogueMatchAt)}` }]
          : []),
        {
          text: productSync.enabled
            ? productSync.lastRunAt
              ? `Names sent ${since(productSync.lastRunAt)}`
              : "Names not sent yet"
            : "Name sync is off",
        },
      ],
    });
  }

  /* Translations: how much of the store is translated, and the last sync. */
  tiles.push({
    key: "translations",
    title: "Translations",
    href: "/app/translations",
    lines:
      translations.languages === 0
        ? [{ text: "No languages added" }]
        : [
            {
              text: `${translations.coverage === null ? "Not counted yet" : `${translations.coverage}% translated`} · ${translations.languages} ${translations.languages === 1 ? "language" : "languages"}`,
            },
            {
              text: translations.syncing
                ? "Syncing now"
                : translations.lastSyncAt
                  ? `Last sync ${since(translations.lastSyncAt)}`
                  : "Not synced yet",
            },
          ],
  });

  /* Sales: what is live, or what starts next. */
  const [live, ...alsoLive] = sales.active;
  const date = (iso: string) => input.formatDate(iso, input.timeZone);
  if (live) {
    tiles.push({
      key: "sales",
      title: "Sales",
      href: alsoLive.length > 0 ? "/app/sales" : `/app/sales/${live.id}`,
      lines: [
        { text: live.name },
        {
          text: `${n(live.onSale)} ${live.onSale === 1 ? "variant" : "variants"} on sale · ${live.endsAt ? `ends ${date(live.endsAt)}` : "no end date"}`,
        },
        ...(alsoLive.length > 0
          ? [
              {
                text: `${alsoLive.length} more ${alsoLive.length === 1 ? "campaign" : "campaigns"} live`,
              },
            ]
          : sales.next
            ? [
                {
                  text: `Next: ${sales.next.name}, ${date(sales.next.startsAt)}`,
                },
              ]
            : []),
      ],
    });
  } else {
    tiles.push({
      key: "sales",
      title: "Sales",
      href: sales.next ? `/app/sales/${sales.next.id}` : "/app/sales",
      lines: sales.next
        ? [
            { text: "No active campaign" },
            { text: `${sales.next.name} starts ${date(sales.next.startsAt)}` },
          ]
        : [{ text: "No active campaign" }],
    });
  }

  if (input.rig) tiles.push(rigTile(input.rig, now));

  return tiles.map((tile) => ({ ...tile, lines: tile.lines.slice(0, 3) }));
}
