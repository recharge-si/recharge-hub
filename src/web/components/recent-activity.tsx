import { useState } from "react";

/**
 * The one activity list every page uses.
 *
 * Rules it exists to keep consistent:
 *
 *  - one entry by default, the rest behind "Show more". Activity is reassurance,
 *    not the point of any of these pages.
 *  - a sentence a merchant would say, never an event name from the log.
 *  - a badge only when something needs a person. A green badge on every line
 *    teaches people to ignore badges.
 */
export interface ActivityItem {
  id: string;
  /** What the entry is about: a warehouse name, "Catalogue", a gateway. */
  title: string;
  /** ISO timestamp. */
  at: string;
  /** One plain sentence, plus any supporting numbers. */
  text: string;
  /** False when a person has to do something about it. */
  ok: boolean;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function RecentActivity({
  items,
  empty,
}: {
  items: ActivityItem[];
  /** Shown instead of the list before anything has happened. */
  empty: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, 1);

  return (
    <s-stack direction="block" gap="small-100">
      {items.length === 0 ? (
        <s-text color="subdued">{empty}</s-text>
      ) : (
        <s-stack direction="block" gap="small-100">
          {visible.map((item) => (
            <s-stack
              key={item.id}
              direction="block"
              gap="small-500"
              paddingBlock="small-300"
            >
              <s-stack direction="inline" gap="small-300" alignItems="center">
                {item.ok ? null : (
                  <s-badge tone="caution">Needs attention</s-badge>
                )}
                <s-text type="strong">{item.title}</s-text>
                <s-text color="subdued">{formatDateTime(item.at)}</s-text>
              </s-stack>
              <s-text color="subdued">{item.text}</s-text>
            </s-stack>
          ))}
        </s-stack>
      )}

      {/*
       * The chevron is not decoration. Without it this is a line of text that
       * happens to be clickable, which is exactly how it read: the locations
       * page opens its warehouse list and its advanced settings with the same
       * pairing, so a disclosure looks like a disclosure everywhere.
       */}
      {items.length > 1 ? (
        <s-button
          type="button"
          variant="tertiary"
          icon={showAll ? "chevron-up" : "chevron-down"}
          onClick={() => setShowAll((on) => !on)}
        >
          {showAll ? "Show less" : `Show ${items.length - 1} more`}
        </s-button>
      ) : null}
    </s-stack>
  );
}
