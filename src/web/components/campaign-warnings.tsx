import {
  campaignWarnings,
  type CampaignWarningsInput,
} from "~/web/lib/campaign-editor";

/**
 * What could go wrong, under the summary it concerns.
 *
 * One card, one line per thing, each with the icon that says how bad it is
 * and a link to where it is dealt with. Never a stack of banners
 * (docs/BUILD_SPEC.md § 2.8): four warnings in four banners is a wall; four
 * rows in one card is a list. The card does not render when there is
 * nothing to say (docs/ui-conventions.md: a zero-count problem indicator
 * does not render at all). What is said is decided in
 * `web/lib/campaign-editor`, where it is tested.
 */
const ICON = {
  critical: "alert-octagon",
  warning: "alert-triangle",
  info: "info",
} as const;

export type CampaignWarningsProps = CampaignWarningsInput;

export function CampaignWarnings(props: CampaignWarningsProps) {
  const warnings = campaignWarnings(props);
  if (warnings.length === 0) return null;

  return (
    <s-section heading="Warnings">
      <s-stack direction="block" gap="base">
        {warnings.map((warning) => (
          <s-grid
            key={warning.key}
            gridTemplateColumns="auto 1fr"
            gap="small-300"
            alignItems="start"
          >
            <s-icon type={ICON[warning.tone]} tone={warning.tone} />
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">{warning.heading}</s-text>
              <s-text color="subdued">{warning.text}</s-text>
              {warning.link ? (
                <s-link
                  href={warning.link.href}
                  {...(warning.link.external ? { target: "_blank" } : {})}
                >
                  {warning.link.label}
                </s-link>
              ) : null}
            </s-stack>
          </s-grid>
        ))}
      </s-stack>
    </s-section>
  );
}
