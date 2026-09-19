import { AdvancedSection } from "~/web/components/advanced-section";
import { BASE_CHANGE_LABEL, EXISTING_SALE_LABEL } from "~/web/lib/sales";
import type { CampaignForm } from "~/web/lib/sales.server";

/**
 * Section 6 of the campaign editor: the three policies almost every campaign
 * leaves at their defaults — products already on sale, a price changed
 * outside the campaign, and whether membership follows the rules while the
 * sale is live. Closed, the card states all three in one line; nobody opens
 * it to check (docs/ui-conventions.md § Disclosure).
 */
export interface CampaignAdvancedProps {
  existingSalePolicy: CampaignForm["existingSalePolicy"];
  basePriceChangePolicy: CampaignForm["basePriceChangePolicy"];
  dynamicMembership: CampaignForm["dynamicMembership"];
  onChange: <
    K extends
      "existingSalePolicy" | "basePriceChangePolicy" | "dynamicMembership",
  >(
    key: K,
    value: CampaignForm[K],
  ) => void;
  disabled?: boolean;
}

export function advancedSummary(props: {
  existingSalePolicy: CampaignForm["existingSalePolicy"];
  basePriceChangePolicy: CampaignForm["basePriceChangePolicy"];
  dynamicMembership: CampaignForm["dynamicMembership"];
}): string {
  return [
    `Already on sale: ${EXISTING_SALE_LABEL[props.existingSalePolicy].label.toLowerCase()}`,
    `Outside price change: ${BASE_CHANGE_LABEL[props.basePriceChangePolicy].label.toLowerCase()}`,
    props.dynamicMembership === "on"
      ? "products join and leave on their own"
      : "products fixed at activation",
  ].join(" · ");
}

export function CampaignAdvanced({
  existingSalePolicy,
  basePriceChangePolicy,
  dynamicMembership,
  onChange,
  disabled,
}: CampaignAdvancedProps) {
  const off = disabled ? { disabled: true } : {};

  return (
    <AdvancedSection
      heading="6. Advanced settings"
      summary={advancedSummary({
        existingSalePolicy,
        basePriceChangePolicy,
        dynamicMembership,
      })}
    >
      <s-stack direction="block" gap="large">
        <s-choice-list
          label="Products already on sale"
          details="A variant is already on sale when its compare-at price is above its price. Its original pair is recorded whatever you choose, so it is put back exactly."
          name="existingSalePolicy"
          values={[existingSalePolicy]}
          onChange={(event) => {
            const next = event.currentTarget.values[0] ?? "";
            if (next in EXISTING_SALE_LABEL)
              onChange(
                "existingSalePolicy",
                next as CampaignForm["existingSalePolicy"],
              );
          }}
          {...off}
        >
          {(
            Object.keys(EXISTING_SALE_LABEL) as Array<
              keyof typeof EXISTING_SALE_LABEL
            >
          ).map((policy) => (
            <s-choice key={policy} value={policy}>
              {EXISTING_SALE_LABEL[policy].label}
              <s-text slot="details">
                {EXISTING_SALE_LABEL[policy].detail}
              </s-text>
            </s-choice>
          ))}
        </s-choice-list>

        <s-choice-list
          label="If a price changes outside the campaign while it is live"
          details="An ERP sync or a person in the admin can change a price this campaign holds. The campaign notices from Shopify's own webhook and never mistakes its own write for somebody else's."
          name="basePriceChangePolicy"
          values={[basePriceChangePolicy]}
          onChange={(event) => {
            const next = event.currentTarget.values[0] ?? "";
            if (next in BASE_CHANGE_LABEL)
              onChange(
                "basePriceChangePolicy",
                next as CampaignForm["basePriceChangePolicy"],
              );
          }}
          {...off}
        >
          {(
            Object.keys(BASE_CHANGE_LABEL) as Array<
              keyof typeof BASE_CHANGE_LABEL
            >
          ).map((policy) => (
            <s-choice key={policy} value={policy}>
              {BASE_CHANGE_LABEL[policy].label}
              <s-text slot="details">{BASE_CHANGE_LABEL[policy].detail}</s-text>
            </s-choice>
          ))}
        </s-choice-list>

        <s-checkbox
          label="Keep membership up to date"
          details="Products that start matching the rules join the sale; products that stop matching have their price put back. Off: only the products matched at activation are affected."
          checked={dynamicMembership === "on"}
          onChange={(event) =>
            onChange(
              "dynamicMembership",
              event.currentTarget.checked ? "on" : "off",
            )
          }
          {...off}
        />
      </s-stack>
    </AdvancedSection>
  );
}
