import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getCatalogueState } from "~/adapters/db/repositories/catalogue.server";
import {
  countVariantStatesFor,
  createCampaign,
  deleteCampaign,
  latestRunsFor,
  listCampaigns,
} from "~/adapters/db/repositories/sale-campaign.server";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES, catalogueSnapshotKey } from "~/adapters/queue/queues";
import { recordCampaignEvent } from "~/adapters/sales/events.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { phaseFor } from "~/domain/sales/lifecycle";
import type { CampaignStatus } from "~/domain/sales/types";
import { formatListDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import {
  PHASE_LABEL,
  STATUS_LABEL,
  describeDiscount,
  formatInZone,
} from "~/web/lib/sales";
import { useLiveRevalidation } from "~/web/lib/live";
import { EMPTY } from "~/web/lib/empty-states";

/**
 * Sale campaigns (docs/sale-campaigns.md § UI): what is on sale, what is
 * about to be, what has finished.
 *
 * A card per campaign, grouped by what it is doing now. Nothing here reads
 * Shopify: counts come from the snapshot rows and the runs, which is what
 * the campaign actually did rather than what the catalogue looks like.
 */
const HELP_MODAL_ID = "about-sales";

const GROUPS: Array<{ status: CampaignStatus[]; heading: string }> = [
  { status: ["active"], heading: "Active" },
  { status: ["scheduled"], heading: "Scheduled" },
  { status: ["paused"], heading: "Paused" },
  { status: ["draft"], heading: "Drafts" },
  { status: ["completed", "cancelled"], heading: "Finished" },
];

const FINISHED_SHOWN = 10;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [campaigns, catalogue] = await Promise.all([
    listCampaigns(principal),
    getCatalogueState(principal),
  ]);
  const ids = campaigns.map((campaign) => campaign.id);
  const [counts, runs] = await Promise.all([
    countVariantStatesFor(ids),
    latestRunsFor(ids),
  ]);
  const timeZone = catalogue.ianaTimezone ?? "UTC";

  const cards = campaigns.map((campaign) => {
    const states = counts.get(campaign.id) ?? {};
    const run = runs.get(campaign.id) ?? null;
    const inProgress =
      run && (run.status === "queued" || run.status === "running")
        ? run.kind === "restore" || run.kind === "release"
          ? ("restore" as const)
          : ("apply" as const)
        : null;
    const onSale = (states.applied ?? 0) + (states.applying ?? 0);
    const failed = (states.failed ?? 0) + (states.restore_failed ?? 0);
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      discount: describeDiscount(
        { type: campaign.discountType, value: campaign.discountValue },
        campaign.currency,
      ),
      startsAt: campaign.startsAt?.toISOString() ?? null,
      endsAt: campaign.endsAt?.toISOString() ?? null,
      completedAt: campaign.completedAt?.toISOString() ?? null,
      phase: phaseFor(campaign.status, states, inProgress),
      onSale,
      failed,
      review: states.review ?? 0,
      // Holds no price — an unused draft, or finished with every price back —
      // so nothing keeps it on the list but the merchant's wish.
      deletable:
        (campaign.status === "draft" && Object.keys(states).length === 0) ||
        ((campaign.status === "completed" || campaign.status === "cancelled") &&
          onSale === 0 &&
          failed === 0 &&
          (states.review ?? 0) === 0 &&
          (states.pending ?? 0) === 0),
      run: run
        ? {
            kind: run.kind,
            status: run.status,
            done: run.done,
            failed: run.failed,
            total: run.total,
          }
        : null,
    };
  });

  return {
    cards,
    timeZone,
    catalogue: {
      snapshotAt: catalogue.snapshotAt?.toISOString() ?? null,
      reading: catalogue.bulkOperationId !== null,
      products: catalogue.products,
      variants: catalogue.variants,
    },
    busy: cards.some(
      (card) => card.run?.status === "queued" || card.run?.status === "running",
    ),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    const catalogue = await getCatalogueState(principal);
    const campaign = await createCampaign(
      principal,
      { name: "New sale", currency: catalogue.currencyCode ?? "EUR" },
      actorFromSession(session),
    );
    await recordCampaignEvent(principal, campaign.id, "sale_campaign.created", {
      by: actorFromSession(session),
    });
    throw redirectWithin(request, `/app/sales/${campaign.id}`);
  }

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    await recordCampaignEvent(principal, id, "sale_campaign.deleted", {
      by: actorFromSession(session),
    });
    const deleted = await deleteCampaign(principal, id);
    return deleted
      ? { ok: true, message: "Campaign deleted." }
      : {
          ok: false,
          message:
            "Only a finished campaign with every price back, or an unused draft, can be deleted.",
        };
  }

  if (intent === "refresh-catalogue") {
    const jobId = await enqueueThrottled(
      QUEUES.catalogueSnapshot,
      { shopDomain: principal.shopDomain },
      catalogueSnapshotKey(principal.shopDomain),
      60,
    );
    return {
      ok: true,
      message: jobId
        ? "Reading the catalogue from Shopify. This takes a few minutes for a large store."
        : "The catalogue is already being read.",
    };
  }

  return { ok: false, message: "Unknown action." };
};

export default function Sales() {
  const { cards, timeZone, catalogue, busy } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  useLiveRevalidation({ active: busy || catalogue.reading, idleEveryMs: null });

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  return (
    <s-page heading="Sales" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        type="button"
        onClick={() => fetcher.submit({ intent: "create" }, { method: "post" })}
        {...(fetcher.state !== "idle" ? { disabled: true, loading: true } : {})}
      >
        Create campaign
      </s-button>

      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About sales">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            A sale campaign changes the prices customers see. It writes each
            variant&apos;s price and compare-at price in Shopify, so every
            theme, feed and channel shows the sale without anything added to the
            storefront, and puts both back exactly when the campaign ends.
          </s-paragraph>
          <s-paragraph>
            It is not a Shopify discount. Discount codes, automatic discounts
            and buy-X-get-Y still apply at checkout on top of the sale price, so
            check Shopify&apos;s discounts before running both on the same
            products.
          </s-paragraph>
          <s-paragraph>
            Campaigns choose products by rules — collections, vendors, tags,
            metafields — and can exclude some. Every price this app changes is
            recorded first, and nothing is written until you activate.
          </s-paragraph>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={HELP_MODAL_ID}
        >
          Close
        </s-button>
      </s-modal>

      <s-query-container>
        <s-stack direction="block" gap="base">
          {result && !result.ok ? (
            <s-banner tone="critical" heading="That did not work">
              <s-paragraph>{result.message}</s-paragraph>
            </s-banner>
          ) : null}

          {catalogue.snapshotAt === null && !catalogue.reading ? (
            <s-banner
              tone="warning"
              heading="The catalogue has not been read yet"
            >
              <s-stack direction="block" gap="small-300">
                <s-paragraph>
                  Campaigns choose products from a copy of the catalogue. Read
                  it once before building a campaign; it stays up to date on its
                  own afterwards.
                </s-paragraph>
                <s-stack direction="inline">
                  <s-button
                    type="button"
                    onClick={() =>
                      fetcher.submit(
                        { intent: "refresh-catalogue" },
                        { method: "post" },
                      )
                    }
                  >
                    Read the catalogue
                  </s-button>
                </s-stack>
              </s-stack>
            </s-banner>
          ) : null}

          {cards.length === 0 ? (
            <s-section>
              <s-box paddingBlock="large-100">
                <s-stack direction="block" gap="base" alignItems="center">
                  <s-heading>{EMPTY.salesNone.heading}</s-heading>
                  <s-text color="subdued">{EMPTY.salesNone.body}</s-text>
                  <s-button
                    variant="primary"
                    type="button"
                    onClick={() =>
                      fetcher.submit({ intent: "create" }, { method: "post" })
                    }
                    {...(fetcher.state !== "idle" ? { disabled: true } : {})}
                  >
                    Create campaign
                  </s-button>
                </s-stack>
              </s-box>
            </s-section>
          ) : null}

          {GROUPS.map((group) => {
            const rows = cards.filter((card) =>
              group.status.includes(card.status),
            );
            if (rows.length === 0) return null;
            const shown =
              group.heading === "Finished"
                ? rows.slice(0, FINISHED_SHOWN)
                : rows;
            return (
              <s-section key={group.heading} padding="none">
                <s-stack direction="block" gap="none">
                  <s-box padding="base">
                    <s-stack
                      direction="inline"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-heading>{group.heading}</s-heading>
                      <s-badge>{rows.length.toLocaleString("en")}</s-badge>
                    </s-stack>
                  </s-box>
                  <s-table variant="auto">
                    <s-table-header-row>
                      <s-table-header listSlot="primary">
                        Campaign
                      </s-table-header>
                      <s-table-header listSlot="inline">Status</s-table-header>
                      <s-table-header listSlot="labeled">
                        Discount
                      </s-table-header>
                      <s-table-header listSlot="labeled">When</s-table-header>
                      <s-table-header listSlot="labeled" format="numeric">
                        Variants
                      </s-table-header>
                      <s-table-header listSlot="inline">
                        <s-text accessibilityVisibility="exclusive">
                          Actions
                        </s-text>
                      </s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {shown.map((card) => {
                        const running =
                          card.run &&
                          (card.run.status === "queued" ||
                            card.run.status === "running");
                        return (
                          <s-table-row
                            key={card.id}
                            clickDelegate={`open-campaign-${card.id}`}
                          >
                            <s-table-cell>
                              <s-stack direction="block" gap="none">
                                <s-link
                                  id={`open-campaign-${card.id}`}
                                  href={`/app/sales/${card.id}`}
                                >
                                  {card.name}
                                </s-link>
                                {running && card.run ? (
                                  <s-text color="subdued">
                                    {`${card.run.kind === "restore" || card.run.kind === "release" ? "Putting prices back" : "Applying sale"}… ${card.run.done.toLocaleString("en")} of ${card.run.total.toLocaleString("en")}`}
                                  </s-text>
                                ) : null}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>
                              <s-stack direction="inline" gap="small-300">
                                <s-badge
                                  {...(card.status === "scheduled"
                                    ? { tone: "info" as const }
                                    : {})}
                                >
                                  {STATUS_LABEL[card.status]}
                                </s-badge>
                                {card.phase !== "idle" &&
                                card.phase !== "applied" ? (
                                  <s-badge
                                    tone={
                                      card.phase === "needs_attention" ||
                                      card.phase === "partially_applied"
                                        ? "critical"
                                        : "info"
                                    }
                                  >
                                    {PHASE_LABEL[card.phase]}
                                  </s-badge>
                                ) : null}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>{card.discount}</s-table-cell>
                            <s-table-cell>
                              <s-text color="subdued">
                                {whenOf(card, timeZone)}
                              </s-text>
                            </s-table-cell>
                            <s-table-cell>
                              <s-stack direction="block" gap="none">
                                <s-text>
                                  {card.status === "active"
                                    ? card.onSale.toLocaleString("en")
                                    : "—"}
                                </s-text>
                                {card.failed > 0 || card.review > 0 ? (
                                  <s-text tone="critical">
                                    {[
                                      card.failed > 0
                                        ? `${card.failed} failed`
                                        : null,
                                      card.review > 0
                                        ? `${card.review} to decide`
                                        : null,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </s-text>
                                ) : null}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>
                              {card.deletable ? (
                                <s-stack
                                  direction="inline"
                                  justifyContent="end"
                                >
                                  <s-button
                                    tone="critical"
                                    accessibilityLabel={`Delete ${card.name}`}
                                    command="--show"
                                    commandFor={`confirm-delete-${card.id}`}
                                    {...(fetcher.state !== "idle"
                                      ? { disabled: true }
                                      : {})}
                                  >
                                    Delete
                                  </s-button>
                                  <ConfirmModal
                                    id={`confirm-delete-${card.id}`}
                                    heading={`Delete “${card.name}”?`}
                                    confirmLabel="Delete"
                                    onConfirm={() =>
                                      fetcher.submit(
                                        { intent: "delete", id: card.id },
                                        { method: "post" },
                                      )
                                    }
                                  >
                                    <s-paragraph>
                                      The campaign, its rules and its price
                                      snapshot are removed. No price in Shopify
                                      changes. This cannot be undone; the
                                      activity trail stays.
                                    </s-paragraph>
                                  </ConfirmModal>
                                </s-stack>
                              ) : null}
                            </s-table-cell>
                          </s-table-row>
                        );
                      })}
                    </s-table-body>
                  </s-table>
                  {rows.length > shown.length ? (
                    <s-box padding="base">
                      <s-text color="subdued">
                        {`Showing the latest ${shown.length} of ${rows.length}.`}
                      </s-text>
                    </s-box>
                  ) : null}
                </s-stack>
              </s-section>
            );
          })}

          <s-section>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-stack direction="block" gap="small-500">
                <s-heading>Catalogue</s-heading>
                <s-text color="subdued">
                  {catalogue.reading
                    ? "Reading the catalogue from Shopify now."
                    : catalogue.snapshotAt
                      ? `${catalogue.products.toLocaleString("en")} products · ${catalogue.variants.toLocaleString("en")} variants · read ${formatListDateTime(catalogue.snapshotAt)}`
                      : "Not read yet."}
                </s-text>
              </s-stack>
              <s-stack direction="inline">
                <s-button
                  type="button"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "refresh-catalogue" },
                      { method: "post" },
                    )
                  }
                  {...(catalogue.reading
                    ? { loading: true, disabled: true }
                    : {})}
                >
                  Read again
                </s-button>
              </s-stack>
            </s-grid>
          </s-section>
        </s-stack>
      </s-query-container>
    </s-page>
  );
}

/** When a campaign runs, in a few words. */
function whenOf(
  card: {
    status: CampaignStatus;
    startsAt: string | null;
    endsAt: string | null;
    completedAt: string | null;
  },
  timeZone: string,
): string {
  switch (card.status) {
    case "active":
      return card.endsAt
        ? `Ends ${formatInZone(card.endsAt, timeZone)}`
        : "No end date";
    case "scheduled":
      return card.startsAt
        ? `Starts ${formatInZone(card.startsAt, timeZone)}`
        : "Scheduled";
    case "paused":
      return "Paused, prices restored";
    case "completed":
      return card.completedAt
        ? `Ended ${formatInZone(card.completedAt, timeZone)}`
        : "Ended";
    case "cancelled":
      return "Cancelled";
    case "draft":
      return "Not activated";
  }
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
