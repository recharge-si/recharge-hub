/**
 * One place that turns an `event_log` row into words.
 *
 * The log is the permanent audit trail (CLAUDE.md §6) and its rows are named
 * for machines: `inventory.sync_skipped`, `metakocka.credentials_saved`. A
 * merchant should never be shown those. Every screen that displays activity
 * goes through here, so the same event reads the same way everywhere.
 */
export interface DescribedEvent {
  /** What the entry is about, as a heading: a warehouse name, "Catalogue". */
  title: string;
  /** One plain sentence, with the numbers that matter. */
  text: string;
  /** False when a person has to do something about it. */
  ok: boolean;
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function products(n: number): string {
  return n === 1 ? "1 product" : `${n} products`;
}

/** Why a warehouse was skipped, and what to do about it. */
const SKIP_REASONS: Record<string, string> = {
  missing_api_user_email:
    "Add the MetaKocka API user email on the Connection page, then sync again.",
  warehouse_not_found:
    "This warehouse is no longer in MetaKocka. Reload the list, then check the location.",
  nothing_to_sync: "There was nothing to send.",
};

/**
 * The same stock event as `describeEvent`, in a caption's worth of words.
 *
 * The locations list shows one of these under each row, where a sentence would
 * wrap to three lines on a phone and bury the row it belongs to. It is a label,
 * not prose: "27 products updated", never "Updated 27 products in Shopify to
 * match MetaKocka."
 */
export interface BriefEvent {
  text: string;
  ok: boolean;
}

export function describeSyncBriefly(event: {
  event: string;
  detail: unknown;
}): BriefEvent {
  const d = (event.detail ?? {}) as Record<string, unknown>;

  switch (event.event) {
    case "inventory.synced": {
      const changed = count(d.written) + count(d.stocked);
      return {
        text:
          changed === 0 ? "Already up to date" : `${products(changed)} updated`,
        ok: true,
      };
    }

    case "inventory.written_to_metakocka":
      return { text: `${products(count(d.fromShopify))} sent`, ok: true };

    case "inventory.sync_skipped":
      return { text: "Nothing synced", ok: false };

    default:
      return { text: "Synced", ok: true };
  }
}

export function describeEvent(
  event: { event: string; detail: unknown },
  /** Supply source id to warehouse name, when the page has it. */
  names?: Map<string, string>,
  entityId?: string | null,
): DescribedEvent {
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const warehouse =
    (entityId && names?.get(entityId)) ||
    (typeof d.source === "string" ? d.source : null) ||
    "A warehouse";

  switch (event.event) {
    case "inventory.synced": {
      const changed = count(d.written) + count(d.stocked);
      const unchanged = count(d.unchanged);
      return {
        title: warehouse,
        text:
          changed === 0
            ? "Shopify already matched MetaKocka. Nothing needed changing."
            : `Updated ${products(changed)} in Shopify to match MetaKocka.` +
              (unchanged > 0
                ? ` ${products(unchanged)} were already correct.`
                : ""),
        ok: true,
      };
    }

    case "inventory.written_to_metakocka": {
      const sent = count(d.fromShopify);
      const preserved = count(d.preserved);
      return {
        title: warehouse,
        text:
          `Sent stock for ${products(sent)} from Shopify to MetaKocka.` +
          (preserved > 0
            ? ` ${products(preserved)} this app does not manage were left as MetaKocka had them.`
            : ""),
        ok: true,
      };
    }

    case "inventory.sync_skipped": {
      const reason = String(d.reason ?? "");
      return {
        title: warehouse,
        text: `Nothing was synced. ${SKIP_REASONS[reason] ?? `Reported reason: ${reason || "unknown"}.`}`,
        ok: false,
      };
    }

    case "catalogue.synced": {
      const matched = count(d.matched);
      const unmatched = count(d.unmatched);
      return {
        title: "Catalogue",
        text:
          unmatched > 0
            ? `Read ${count(d.variants)} Shopify variants. ${matched} found their MetaKocka product, ${unmatched} did not.`
            : `Read ${count(d.variants)} Shopify variants. All ${matched} found their MetaKocka product.`,
        ok: unmatched === 0,
      };
    }

    case "products.synced": {
      const renamed = count(d.renamed);
      const created = count(d.created);
      const repriced = count(d.repriced);
      const retyped = count(d.retyped);
      const failed = count(d.failed);
      const parts: string[] = [];
      if (renamed > 0) parts.push(`renamed ${products(renamed)}`);
      if (created > 0) parts.push(`created ${products(created)} in MetaKocka`);
      if (repriced > 0) parts.push(`repriced ${products(repriced)}`);
      // Named for the MetaKocka boxes it ticks, because "retyped" reads as a
      // typing correction rather than as Prodajni and Nabavni changing.
      if (retyped > 0)
        parts.push(`changed the product type of ${products(retyped)}`);
      if (parts.length === 0) parts.push("nothing needed changing");

      const summary = `Sent product names to MetaKocka: ${parts.join(", ")}.`;

      /*
       * A count is not a reason.
       *
       * "39 products were rejected by MetaKocka and were left alone" was true
       * and useless: the merchant had deleted a pricelist in MetaKocka, and
       * nothing on the screen connected the two. MetaKocka's `opr_desc` is the
       * only account of the cause that exists (CLAUDE.md §3) and §2.8 wants a
       * message that says what is wrong, so it is quoted rather than counted.
       */
      const stopped =
        typeof d.pricingStopped === "string" && d.pricingStopped.trim() !== ""
          ? d.pricingStopped.trim()
          : null;

      if (stopped) {
        const named =
          typeof d.pricelistCode === "string" && d.pricelistCode.trim() !== ""
            ? `pricelist ${d.pricelistCode.trim()}`
            : "the pricelist";

        return {
          title: "Product sync",
          text:
            `${summary} MetaKocka refused ${named}, so prices were not sent and names went out on their own. ` +
            `MetaKocka said: “${stopped}”. Check the pricelist in the product sync settings.`,
          ok: false,
        };
      }

      if (failed === 0)
        return { title: "Product sync", text: summary, ok: true };

      const reasons = Array.isArray(d.reasons)
        ? (d.reasons as { reason?: unknown; count?: unknown }[])
        : [];
      const leading =
        typeof reasons[0]?.reason === "string" ? reasons[0].reason.trim() : "";

      return {
        title: "Product sync",
        text:
          `${summary} MetaKocka rejected ${products(failed)}, which were left alone.` +
          (leading ? ` It said: “${leading}”.` : ""),
        ok: false,
      };
    }

    case "products.sync_skipped": {
      const reason = String(d.reason ?? "");
      const explained: Record<string, string> = {
        disabled: "Product sync is turned off in the settings.",
        not_connected: "MetaKocka is not connected yet.",
        missing_pricelist_code:
          "Sending prices needs a pricelist code that exists in MetaKocka.",
      };
      return {
        title: "Product sync",
        text: `Nothing was sent. ${explained[reason] ?? `Reported reason: ${reason || "unknown"}.`}`,
        ok: false,
      };
    }

    case "product_sync.settings_saved":
      return {
        title: "Product sync",
        text: d.enabled
          ? "Saved the settings. Product names will be sent to MetaKocka."
          : "Saved the settings. Product names are not being sent.",
        ok: true,
      };

    case "warehouse_mapping.saved": {
      const location = typeof d.location === "string" ? d.location : null;
      const warehouse =
        typeof d.warehouse === "string" ? d.warehouse : String(d.mark ?? "");
      return {
        title: "Locations",
        text: location
          ? `Connected ${location} to ${warehouse}.`
          : `Disconnected ${warehouse} from its location.`,
        ok: true,
      };
    }

    case "supply_defaults.saved": {
      const followed = count(d.updated);
      return {
        title: "Sync defaults",
        text:
          followed === 0
            ? "Saved the defaults. Every location has its own setting."
            : `Saved the defaults. ${followed} ${followed === 1 ? "location follows" : "locations follow"} them.`,
        ok: true,
      };
    }

    case "profit_center.added":
      return {
        title: "Profit centres",
        text: `Added ${String(d.value ?? "")} to the register.`.trim(),
        ok: true,
      };

    case "profit_center.removed":
      return {
        title: "Profit centres",
        text: `Removed ${String(d.value ?? "")} from the register.`.trim(),
        ok: true,
      };

    case "profit_centers.rejected": {
      const values = Array.isArray(d.values) ? d.values.map(String) : [];
      return {
        title: "Profit centres",
        text: `MetaKocka no longer has ${values.join(", ")}. Check the locations using ${values.length === 1 ? "it" : "them"}.`,
        ok: false,
      };
    }

    case "warehouse_mapping.retired": {
      const names = Array.isArray(d.names) ? d.names.map(String) : [];
      return {
        title: "Warehouses",
        text: `${names.join(", ")} ${names.length === 1 ? "is" : "are"} no longer in MetaKocka. Stock sync was turned off for ${names.length === 1 ? "it" : "them"}.`,
        ok: false,
      };
    }

    case "payment_types.saved":
      return {
        title: "Payment types",
        text: `Saved ${count(d.count)} gateway mappings.`,
        ok: true,
      };

    case "metakocka.credentials_saved":
      return {
        title: "MetaKocka",
        text: "Saved the connection details.",
        ok: true,
      };

    case "metakocka.connection_verified":
      return {
        title: "MetaKocka",
        text: "Tested the connection and it worked.",
        ok: true,
      };

    case "metakocka.disconnected":
      return {
        title: "MetaKocka",
        text: "Disconnected, and everything this app held for the store was erased. Nothing in MetaKocka was changed.",
        ok: true,
      };

    case "app.installed":
      return { title: "This app", text: "Installed on this store.", ok: true };

    case "app.scopes_updated":
      return {
        title: "This app",
        text: "The permissions this app holds were updated.",
        ok: true,
      };

    case "app.uninstalled":
      return { title: "This app", text: "Uninstalled.", ok: true };

    case "compliance.customers_data_request":
      return {
        title: "Privacy",
        text: "Shopify asked for a copy of a customer's data.",
        ok: true,
      };

    case "compliance.customers_redact":
      return {
        title: "Privacy",
        text: "Deleted a customer's personal data at Shopify's request.",
        ok: true,
      };

    default:
      // A new event nobody has written a sentence for yet. Showing the raw name
      // is better than hiding that something happened.
      return { title: "Activity", text: event.event, ok: true };
  }
}
