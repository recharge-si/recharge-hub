import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getSourceAutofill } from "~/adapters/db/repositories/source-autofill.server";
import {
  portalFailure,
  portalFor,
} from "~/adapters/export-portal/service.server";
import { countReviewProducts } from "~/adapters/shopify/review-products";
import { authenticate } from "~/adapters/shopify/shopify.server";
import type { Run, Source } from "~/domain/export-portal/contract";
import {
  changedValues,
  groupFields,
  readFieldValues,
} from "~/domain/export-portal/fields";
import { reviewQuery } from "~/domain/export-portal/review";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { SourceAutofillCard } from "~/web/components/source-autofill-card";
import { EditableCard } from "~/web/components/source-editor";
import {
  AttentionCard,
  RecentRuns,
  SourceSummaryStrip,
  StatusCard,
} from "~/web/components/source-overview";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { useLiveRevalidation, useWatchWindow } from "~/web/lib/live";
import { redirectWithin } from "~/web/lib/redirects";
import {
  SOURCE_ROUTES,
  isRunActive,
  type SourceActionResult,
} from "~/web/lib/sources";
import { readPortal } from "~/web/lib/sources.server";

/**
 * One source (docs/sources.md § Screens): how it is doing, what it is told
 * to do, and its latest runs — read, in cards. Each group of settings the
 * portal described is one card with one Edit button, and the card itself
 * becomes the editor for that group; nothing opens over the page. Saving
 * sends only what changed and shows the portal's refusal against the
 * field.
 */
const HELP_MODAL_ID = "about-source";
const DELETE_MODAL_ID = "delete-source";

type ActionResult = SourceActionResult;

function sourceIdFrom(params: Record<string, string | undefined>): string {
  const id = params.sourceId;
  if (!id) throw new Response("Not found", { status: 404 });
  return id;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const sourceId = sourceIdFrom(params);
  const url = new URL(request.url);
  const [portal, awaitingReview, autofill] = await Promise.all([
    readPortal(principal, async (client) => {
      const [source, runs] = await Promise.all([
        client.getSource(sourceId),
        client.listRuns(sourceId, 25),
      ]);
      return { source, runs };
    }),
    // Drafts this source created that nobody has approved yet
    // (docs/sources.md § Review before publish).
    countReviewProducts(admin, reviewQuery({ sourceId })).catch(() => 0),
    getSourceAutofill(principal, sourceId),
  ]);
  return {
    sourceId,
    portal,
    awaitingReview,
    autofill,
    note: url.searchParams.get("note"),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const sourceId = sourceIdFrom(params);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const known = (value: string): value is ActionResult["intent"] =>
    value === "save" ||
    value === "toggle" ||
    value === "run" ||
    value === "delete";
  if (!known(intent)) {
    return {
      ok: false,
      intent: "save",
      message: "Unknown action.",
    } satisfies ActionResult;
  }

  const access = await portalFor(principal);
  if (!access.ok) {
    return {
      ok: false,
      intent,
      message: access.message,
    } satisfies ActionResult;
  }
  const { client } = access;

  try {
    if (intent === "run") {
      const run = await client.startRun(sourceId);
      await appendEvent(principal, {
        entityType: "export_source",
        entityId: sourceId,
        event: "export_source.run_requested",
        detail: { runId: run.id, actor },
      });
      return {
        ok: true,
        intent,
        message: "Run started in the export portal.",
      } satisfies ActionResult;
    }

    if (intent === "toggle") {
      const enabled = String(formData.get("enabled") ?? "") === "true";
      const source = await client.updateSource(sourceId, { enabled });
      await appendEvent(principal, {
        entityType: "export_source",
        entityId: sourceId,
        event: enabled ? "export_source.enabled" : "export_source.disabled",
        detail: { name: source.name, actor },
      });
      return {
        ok: true,
        intent,
        message: enabled
          ? `${source.name} is on.`
          : `${source.name} is off. It will not run until it is turned on again.`,
      } satisfies ActionResult;
    }

    if (intent === "delete") {
      await client.deleteSource(sourceId);
      await appendEvent(principal, {
        entityType: "export_source",
        entityId: sourceId,
        event: "export_source.deleted",
        detail: { actor },
      });
      return redirectWithin(request, SOURCE_ROUTES.index, {
        note: "The source was deleted in the export portal.",
      });
    }

    // Save: one dialog posts one group of fields, and only those are read.
    // The portal's current description decides how the posted strings are
    // read, so a field added in the portal since the page was opened — or
    // one that lives in another dialog — is simply not in the form and
    // left alone.
    const current = await client.getSource(sourceId);
    const fieldErrors: Record<string, string> = {};
    const nameGiven = formData.has("name");
    const name = String(formData.get("name") ?? "").trim();
    if (nameGiven && name === "") fieldErrors.name = "Give the source a name.";

    const posted = current.fields.filter((field) => formData.has(field.key));
    const read = readFieldValues(posted, (key) => {
      const value = formData.get(key);
      return typeof value === "string" ? value : null;
    });
    for (const problem of read.problems)
      fieldErrors[problem.key] ??= problem.message;
    if (Object.keys(fieldErrors).length > 0) {
      return {
        ok: false,
        intent,
        message: "Some answers are missing or not right. Each one is marked.",
        fieldErrors,
      } satisfies ActionResult;
    }

    const values = changedValues(posted, current.values, read.values);
    const write = {
      ...(nameGiven && name !== current.name ? { name } : {}),
      ...(Object.keys(values).length > 0 ? { values } : {}),
    };
    if (Object.keys(write).length === 0) {
      return {
        ok: true,
        intent,
        message: "Nothing changed.",
      } satisfies ActionResult;
    }

    const saved = await client.updateSource(sourceId, write);
    await appendEvent(principal, {
      entityType: "export_source",
      entityId: sourceId,
      event: "export_source.settings_saved",
      detail: {
        name: saved.name,
        // Which fields changed, never their values: a value may be a secret.
        fields: Object.keys(values),
        actor,
      },
    });
    return { ok: true, intent, message: "Saved." } satisfies ActionResult;
  } catch (error) {
    const failure = portalFailure(error);
    return {
      ok: false,
      intent,
      message: failure.message,
      fieldErrors: failure.fieldErrors,
    } satisfies ActionResult;
  }
};

export default function SourcePage() {
  const { sourceId, portal, awaitingReview, autofill, note } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const result = fetcher.data;
  const running =
    portal.kind === "read" &&
    (isRunActive(portal.data.source.lastRun) ||
      portal.data.runs.some(isRunActive));
  // A run just asked for may not be in the portal's first answer; the page
  // watches closely until it is, then as long as it runs. The rest of the
  // time it still re-reads now and then, so a scheduled run, a changed
  // setting or a growing review count reaches it without a reload.
  const [watching, watch] = useWatchWindow(30_000, running);
  useLiveRevalidation({ active: running || watching });

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
    if (result.intent === "run") watch();
  }, [result]);

  if (portal.kind !== "read") {
    return (
      <s-page heading="Source">
        <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.index}>
          Sources
        </s-link>
        <s-banner tone="warning" heading="The source could not be read">
          <s-stack direction="block" gap="base">
            <s-paragraph>{portal.message}</s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button
                onClick={() => void revalidator.revalidate()}
                {...(revalidator.state !== "idle"
                  ? { disabled: true, loading: true }
                  : {})}
              >
                Try again
              </s-button>
              <s-button href={SOURCE_ROUTES.index}>Back to sources</s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      </s-page>
    );
  }

  return (
    <SourceOverview
      key={sourceId}
      source={portal.data.source}
      runs={portal.data.runs}
      awaitingReview={awaitingReview}
      autofill={autofill}
      note={note}
      fetcher={fetcher}
    />
  );
}

function SourceOverview({
  source,
  runs,
  awaitingReview,
  autofill,
  note,
  fetcher,
}: {
  source: Source;
  runs: Run[];
  awaitingReview: number;
  autofill: { enabled: boolean; fillAttributes: boolean; autoApply: boolean };
  note: string | null;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
}) {
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const busyWith = (intent: string) =>
    busy && fetcher.formData?.get("intent") === intent;
  const running = isRunActive(source.lastRun) || runs.some(isRunActive);

  // The note a redirect carries is a toast, not a banner.
  useEffect(() => {
    if (note && typeof shopify !== "undefined") shopify.toast.show(note);
  }, [note]);

  const submit = (body: Record<string, string>) =>
    void fetcher.submit(body, { method: "post" });

  /*
   * One card per group the portal described, in the portal's order; the
   * fields it did not group become a card of their own. The name is
   * the one thing the portal does not describe as a field, so it has a
   * card of its own.
   */
  const groups = groupFields(source.fields);
  const subheading = [source.kindLabel, source.destination]
    .filter(Boolean)
    .join(" → ");

  return (
    <s-page
      heading={source.name}
      {...(subheading ? { subheading } : {})}
      inlineSize="base"
    >
      <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.index}>
        Sources
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => submit({ intent: "run" })}
        {...(busy || running || !source.enabled ? { disabled: true } : {})}
        {...(busyWith("run") ? { loading: true } : {})}
      >
        Run now
      </s-button>
      {source.portalUrl ? (
        <s-button
          slot="secondary-actions"
          href={source.portalUrl}
          target="_blank"
        >
          Open in portal
        </s-button>
      ) : null}
      <s-button
        slot="secondary-actions"
        onClick={() =>
          submit({
            intent: "toggle",
            enabled: source.enabled ? "false" : "true",
          })
        }
        {...(busy || running ? { disabled: true } : {})}
        {...(busyWith("toggle") ? { loading: true } : {})}
      >
        {source.enabled ? "Turn off" : "Turn on"}
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About this source">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            A source is one product source the export portal pushes into this
            store. This page reads it from the portal as it opens; nothing about
            it is stored in this app.
          </s-paragraph>
          <s-paragraph>
            Each card states one part of the source&apos;s settings. Edit turns
            that card into its editor; nothing changes until the portal has
            accepted the save. Run now starts a run in the portal, and the page
            keeps asking until it has finished.
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

      <ConfirmModal
        id={DELETE_MODAL_ID}
        heading={`Delete ${source.name}?`}
        confirmLabel="Delete source"
        onConfirm={() => submit({ intent: "delete" })}
      >
        <s-paragraph>
          The source and its settings are removed from the export portal.
          Products and stock it has already written to the store are not
          touched.
        </s-paragraph>
      </ConfirmModal>

      <s-stack direction="block" gap="base">
        {result && !result.ok && result.intent !== "save" ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {awaitingReview > 0 ? (
          <s-banner
            tone="info"
            heading={
              awaitingReview === 1
                ? "1 new product from this source is waiting for review"
                : `${awaitingReview.toLocaleString("en")} new products from this source are waiting for review`
            }
          >
            <s-paragraph>
              They are drafts in Shopify and not on sale until someone approves
              them.
            </s-paragraph>
            <s-button
              slot="secondary-actions"
              href={SOURCE_ROUTES.review(source.id)}
            >
              Review them
            </s-button>
          </s-banner>
        ) : null}

        {!source.enabled ? (
          <s-banner tone="info">
            <s-paragraph>
              This source is off. It does not run on its schedule and cannot be
              run by hand until it is turned on.
            </s-paragraph>
          </s-banner>
        ) : null}

        <SourceSummaryStrip source={source} running={running} />

        <EditableCard
          heading="Source details"
          source={source}
          fields={[]}
          editName
          facts={[
            { label: "Name", value: source.name, subdued: false },
            { label: "Kind", value: source.kindLabel, subdued: false },
            ...(source.destination
              ? [
                  {
                    label: "Destination",
                    value: source.destination,
                    subdued: false,
                  },
                ]
              : []),
          ]}
          disabled={busy}
        />

        {groups.map((group, index) => (
          <EditableCard
            key={index}
            heading={group.group ?? "Settings"}
            source={source}
            fields={group.fields}
            disabled={busy}
          />
        ))}

        <RecentRuns source={source} runs={runs} />

        {/*
         * Deletion is the one action a person should have to look for
         * (docs/ui-conventions.md § Element semantics): a line at the end,
         * not a button among the header's. It asks first.
         */}
        <s-section accessibilityLabel="Delete">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
            gap="base"
            alignItems="center"
          >
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">Delete this source</s-text>
              <s-text color="subdued">
                Removes it and its settings from the export portal. What it has
                already written to the store stays.
              </s-text>
            </s-stack>
            <s-stack direction="inline">
              <s-button
                tone="critical"
                command="--show"
                commandFor={DELETE_MODAL_ID}
                {...(busy ? { disabled: true } : {})}
              >
                Delete
              </s-button>
            </s-stack>
          </s-grid>
        </s-section>
      </s-stack>

      {/*
       * Sidebar: what state it is in, what it needs, when it runs. Sticky,
       * so the answer stays beside the cards as they scroll; capped at the
       * viewport and scrolling inside it, so nothing in it is ever out of
       * reach on a short screen. Layout only — every colour and space is
       * Polaris's.
       */}
      <div
        slot="aside"
        style={{
          position: "sticky",
          top: "1rem",
          maxHeight: "calc(100vh - 2rem)",
          overflowY: "auto",
        }}
      >
        <s-stack direction="block" gap="base">
          <StatusCard source={source} runs={runs} running={running} />
          <AttentionCard source={source} />
          <SourceAutofillCard sourceId={source.id} setting={autofill} />
        </s-stack>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
