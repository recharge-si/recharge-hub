import type { MetafieldDefinition } from "~/domain/products/template";
import type { RuleGroup } from "~/domain/sales/rules";
import { RuleBuilder, type RuleFacets } from "~/web/components/rule-builder";
import { targetingSummary } from "~/web/lib/campaign-editor";

/**
 * Section 2 of the campaign editor: which products, as a rule builder.
 *
 * Include on top, exclude beneath it and quieter, and one line at the foot
 * that says what the two together come to — products, variants matched,
 * excluded, final — refreshed as the rules change. The exclusions stay a
 * single sentence until there is something to exclude from, so a merchant
 * building a first campaign meets one builder, not two.
 */
export interface TargetingCounts {
  products: number;
  includedVariants: number;
  excludedVariants: number;
  variants: number;
}

export interface CampaignTargetingProps {
  /** An anchor, so "choose products" elsewhere on the page can point here. */
  id?: string;
  include: RuleGroup;
  exclude: RuleGroup;
  onIncludeChange: (next: RuleGroup) => void;
  onExcludeChange: (next: RuleGroup) => void;
  facets: RuleFacets;
  metafields: MetafieldDefinition[];
  currency: string;
  disabled?: boolean;
  includeError?: string;
  excludeError?: string;
  /** The last counts worked out for these rules; null before the catalogue is read. */
  counts: TargetingCounts | null;
  /** Counts are being worked out for the rules as they now stand. */
  refreshing: boolean;
  /** Why the counts could not be refreshed, when they could not. */
  countsNote?: string | null;
}

export function CampaignTargeting({
  id,
  include,
  exclude,
  onIncludeChange,
  onExcludeChange,
  facets,
  metafields,
  currency,
  disabled,
  includeError,
  excludeError,
  counts,
  refreshing,
  countsNote,
}: CampaignTargetingProps) {
  const off = disabled ? { disabled: true } : {};
  const hasInclude = include.rules.length > 0;
  const hasExclude = exclude.rules.length > 0;

  return (
    <s-section heading="2. Products" {...(id ? { id } : {})}>
      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          Choose which products and variants this campaign applies to.
        </s-text>

        <s-stack direction="block" gap="small-300">
          <s-text type="strong">Include</s-text>
          <RuleBuilder
            purpose="include"
            value={include}
            onChange={onIncludeChange}
            facets={facets}
            metafields={metafields}
            currency={currency}
            {...off}
          />
          {includeError ? (
            <s-text tone="critical">{includeError}</s-text>
          ) : null}
        </s-stack>

        <s-divider />

        <s-stack direction="block" gap="small-300">
          <s-stack direction="block" gap="small-500">
            <s-text type="strong">Exclude</s-text>
            <s-text color="subdued">
              {hasInclude || hasExclude
                ? "Optionally exclude some of the products matched above."
                : "Once products are chosen, some of them can be excluded here."}
            </s-text>
          </s-stack>
          {hasInclude || hasExclude ? (
            <RuleBuilder
              purpose="exclude"
              value={exclude}
              onChange={onExcludeChange}
              facets={facets}
              metafields={metafields}
              currency={currency}
              {...off}
            />
          ) : null}
          {excludeError ? (
            <s-text tone="critical">{excludeError}</s-text>
          ) : null}
        </s-stack>

        {/* The result bar: one line, never a column of counts. */}
        <s-box
          padding="small-300"
          background="subdued"
          borderRadius="base"
          accessibilityRole="status"
        >
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="small-300"
            alignItems="center"
          >
            {counts ? (
              <s-text type={hasInclude ? "strong" : "generic"}>
                {hasInclude
                  ? targetingSummary(counts)
                  : "No products matched yet."}
              </s-text>
            ) : (
              <s-text color="subdued">
                Read the catalogue to count what these rules match.
              </s-text>
            )}
            {refreshing ? (
              <s-spinner size="base" accessibilityLabel="Counting products" />
            ) : (
              <s-box inlineSize="20px" blockSize="20px" />
            )}
          </s-grid>
          {countsNote ? <s-text color="subdued">{countsNote}</s-text> : null}
        </s-box>
      </s-stack>
    </s-section>
  );
}
