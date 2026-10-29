import { AreaNav } from "~/web/components/area-nav";
import { SOURCE_ROUTES } from "~/web/lib/sources";

export type SourcesSection =
  | "sources"
  | "review"
  | "categorization"
  | "connection";

/**
 * The Sources area's own navigation, the same tab row as Translations and
 * Product setup (`AreaNav`). `awaitingReview`, when the page knows it, is
 * said on the Review tab so the count does not need a second button.
 */
export function SourcesNav({
  current,
  awaitingReview = 0,
}: {
  current: SourcesSection;
  awaitingReview?: number;
}) {
  return (
    <AreaNav
      label="Sources sections"
      current={current}
      items={[
        { key: "sources", label: "Sources", href: SOURCE_ROUTES.index },
        {
          key: "review",
          label: awaitingReview > 0 ? `Review (${awaitingReview})` : "Review",
          href: SOURCE_ROUTES.review(),
        },
        {
          key: "categorization",
          label: "AI categorization",
          href: SOURCE_ROUTES.categorization,
        },
        {
          key: "connection",
          label: "Connection",
          href: SOURCE_ROUTES.connection,
        },
      ]}
    />
  );
}
