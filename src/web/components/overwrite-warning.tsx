/**
 * The one treatment for a setting that starts overwriting data the merchant
 * maintains somewhere else.
 *
 * `docs/ui-conventions.md` fixes the pattern at three parts and no more:
 *
 *  1. a short subdued line under the control, present at all times, naming what
 *     gets overwritten and on what cadence. That belongs to the control, so it
 *     lives in the checkbox's own `details` rather than here;
 *  2. this banner, which renders **only** in the unsaved-changes state and
 *     **only** when the merchant has just turned the setting from off to on;
 *  3. nothing else. No third statement of the same fact anywhere on the page.
 *
 * The condition is the whole point. A banner that renders whenever the setting
 * is on is wallpaper: it is loudest on the visit where nothing changed and
 * silent in the moment the merchant actually decided something. So it is a
 * function of `saved` against `current`, which is exactly "unsaved, and newly
 * on" — it disappears on save, and never appears for a setting that was already
 * on when the page loaded.
 *
 * Name overwrite and price overwrite both use this component, unchanged.
 * Neither is special.
 */
export interface OverwriteWarningProps {
  /** What the setting was when the page loaded. */
  saved: boolean;
  /** What it is now. */
  current: boolean;
  heading: string;
  /** What will be overwritten, and when. One sentence. */
  children: React.ReactNode;
}

export function OverwriteWarning({
  saved,
  current,
  heading,
  children,
}: OverwriteWarningProps) {
  if (saved || !current) return null;

  return (
    <s-banner tone="warning" heading={heading}>
      <s-paragraph>{children}</s-paragraph>
    </s-banner>
  );
}
