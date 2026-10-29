import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { countReadyAutofills } from "~/adapters/db/repositories/product-autofill.server";
import {
  SOURCE_AUTOFILL_OFF,
  listSourceAutofill,
  setSourceAutofill,
} from "~/adapters/db/repositories/source-autofill.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { activeAttributes } from "~/domain/attributes/resolve";
import { assignableTypes } from "~/domain/products/attribute-values";
import { Dropdown } from "~/web/components/dropdown";
import { SourcesNav } from "~/web/components/sources-nav";
import { LearnMore } from "~/web/components/learn-more";
import { PRODUCT_SETUP_ROUTES, countOf } from "~/web/lib/attributes";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { SOURCE_ROUTES } from "~/web/lib/sources";
import { readPortal } from "~/web/lib/sources.server";

/**
 * AI categorization per source (docs/sources.md § AI categorization per
 * source): which sources' new products the export portal's AI sorts into
 * the store's product types — and whether it also fills the attributes
 * those types need — as they arrive. What it suggests waits on Review for
 * a person, like every AI autofill (docs/attributes.md § AI autofill), or,
 * where a source is set to, a confident suggestion is applied at once.
 *
 * The sources are the portal's, read as the page opens; the switches are
 * this app's, one row per source, saved as each is changed.
 */

const FILL_OPTIONS = [
  { value: "attributes", label: "Product type and attributes" },
  { value: "type", label: "Product type only" },
];

const APPLY_OPTIONS = [
  { value: "auto", label: "Apply when confident" },
  { value: "review", label: "Wait for review" },
];

type Setting = {
  enabled: boolean;
  fillAttributes: boolean;
  autoApply: boolean;
};

/** The setting as posted, or as it is about to be while a save is in flight. */
function settingOf(formData: FormData): Setting {
  return {
    enabled: formData.get("enabled") === "true",
    fillAttributes: formData.get("fillAttributes") !== "false",
    autoApply: formData.get("autoApply") === "true",
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const [portal, settings, { schema }, waiting] = await Promise.all([
    readPortal(principal, (client) => client.listSources()),
    listSourceAutofill(principal),
    getAttributeSchema(principal),
    countReadyAutofills(principal),
  ]);
  const types = assignableTypes(schema);
  const withAttributes = types.filter(
    (type) => activeAttributes(schema, type.id).length > 0,
  ).length;

  return {
    portal:
      portal.kind === "read"
        ? { ok: true as const }
        : { ok: false as const, kind: portal.kind, message: portal.message },
    sources:
      portal.kind === "read"
        ? portal.data.map((source) => ({
            id: source.id,
            name: source.name,
            kindLabel: source.kindLabel,
            destination: source.destination ?? null,
            enabled: source.enabled,
            setting: settings.get(source.id) ?? SOURCE_AUTOFILL_OFF,
          }))
        : [],
    types: types.length,
    typesWithAttributes: withAttributes,
    waiting,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const sourceId = String(formData.get("sourceId") ?? "").trim();
  if (sourceId === "" || sourceId.length > 200)
    return { ok: false as const, message: "No source was chosen." };
  const setting = settingOf(formData);
  await setSourceAutofill(principal, sourceId, setting, actor);
  await appendEvent(principal, {
    entityType: "export_source",
    entityId: sourceId,
    event: "export_source.autofill_changed",
    detail: { ...setting, actor },
  });
  return {
    ok: true as const,
    message: !setting.enabled
      ? "AI categorization is off for this source."
      : setting.autoApply
        ? "New products from this source will be categorized and confident suggestions applied."
        : "New products from this source will be categorized.",
  };
};

type SourceRow = ReturnType<
  typeof useLoaderData<typeof loader>
>["sources"][number];

export default function SourceCategorization() {
  const { portal, sources, types, typesWithAttributes, waiting } =
    useLoaderData<typeof loader>();
  const on = sources.filter((source) => source.setting.enabled).length;
  const ready = portal.ok && types > 0;

  return (
    <s-page heading="AI categorization" inlineSize="large">
      <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.index}>
        Sources
      </s-link>

      <SourcesNav current="categorization" awaitingReview={waiting} />

      <s-query-container>
        <s-stack direction="block" gap="base">
          <s-section>
            <s-stack direction="block" gap="base">
              <s-paragraph>
                When a source creates a product, the export portal&apos;s AI can
                sort it into one of your product types and fill in the
                attributes that type needs, from the product&apos;s title,
                description and the supplier&apos;s own data. Nothing changes in
                Shopify on its own: every suggestion waits on Review until
                someone applies it.
              </s-paragraph>
              <s-stack direction="block" gap="small-300">
                <Check
                  ok={portal.ok}
                  label="Export portal connected"
                  detail={
                    portal.ok ? "Its AI does the categorizing." : portal.message
                  }
                  href={portal.ok ? null : SOURCE_ROUTES.connection}
                  linkLabel="Connection"
                />
                <Check
                  ok={types > 0}
                  label={
                    types > 0
                      ? `${countOf(types, "product type")} to sort into`
                      : "No product types to sort into"
                  }
                  detail={
                    types > 0
                      ? `${countOf(typesWithAttributes, "type")} with attributes to fill.`
                      : "Plan the product types and their attributes under Product setup first."
                  }
                  href={PRODUCT_SETUP_ROUTES.types}
                  linkLabel={types > 0 ? "Product types" : "Plan product types"}
                />
              </s-stack>
            </s-stack>
          </s-section>

          {waiting > 0 ? (
            <s-banner
              tone="info"
              heading={
                waiting === 1
                  ? "1 suggestion is waiting for review"
                  : `${waiting.toLocaleString("en")} suggestions are waiting for review`
              }
            >
              <s-button slot="secondary-actions" href={SOURCE_ROUTES.review()}>
                Review them
              </s-button>
            </s-banner>
          ) : null}

          <s-section heading="Sources">
            {!portal.ok ? (
              <s-text color="subdued">
                The sources could not be read from the export portal.
              </s-text>
            ) : sources.length === 0 ? (
              <s-stack direction="block" gap="small-300" alignItems="start">
                <s-text color="subdued">There are no sources yet.</s-text>
                <s-button href={SOURCE_ROUTES.new}>New source</s-button>
              </s-stack>
            ) : (
              <s-stack direction="block" gap="base">
                <s-text color="subdued">
                  {on === 0
                    ? "No source is categorized yet. Switch on the ones whose new products should be sorted into product types."
                    : `${countOf(on, "source")} of ${sources.length} ${on === 1 ? "is" : "are"} categorized as new products arrive.`}
                </s-text>
                <s-stack direction="block" gap="none">
                  {sources.map((source, index) => (
                    <SourceRowView
                      key={source.id}
                      source={source}
                      disabled={!ready}
                      first={index === 0}
                    />
                  ))}
                </s-stack>
              </s-stack>
            )}
          </s-section>

          <s-section>
            <LearnMore label="How AI categorization works">
              <s-paragraph>
                The export portal tags every product a source creates with the
                source it came from. When Shopify reports such a product created
                and its source is switched on here, the product is sent to the
                portal&apos;s AI with your product types — as full paths, such
                as Windsurf › Sails › Wave sails — and, for the type it picks,
                the attributes that are still empty.
              </s-paragraph>
              <s-paragraph>
                With <s-text type="strong">Apply when confident</s-text>, a
                suggestion is applied as soon as it is made when the AI is at
                least 80% sure of the type, or when the product already had its
                type and only values were suggested. Anything less sure waits on
                Review. With <s-text type="strong">Wait for review</s-text>,
                every suggestion waits for you.
              </s-paragraph>
              <s-paragraph>
                Products a source created before the portal tagged every product
                carry no source, so they are not recognised; categorize them
                from Products with Autofill with AI.
              </s-paragraph>
              <s-paragraph>
                The AI may answer that no type fits; it never forces one. Each
                suggestion shows how sure it is and why, and values are checked
                like a person&apos;s entry: only real options, only numbers
                where a number is asked for, and never over a value that is
                already there. Products already in the store are categorized
                from Review or a product&apos;s Attributes tab with Autofill.
              </s-paragraph>
            </LearnMore>
          </s-section>
        </s-stack>
      </s-query-container>
    </s-page>
  );
}

function Check({
  ok,
  label,
  detail,
  href,
  linkLabel,
}: {
  ok: boolean;
  label: string;
  detail: string;
  href: string | null;
  linkLabel: string;
}) {
  return (
    <s-grid
      gridTemplateColumns="auto 1fr auto"
      gap="small-300"
      alignItems="center"
    >
      <s-icon
        type={ok ? "check-circle" : "alert-circle"}
        tone={ok ? "neutral" : "warning"}
      />
      <s-stack direction="block" gap="none">
        <s-text type="strong">{label}</s-text>
        <s-text color="subdued">{detail}</s-text>
      </s-stack>
      {href ? <s-button href={href}>{linkLabel}</s-button> : <span />}
    </s-grid>
  );
}

/**
 * One source: its switch and, while on, what it fills. Saved as changed,
 * each row with its own request, so two quick changes never cross.
 */
function SourceRowView({
  source,
  disabled,
  first,
}: {
  source: SourceRow;
  disabled: boolean;
  first: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const setting = fetcher.formData
    ? settingOf(fetcher.formData)
    : source.setting;
  const { enabled, fillAttributes, autoApply } = setting;
  const result = fetcher.data;

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      result?.ok &&
      typeof shopify !== "undefined"
    )
      shopify.toast.show(result.message);
  }, [fetcher.state, result]);

  const save = (change: Partial<Setting>) => {
    const next = { ...setting, ...change };
    fetcher.submit(
      {
        sourceId: source.id,
        enabled: String(next.enabled),
        fillAttributes: String(next.fillAttributes),
        autoApply: String(next.autoApply),
      },
      { method: "post", action: SOURCE_ROUTES.categorization },
    );
  };

  const subtitle = [source.kindLabel, source.destination]
    .filter(Boolean)
    .join(" → ");

  return (
    <s-box
      paddingBlock="base"
      {...(first
        ? {}
        : {
            borderWidth: "small none none none",
            borderStyle: "solid none none none",
            borderColor: "subdued",
          })}
    >
      <s-grid
        gridTemplateColumns="@container (inline-size <= 720px) 1fr auto, 1fr auto auto auto"
        gap="base"
        alignItems="center"
      >
        <s-stack direction="block" gap="none">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-link href={SOURCE_ROUTES.source(source.id)}>
              {source.name}
            </s-link>
            {!source.enabled ? <s-badge>Source off</s-badge> : null}
          </s-stack>
          {subtitle ? <s-text color="subdued">{subtitle}</s-text> : null}
        </s-stack>
        {enabled ? (
          <Dropdown
            name={`fill-${source.id}`}
            label="What to fill"
            hideLabel
            value={fillAttributes ? "attributes" : "type"}
            options={FILL_OPTIONS}
            onChange={(value) =>
              save({ fillAttributes: value === "attributes" })
            }
          />
        ) : (
          <s-text color="subdued">Off</s-text>
        )}
        {enabled ? (
          <Dropdown
            name={`apply-${source.id}`}
            label="When to apply"
            hideLabel
            value={autoApply ? "auto" : "review"}
            options={APPLY_OPTIONS}
            onChange={(value) => save({ autoApply: value === "auto" })}
          />
        ) : (
          <span />
        )}
        <s-switch
          label={`Categorize new products from ${source.name}`}
          labelAccessibilityVisibility="exclusive"
          checked={enabled}
          onChange={(event) => save({ enabled: event.currentTarget.checked })}
          {...(disabled && !enabled ? { disabled: true } : {})}
        />
      </s-grid>
      {result && !result.ok ? (
        <s-text tone="critical">{result.message}</s-text>
      ) : null}
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
