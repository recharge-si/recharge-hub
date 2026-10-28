import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";

import { Dropdown } from "~/web/components/dropdown";
import {
  confidenceLabel,
  sourceLine,
  confidenceTone,
  isAutofillWorking,
  type AutofillView,
} from "~/web/lib/autofill";
import { formatDateTime } from "~/web/lib/datetime";
import type { ProductActionResult } from "~/web/lib/product-actions.server";

/** "Don't change the type": the dropdown's value for keeping what is there. */
const KEEP = "__keep";

/**
 * AI autofill on the product page (docs/attributes.md § AI autofill): ask
 * the export portal's AI for this product's type and the values of its
 * empty attributes, then look the suggestion over and apply it.
 *
 * Made to be read by anyone: the type is one dropdown, set to what the AI
 * suggests and open to any other type; the values are a ticked list; and
 * "Apply and review next" walks through every product that waits, so a
 * person reviewing a batch never goes back to a list between products.
 * Nothing reaches Shopify until applied, and only empty fields are filled.
 */
export function ProductAutofill({
  view,
  available,
  variants,
  dirty,
  types,
  currentTypeId,
  nextReview,
  reviewWaiting,
}: {
  view: AutofillView | null;
  available: { ok: true } | { ok: false; message: string };
  variants: ReadonlyArray<{ variantId: string; title: string }>;
  dirty: boolean;
  types: ReadonlyArray<{ value: string; label: string }>;
  /** The type the product has now, if any. */
  currentTypeId: string | null;
  /** The next product whose suggestion waits, on its Attributes tab. */
  nextReview: string | null;
  reviewWaiting: number;
}) {
  const fetcher = useFetcher<ProductActionResult>();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const working = isAutofillWorking(view);
  const ready = view?.status === "ready";

  const suggestedType =
    view?.typeOrigin === "suggested" ? (view.typeId ?? null) : null;
  const startType = suggestedType ?? KEEP;
  const keys = useMemo(() => view?.values.map((v) => v.key) ?? [], [view]);
  const [typeChoice, setTypeChoice] = useState<string>(startType);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set(keys));
  // A new suggestion starts from what the AI said, everything ticked.
  useEffect(() => {
    setTypeChoice(startType);
    setKept(new Set(keys));
  }, [view?.requestedAt, keys, startType]);

  // "Apply and review next" goes on once the apply has gone through.
  const goNext = useRef(false);
  useEffect(() => {
    if (fetcher.state !== "idle" || !result) return;
    if (result.ok && typeof shopify !== "undefined")
      shopify.toast.show(result.message);
    if (result.ok && goNext.current && nextReview) void navigate(nextReview);
    goNext.current = false;
  }, [fetcher.state, result, nextReview, navigate]);

  const variantTitle = (id: string | null) =>
    id === null
      ? null
      : (variants.find((v) => v.variantId === id)?.title ?? "");
  const perVariant = view?.values.some((v) => v.variantId !== null) ?? false;

  // Values were read for the type the AI chose (or the one the product
  // had); with any other type they would not fit, so they are not offered.
  const valuesType = view?.typeId ?? null;
  const effectiveType =
    typeChoice === KEEP ? currentTypeId : typeChoice || null;
  const valuesFit = valuesType !== null && effectiveType === valuesType;

  const ask = () => fetcher.submit({ intent: "autofill" }, { method: "post" });
  const discard = () =>
    fetcher.submit({ intent: "discard-autofill" }, { method: "post" });
  const apply = (thenNext: boolean) => {
    goNext.current = thenNext;
    const form = new FormData();
    form.set("intent", "apply-autofill");
    form.set("keepType", "false");
    if (typeChoice !== KEEP && typeChoice !== currentTypeId)
      form.set("typeId", typeChoice);
    if (valuesFit) for (const key of kept) form.append("keep", key);
    void fetcher.submit(form, { method: "post" });
  };

  const typeOptions = [
    ...(currentTypeId
      ? [{ value: KEEP, label: "Don't change the type" }]
      : [{ value: KEEP, label: "Leave without a type" }]),
    ...types.map((type) => ({
      value: type.value,
      label:
        type.value === suggestedType
          ? `${type.label} (AI suggestion)`
          : type.label,
    })),
  ];
  const changesSomething =
    (typeChoice !== KEEP && typeChoice !== currentTypeId) ||
    (valuesFit && kept.size > 0);

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
          gap="base"
          alignItems="center"
        >
          <s-stack direction="block" gap="small-500">
            <s-heading>AI suggestion</s-heading>
            <s-text color="subdued">
              {working
                ? "The AI is looking at this product. It takes a moment; you can leave this page."
                : ready
                  ? "Check the type and the values, then apply. Only empty fields are filled."
                  : "Let the AI choose this product's type and fill its empty attributes. You check everything before it is saved."}
            </s-text>
          </s-stack>
          <s-stack direction="inline" gap="small-300">
            {ready ? (
              <s-button onClick={discard} {...(busy ? { disabled: true } : {})}>
                Discard
              </s-button>
            ) : null}
            <s-button
              onClick={ask}
              {...(working ? { loading: true } : {})}
              {...(!available.ok || busy || working ? { disabled: true } : {})}
            >
              {ready || view?.status === "failed"
                ? "Ask again"
                : "Autofill with AI"}
            </s-button>
          </s-stack>
        </s-grid>

        {!available.ok ? (
          <s-text color="subdued">{available.message}</s-text>
        ) : null}

        {result && !result.ok ? (
          <s-banner tone="critical">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {view?.status === "failed" ? (
          <s-banner tone="critical" heading="No suggestion this time">
            <s-paragraph>{view.error ?? "Something went wrong."}</s-paragraph>
          </s-banner>
        ) : null}

        {view &&
        (view.status === "applied" || view.status === "discarded") &&
        view.decidedAt ? (
          <s-text color="subdued">
            {`The last suggestion was ${view.status} ${formatDateTime(view.decidedAt)}.`}
          </s-text>
        ) : null}

        {ready && view ? (
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small-300">
              <Dropdown
                name="autofill-type"
                label="Product type"
                value={typeChoice}
                options={typeOptions}
                onChange={setTypeChoice}
              />
              {suggestedType ? (
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  {confidenceLabel(view.confidence) ? (
                    <s-badge tone={confidenceTone(view.confidence)}>
                      {confidenceLabel(view.confidence) ?? ""}
                    </s-badge>
                  ) : null}
                  {view.reason ? (
                    <s-text color="subdued">{view.reason}</s-text>
                  ) : null}
                </s-stack>
              ) : view.typeId === null ? (
                <s-text color="subdued">
                  {view.reason ??
                    "The AI found no product type that fits. Choose one yourself, or add one to the plan."}
                </s-text>
              ) : null}
              {sourceLine(view) ? (
                <s-text color="subdued">{sourceLine(view) ?? ""}</s-text>
              ) : null}
            </s-stack>

            {view.values.length > 0 && valuesFit ? (
              <s-stack direction="block" gap="small-300">
                <s-text type="strong">Values to fill</s-text>
                <s-table variant="auto">
                  <s-table-header-row>
                    <s-table-header listSlot="inline">
                      <s-checkbox
                        label="Use every value"
                        labelAccessibilityVisibility="exclusive"
                        checked={kept.size === keys.length}
                        onChange={(e) =>
                          setKept(
                            e.currentTarget.checked ? new Set(keys) : new Set(),
                          )
                        }
                      />
                    </s-table-header>
                    <s-table-header listSlot="primary">
                      Attribute
                    </s-table-header>
                    {perVariant ? (
                      <s-table-header listSlot="secondary">
                        Variant
                      </s-table-header>
                    ) : null}
                    <s-table-header listSlot="labeled">Value</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {view.values.map((value) => (
                      <s-table-row key={value.key}>
                        <s-table-cell>
                          <s-checkbox
                            label={`Use ${value.name}`}
                            labelAccessibilityVisibility="exclusive"
                            checked={kept.has(value.key)}
                            onChange={(e) => {
                              const on = e.currentTarget.checked;
                              setKept((now) => {
                                const next = new Set(now);
                                if (on) next.add(value.key);
                                else next.delete(value.key);
                                return next;
                              });
                            }}
                          />
                        </s-table-cell>
                        <s-table-cell>{value.name}</s-table-cell>
                        {perVariant ? (
                          <s-table-cell>
                            <s-text color="subdued">
                              {variantTitle(value.variantId) ?? "All variants"}
                            </s-text>
                          </s-table-cell>
                        ) : null}
                        <s-table-cell>{value.display}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-stack>
            ) : view.values.length > 0 ? (
              <s-text color="subdued">
                The suggested values are for the AI&apos;s type. With another
                type only the type changes; press Ask again afterwards to fill
                that type&apos;s attributes.
              </s-text>
            ) : view.typeId !== null ? (
              <s-text color="subdued">
                No attribute values could be read from this product&apos;s data.
              </s-text>
            ) : null}

            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-button
                variant="primary"
                onClick={() => apply(false)}
                {...(busy ? { loading: true } : {})}
                {...(busy || dirty || !changesSomething
                  ? { disabled: true }
                  : {})}
              >
                Apply
              </s-button>
              {nextReview ? (
                <s-button
                  onClick={() => apply(true)}
                  {...(busy || dirty || !changesSomething
                    ? { disabled: true }
                    : {})}
                >
                  {`Apply and review next (${reviewWaiting - 1} left)`}
                </s-button>
              ) : null}
              {nextReview ? (
                <s-button
                  href={nextReview}
                  {...(busy ? { disabled: true } : {})}
                >
                  Skip
                </s-button>
              ) : null}
              {dirty ? (
                <s-text color="subdued">
                  Save or discard your changes first.
                </s-text>
              ) : null}
            </s-stack>
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}
