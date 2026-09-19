import { useState, type ReactNode } from "react";

/**
 * A button that downloads a file the app serves.
 *
 * A plain link to an app URL does not work from inside the admin: the app
 * is an iframe, and a new tab opened at the app's own origin carries no
 * session token, so `authenticate.admin` sends the request through the
 * install/bounce flow instead of returning the file. App Bridge patches
 * `fetch` on the page to add the session token to same-origin requests, so
 * the file is fetched here, on the page, and handed to the browser as a
 * blob to save. The name comes from the response's own Content-Disposition
 * when it gives one.
 */
export function DownloadButton({
  href,
  fallbackName,
  children,
  slot,
  variant,
  icon,
  inlineSize,
  disabled,
}: {
  href: string;
  /** The file name when the response does not say. */
  fallbackName: string;
  children: ReactNode;
  slot?: "secondary-actions";
  variant?: "primary" | "secondary" | "tertiary";
  icon?: "export";
  inlineSize?: "fill";
  /** The file would not say what the page says; the reason sits beside the button. */
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(href, { headers: { Accept: "text/csv" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileNameFrom(
        response.headers.get("Content-Disposition"),
        fallbackName,
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("The file could not be downloaded. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <s-button
        type="button"
        onClick={() => void download()}
        {...(slot ? { slot } : {})}
        {...(variant ? { variant } : {})}
        {...(icon ? { icon } : {})}
        {...(inlineSize ? { inlineSize } : {})}
        {...(busy ? { loading: true } : {})}
        {...(disabled ? { disabled: true } : {})}
      >
        {children}
      </s-button>
      {error ? <s-text tone="critical">{error}</s-text> : null}
    </>
  );
}

/** `attachment; filename="autumn-sale-variants.csv"` → the name. */
export function fileNameFrom(
  disposition: string | null,
  fallback: string,
): string {
  const match = /filename="?([^";]+)"?/i.exec(disposition ?? "");
  return match?.[1]?.trim() || fallback;
}
