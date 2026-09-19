import { Dropdown } from "~/web/components/dropdown";
import { LearnMore } from "~/web/components/learn-more";
import {
  exampleFromForm,
  type DiscountFormFields,
} from "~/web/lib/campaign-editor";
import { DISCOUNT_TYPE_LABEL, ROUNDING_LABEL } from "~/web/lib/sales";
import type { CampaignForm } from "~/web/lib/sales.server";

/**
 * Section 3 of the campaign editor: how much off.
 *
 * The type is three cards in a row; the card chosen decides which one field
 * follows it, with its unit on the field rather than in the label. Rounding
 * sits beside the value because the two together are the price, and the
 * line under them shows that price for one of the merchant's own variants —
 * computed by the same arithmetic activation uses, so it is never a made-up
 * number (docs/ui-conventions.md § Element semantics).
 */
const TYPE_DETAIL: Record<DiscountFormFields["discountType"], string> = {
  percentage: "The same share off every price",
  fixed_amount: "The same amount off every price",
  fixed_price: "Every variant to the same price",
};

export interface CampaignDiscountProps {
  form: DiscountFormFields;
  currency: string;
  onChange: <K extends keyof DiscountFormFields>(
    key: K,
    value: CampaignForm[K],
  ) => void;
  errorFor: (
    field: "discountValue" | "roundingIncrement",
  ) => string | undefined;
  disabled?: boolean;
  /** One of the merchant's own variants, from the preview, to show the arithmetic on. */
  exampleVariant: { title: string; baseMinor: number } | null;
}

export function CampaignDiscount({
  form,
  currency,
  onChange,
  errorFor,
  disabled,
  exampleVariant,
}: CampaignDiscountProps) {
  const off = disabled ? { disabled: true } : {};
  const example = exampleVariant
    ? exampleFromForm(form, exampleVariant.baseMinor, currency)
    : null;

  const valueLabel =
    form.discountType === "percentage"
      ? "Discount"
      : form.discountType === "fixed_amount"
        ? "Amount off"
        : "Sale price";

  return (
    <s-section heading="3. Discount">
      <s-stack direction="block" gap="base">
        {/* The type, as three cards: the chosen one carries a tick as well as its border. */}
        <s-stack direction="block" gap="small-400">
          <s-text type="strong">Type</s-text>
          <s-grid
            gridTemplateColumns="@container (inline-size <= 520px) 1fr, 1fr 1fr 1fr"
            gap="small-300"
          >
            {(
              Object.keys(DISCOUNT_TYPE_LABEL) as Array<
                keyof typeof DISCOUNT_TYPE_LABEL
              >
            ).map((type) => {
              const selected = form.discountType === type;
              return (
                <s-clickable
                  key={type}
                  borderWidth="base"
                  borderStyle="solid"
                  borderColor={selected ? "strong" : "base"}
                  borderRadius="base"
                  background={selected ? "subdued" : "base"}
                  padding="small-300"
                  accessibilityLabel={`${DISCOUNT_TYPE_LABEL[type]}${selected ? ", selected" : ""}`}
                  onClick={() => onChange("discountType", type)}
                  {...off}
                >
                  <s-grid
                    gridTemplateColumns="1fr auto"
                    gap="small-300"
                    alignItems="start"
                  >
                    <s-stack direction="block" gap="small-500">
                      <s-text type="strong">{DISCOUNT_TYPE_LABEL[type]}</s-text>
                      <s-text color="subdued">{TYPE_DETAIL[type]}</s-text>
                    </s-stack>
                    {selected ? (
                      <s-icon type="check-circle-filled" />
                    ) : (
                      <s-box inlineSize="20px" />
                    )}
                  </s-grid>
                </s-clickable>
              );
            })}
          </s-grid>
        </s-stack>

        <s-grid
          gridTemplateColumns="@container (inline-size <= 520px) 1fr, minmax(140px, 200px) minmax(200px, 1fr)"
          gap="base"
          alignItems="start"
        >
          <s-text-field
            label={valueLabel}
            placeholder={form.discountType === "percentage" ? "10" : "10.00"}
            {...(form.discountType === "percentage"
              ? { suffix: "%" }
              : { suffix: currency })}
            value={form.discountValue}
            onChange={(event) =>
              onChange("discountValue", event.currentTarget.value)
            }
            {...(errorFor("discountValue")
              ? { error: errorFor("discountValue") }
              : {})}
            {...off}
          />
          <Dropdown
            name="rounding"
            label="Rounding"
            value={form.rounding}
            options={(
              Object.keys(ROUNDING_LABEL) as Array<keyof typeof ROUNDING_LABEL>
            ).map((mode) => ({ value: mode, label: ROUNDING_LABEL[mode] }))}
            onChange={(mode) =>
              onChange("rounding", mode as DiscountFormFields["rounding"])
            }
            {...(form.rounding === "ending_99" ||
            form.rounding === "ending_9" ||
            form.rounding === "ending_99_99"
              ? {
                  details:
                    "Rounds down, so the sale is never smaller than advertised.",
                }
              : {})}
            {...off}
          />
        </s-grid>

        {form.rounding === "increment" ? (
          <s-box maxInlineSize="200px">
            <s-text-field
              label="Increment"
              placeholder="5.00"
              suffix={currency}
              details="For example 5.00 rounds to the nearest 5."
              value={form.roundingIncrement}
              onChange={(event) =>
                onChange("roundingIncrement", event.currentTarget.value)
              }
              {...(errorFor("roundingIncrement")
                ? { error: errorFor("roundingIncrement") }
                : {})}
              {...off}
            />
          </s-box>
        ) : null}

        {/* The example is always the merchant's own price, never a made-up one. */}
        <s-box padding="small-300" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-500">
            <s-text type="strong">Example</s-text>
            {exampleVariant && example ? (
              <s-text>
                {`${exampleVariant.title}: `}
                <s-text type="redundant">{example.before}</s-text>
                {` → `}
                <s-text type="strong">{example.after}</s-text>
              </s-text>
            ) : (
              <s-text color="subdued">
                {exampleVariant
                  ? "Enter a discount that lowers the price to see it on one of your products."
                  : "Choose products to see the discount on one of your own prices."}
              </s-text>
            )}
          </s-stack>
        </s-box>

        <LearnMore label="How rounding works">
          <s-paragraph>
            1,823.27 becomes 1,823 (nearest whole number), 1,822.99 (end in
            .99), 1,819 (end in 9) or 1,799.99 (end in 99.99). Endings round
            down, so the sale is never smaller than advertised. A price too
            small to carry the ending is left as it is.
          </s-paragraph>
        </LearnMore>
      </s-stack>
    </s-section>
  );
}
