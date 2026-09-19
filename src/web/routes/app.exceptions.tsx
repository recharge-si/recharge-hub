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

import type { ExceptionKind } from "@prisma/client";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  countOpenExceptionsByKind,
  listExceptions,
  listOpenExceptionsByKind,
  resolveException,
} from "~/adapters/db/repositories/exception.server";
import {
  recordExceptionAttempt,
  redriveOrder,
  TARGET_FOR_KIND,
} from "~/adapters/queue/redrive.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { formatDateTime } from "~/web/lib/datetime";
import {
  describeExceptionKind,
  EXCEPTIONS_PAGE_SIZE,
  limitParamFor,
  parseExceptionsLimit,
} from "~/web/lib/exceptions";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * The exceptions queue (CLAUDE.md §11).
 *
 * An exception is a business condition needing a person — not a retryable
 * failure, which the queue handles silently, and not a form validation error.
 * Each row says what happened, what it means and what to do about it, and
 * offers the three things a merchant can actually do: retry it, ignore it, or
 * mark it dealt with.
 *
 * Nothing here writes to MetaKocka directly. "Retry" re-queues the job that
 * answers *this* problem — `redrive.server` decides which — so the duplicate
 * guard and the warehouse validation still apply. It used to re-queue the
 * allocation whatever had gone wrong, which for a rejected sales order meant
 * re-running the one step that had never failed, and the button appeared to do
 * nothing.
 *
 * Most of these never need the button at all. `recheck-exceptions` runs every
 * quarter of an hour, closes the ones that have fixed themselves and re-drives
 * the ones that can now succeed, so what is left here is what genuinely still
 * needs a person.
 */
/** The campaign a sale exception names in its detail, if any. */
function campaignIdOf(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const id = (detail as { campaignId?: unknown }).campaignId;
  return typeof id === "string" && id !== "" ? id : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const url = new URL(request.url);

  const [counts, resolved] = await Promise.all([
    countOpenExceptionsByKind(principal),
    listExceptions(principal, { status: "resolved", limit: 10 }),
  ]);

  const shape = (rows: Awaited<ReturnType<typeof listOpenExceptionsByKind>>) =>
    rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      orderId: row.order?.id ?? null,
      orderNumber: row.order?.shopifyOrderNumber ?? null,
      // A sale campaign's exception belongs to the campaign, not to an order.
      campaignId: campaignIdOf(row.detail),
      // What has already been tried, so a retry that keeps failing stops
      // looking like a button that does not work.
      attempts: row.attempts,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      resolvedBy: row.resolvedBy,
    }));

  /*
   * Grouped by kind, because the guidance is per kind — and paged by kind too.
   *
   * A single limit across every kind, ordered by recency, meant a category
   * with nothing recent in it simply never appeared: its rows existed but
   * never made it into the shared top-N, and there was no "Load more" to find
   * because the category itself was invisible. Every kind with at least one
   * open exception gets its own section and its own `limit_<kind>` page size,
   * so loading more of one never hides or resets another.
   */
  const kinds = [...counts.keys()].sort(
    // Biggest first: the thing that has gone wrong most is the thing worth
    // dealing with first, and it is usually one fix for all of them.
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0),
  );

  const groups = await Promise.all(
    kinds.map(async (kind) => {
      const limit = parseExceptionsLimit(
        url.searchParams.get(limitParamFor(kind)),
      );
      const rows = await listOpenExceptionsByKind(principal, kind, { limit });
      const count = counts.get(kind) ?? 0;
      return {
        kind,
        limit,
        rows: shape(rows),
        count,
        hasMore: rows.length < count,
        // Retrying a whole group only makes sense where a retry does something.
        retryable: TARGET_FOR_KIND[kind] !== "none",
      };
    }),
  );

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  return { groups, total, resolved: shape(resolved) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const id = String(formData.get("id") ?? "");
  const orderId = String(formData.get("orderId") ?? "");

  if (intent === "retry") {
    if (!orderId) {
      return {
        ok: false,
        message:
          "This issue is not attached to an order, so there is nothing to retry.",
      };
    }

    const kind = String(formData.get("kind") ?? "");
    const target =
      kind in TARGET_FOR_KIND
        ? TARGET_FOR_KIND[kind as keyof typeof TARGET_FOR_KIND]
        : "auto";

    const { queued, reason } = await redriveOrder(principal, orderId, target);

    if (queued.length === 0) {
      return {
        ok: false,
        message:
          reason ??
          "There is nothing to retry for this order. Open it to see where it has got to.",
      };
    }

    if (id) await recordExceptionAttempt(principal, id, new Date());

    return {
      ok: true,
      // Says what it is doing, not that it is doing something. A retry that
      // fails the same way is a fact worth being able to see.
      message: `Retrying: ${queued.join(", ")}. This closes itself if it succeeds.`,
    };
  }

  if (intent === "retry-kind" || intent === "resolve-kind") {
    /*
     * Everything of one kind, in one press.
     *
     * The same fix usually clears a whole kind at once — a gateway mapped, a
     * profit centre created, stock delivered — so making the merchant press the
     * same button once per order is asking them to do the app's arithmetic.
     */
    const kind = String(formData.get("kind") ?? "") as ExceptionKind;
    const open = await listOpenExceptionsByKind(principal, kind);
    // Resolving needs nothing but the row; retrying redrives an order, so it
    // only applies to rows that have one. An orderless stock exception used
    // to be excluded from both, which meant it could never be bulk-resolved
    // even though marking it dealt with needs no order at all.
    const mine =
      intent === "resolve-kind" ? open : open.filter((row) => row.order);

    if (mine.length === 0) {
      return { ok: false, message: "There is nothing left of that kind." };
    }

    if (intent === "resolve-kind") {
      for (const row of mine) {
        await resolveException(principal, row.id, {
          status: "resolved",
          by: session.shop,
        });
      }
      return {
        ok: true,
        message: `Marked ${mine.length} ${mine.length === 1 ? "issue" : "issues"} resolved.`,
      };
    }

    const target =
      kind in TARGET_FOR_KIND
        ? TARGET_FOR_KIND[kind as keyof typeof TARGET_FOR_KIND]
        : "auto";

    let queued = 0;
    for (const row of mine) {
      if (!row.order) continue;
      const outcome = await redriveOrder(principal, row.order.id, target);
      if (outcome.queued.length > 0) {
        queued += 1;
        await recordExceptionAttempt(principal, row.id, new Date());
      }
    }

    return {
      ok: queued > 0,
      message:
        queued > 0
          ? `Retrying ${queued} ${queued === 1 ? "order" : "orders"} in the background. Each one clears itself if it succeeds.`
          : "None of those could be retried. Open one to see where it has got to.",
    };
  }

  if (intent === "resolve" || intent === "ignore") {
    await resolveException(principal, id, {
      status: intent === "resolve" ? "resolved" : "ignored",
      // §9: identity comes from the App Bridge session; there is no user table.
      by: session.shop,
    });

    await appendEvent(principal, {
      entityType: "exception",
      entityId: id,
      event: "exception.closed",
      detail: { how: intent },
    });

    return {
      ok: true,
      message:
        intent === "resolve"
          ? "Marked as resolved."
          : "Ignored. It will not come back unless it happens again.",
    };
  }

  return { ok: false, message: "Unknown action." };
};

export default function Exceptions() {
  const { groups, total, resolved } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <s-page heading="Needs attention">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-stack direction="block" gap="large">
        {result ? (
          <s-banner
            tone={result.ok ? "info" : "critical"}
            heading={result.ok ? "Done" : "That did not work"}
          >
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {total === 0 ? (
          <s-section heading="Nothing needs attention">
            <s-paragraph>
              Orders that cannot be allocated or sent to MetaKocka show up here
              with what went wrong and what to do about it.
            </s-paragraph>
            <s-paragraph>
              Everything here is re-checked every fifteen minutes. Anything that
              fixes itself — stock arriving, a product created in MetaKocka, a
              gateway mapped — is retried and cleared without you doing
              anything.
            </s-paragraph>
          </s-section>
        ) : (
          /*
           * One card per kind of problem, not one per exception.
           *
           * Flat, every row repeated the same advice — with four open
           * exceptions, two of them the same kind, the page was already mostly
           * duplicated sentences, and at forty it would be unreadable. The
           * advice belongs to the kind, so it is stated once at the top of the
           * card; the rows underneath say only what differs between them, which
           * is the order and what exactly happened to it.
           *
           * It also makes the useful action obvious. One cause usually explains
           * every row in a card — a gateway nobody mapped, stock that ran out —
           * so the fix is one press for the group rather than one per order.
           */
          <>
            {groups.map((group) => {
              const copy = describeExceptionKind(group.kind);
              const count = group.count;
              const loaded = group.rows.length;

              return (
                <s-section
                  key={group.kind}
                  heading={`${copy.label}${count > 1 ? ` (${count})` : ""}`}
                >
                  <s-stack direction="block" gap="base">
                    <s-text color="subdued">{copy.guidance}</s-text>
                    {group.hasMore ? (
                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="center"
                      >
                        <s-text color="subdued">
                          {`Showing ${loaded} of ${count}.`}
                        </s-text>
                        {/*
                         * Paging is per category: this form's hidden inputs
                         * carry every other visible category's current limit
                         * unchanged, so loading more of this one never resets
                         * or hides another that the merchant already expanded.
                         */}
                        <Form method="get">
                          {groups.map((g) => (
                            <input
                              key={g.kind}
                              type="hidden"
                              name={limitParamFor(g.kind)}
                              value={
                                g.kind === group.kind
                                  ? group.limit + EXCEPTIONS_PAGE_SIZE
                                  : g.limit
                              }
                            />
                          ))}
                          <s-button
                            type="submit"
                            variant="tertiary"
                            {...(busy ? { disabled: true } : {})}
                          >
                            Load more
                          </s-button>
                        </Form>
                      </s-stack>
                    ) : null}

                    {/*
                     * Bulk first, because it is usually the right one. Only shown
                     * when there is more than one: for a single row the buttons
                     * on the row itself say the same thing without the ambiguity
                     * of "all".
                     */}
                    {count > 1 ? (
                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="center"
                      >
                        {group.retryable ? (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="retry-kind"
                            />
                            <input
                              type="hidden"
                              name="kind"
                              value={group.kind}
                            />
                            <s-button
                              type="submit"
                              variant="secondary"
                              {...(busy ? { disabled: true } : {})}
                            >
                              {`Retry all ${count}`}
                            </s-button>
                          </Form>
                        ) : null}
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="resolve-kind"
                          />
                          <input type="hidden" name="kind" value={group.kind} />
                          <s-button
                            type="submit"
                            variant="tertiary"
                            {...(busy ? { disabled: true } : {})}
                          >
                            {`Mark all ${count} resolved`}
                          </s-button>
                        </Form>
                      </s-stack>
                    ) : null}

                    {/*
                     * `variant="auto"` keeps this inside §2.6 at 375px: Polaris
                     * turns the columns into a labelled list rather than letting
                     * the page scroll sideways.
                     */}
                    <s-table variant="auto">
                      <s-table-header-row>
                        <s-table-header listSlot="primary">
                          Order
                        </s-table-header>
                        <s-table-header listSlot="secondary">
                          What happened
                        </s-table-header>
                        <s-table-header listSlot="kicker">Since</s-table-header>
                        <s-table-header listSlot="inline">
                          Actions
                        </s-table-header>
                      </s-table-header-row>

                      <s-table-body>
                        {group.rows.map((exception) => (
                          <s-table-row key={exception.id}>
                            <s-table-cell>
                              {exception.orderNumber && exception.orderId ? (
                                <s-link
                                  href={`/app/orders/${exception.orderId}`}
                                >
                                  {exception.orderNumber}
                                </s-link>
                              ) : exception.campaignId ? (
                                <s-link
                                  href={`/app/sales/${exception.campaignId}/variants`}
                                >
                                  Open campaign
                                </s-link>
                              ) : (
                                <s-text color="subdued">No order</s-text>
                              )}
                            </s-table-cell>

                            <s-table-cell>
                              <s-stack direction="block" gap="small-500">
                                <s-text>{exception.message}</s-text>
                                {/*
                                 * What has already been tried. Without it, an
                                 * exception retried four times looks exactly like
                                 * one nobody has touched — which is why "retry
                                 * does nothing" is the first thing anyone says
                                 * about a queue like this.
                                 */}
                                {exception.attempts > 0 ? (
                                  <s-text color="subdued">
                                    {`Tried ${exception.attempts} ${exception.attempts === 1 ? "time" : "times"}${
                                      exception.lastAttemptAt
                                        ? `, last ${formatDateTime(exception.lastAttemptAt)}`
                                        : ""
                                    }.`}
                                  </s-text>
                                ) : null}
                              </s-stack>
                            </s-table-cell>

                            <s-table-cell>
                              <s-text color="subdued">
                                {formatDateTime(exception.createdAt)}
                              </s-text>
                            </s-table-cell>

                            <s-table-cell>
                              <s-stack direction="inline" gap="small-500">
                                {exception.orderId && group.retryable ? (
                                  <Form method="post">
                                    <input
                                      type="hidden"
                                      name="intent"
                                      value="retry"
                                    />
                                    <input
                                      type="hidden"
                                      name="orderId"
                                      value={exception.orderId}
                                    />
                                    <input
                                      type="hidden"
                                      name="id"
                                      value={exception.id}
                                    />
                                    <input
                                      type="hidden"
                                      name="kind"
                                      value={exception.kind}
                                    />
                                    <s-button
                                      type="submit"
                                      variant="tertiary"
                                      {...(busy ? { disabled: true } : {})}
                                    >
                                      Retry
                                    </s-button>
                                  </Form>
                                ) : null}
                                <Form method="post">
                                  <input
                                    type="hidden"
                                    name="intent"
                                    value="resolve"
                                  />
                                  <input
                                    type="hidden"
                                    name="id"
                                    value={exception.id}
                                  />
                                  <s-button
                                    type="submit"
                                    variant="tertiary"
                                    {...(busy ? { disabled: true } : {})}
                                  >
                                    Resolve
                                  </s-button>
                                </Form>
                                <Form method="post">
                                  <input
                                    type="hidden"
                                    name="intent"
                                    value="ignore"
                                  />
                                  <input
                                    type="hidden"
                                    name="id"
                                    value={exception.id}
                                  />
                                  <s-button
                                    type="submit"
                                    variant="tertiary"
                                    {...(busy ? { disabled: true } : {})}
                                  >
                                    Ignore
                                  </s-button>
                                </Form>
                              </s-stack>
                            </s-table-cell>
                          </s-table-row>
                        ))}
                      </s-table-body>
                    </s-table>
                  </s-stack>
                </s-section>
              );
            })}
          </>
        )}

        {resolved.length > 0 ? (
          <s-section heading="Recently closed">
            <s-stack direction="block" gap="small-300">
              {resolved.map((exception) => (
                <s-text key={exception.id} color="subdued">
                  {`${describeExceptionKind(exception.kind).label}${
                    exception.orderNumber
                      ? ` — order ${exception.orderNumber}`
                      : ""
                  } — ${formatDateTime(exception.createdAt)}${
                    exception.resolvedBy === "app"
                      ? " — cleared automatically once it was fixed"
                      : ""
                  }`}
                </s-text>
              ))}
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
