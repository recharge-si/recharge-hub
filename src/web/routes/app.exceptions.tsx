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
import {
  listExceptions,
  resolveException,
} from "~/adapters/db/repositories/exception.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { describeExceptionKind } from "~/web/lib/exceptions";
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
 * Nothing here writes to MetaKocka directly. "Retry" re-queues the same job,
 * so the duplicate guard and the warehouse validation still apply.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [open, resolved] = await Promise.all([
    listExceptions(principal, { status: "open" }),
    listExceptions(principal, { status: "resolved", limit: 10 }),
  ]);

  const shape = (rows: Awaited<ReturnType<typeof listExceptions>>) =>
    rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      orderId: row.order?.id ?? null,
      orderNumber: row.order?.shopifyOrderNumber ?? null,
    }));

  return { open: shape(open), resolved: shape(resolved) };
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
          "This exception is not attached to an order, so there is nothing to retry.",
      };
    }

    await enqueue(
      QUEUES.allocateOrder,
      { shopDomain: session.shop, orderId },
      { singletonKey: `allocate:${orderId}:retry:${Date.now()}` },
    );

    return {
      ok: true,
      message:
        "Retrying in the background. The exception clears itself if it succeeds.",
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function Exceptions() {
  const { open, resolved } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <s-page heading="Exceptions">
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

        {open.length === 0 ? (
          <s-section heading="Nothing needs attention">
            <s-paragraph>
              Orders that cannot be allocated or sent to MetaKocka show up here
              with what went wrong and what to do about it.
            </s-paragraph>
          </s-section>
        ) : (
          <s-section
            heading={`${open.length} ${open.length === 1 ? "exception" : "exceptions"} open`}
          >
            <s-stack direction="block" gap="none">
              {open.map((exception, index) => {
                const copy = describeExceptionKind(exception.kind);
                return (
                  <s-box key={exception.id} paddingBlock="base">
                    {index === 0 ? null : (
                      <s-box paddingBlockEnd="base">
                        <s-divider />
                      </s-box>
                    )}

                    <s-stack direction="block" gap="small-300">
                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="center"
                      >
                        <s-badge tone="critical">{copy.label}</s-badge>
                        {exception.orderNumber ? (
                          <s-link href={`/app/orders/${exception.orderId}`}>
                            {`Order ${exception.orderNumber}`}
                          </s-link>
                        ) : null}
                        <s-text color="subdued">
                          {formatDateTime(exception.createdAt)}
                        </s-text>
                      </s-stack>

                      <s-paragraph>{exception.message}</s-paragraph>
                      <s-text color="subdued">{copy.guidance}</s-text>

                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="center"
                      >
                        {exception.orderId ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="retry" />
                            <input
                              type="hidden"
                              name="orderId"
                              value={exception.orderId}
                            />
                            <s-button
                              type="submit"
                              variant="secondary"
                              {...(busy ? { disabled: true } : {})}
                            >
                              Retry
                            </s-button>
                          </Form>
                        ) : null}
                        <Form method="post">
                          <input type="hidden" name="intent" value="resolve" />
                          <input type="hidden" name="id" value={exception.id} />
                          <s-button
                            type="submit"
                            variant="secondary"
                            {...(busy ? { disabled: true } : {})}
                          >
                            Mark resolved
                          </s-button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="ignore" />
                          <input type="hidden" name="id" value={exception.id} />
                          <s-button
                            type="submit"
                            variant="tertiary"
                            {...(busy ? { disabled: true } : {})}
                          >
                            Ignore
                          </s-button>
                        </Form>
                      </s-stack>
                    </s-stack>
                  </s-box>
                );
              })}
            </s-stack>
          </s-section>
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
                  } — ${formatDateTime(exception.createdAt)}`}
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
