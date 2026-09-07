import { isRouteErrorResponse } from "react-router";

/**
 * An empty-body ErrorResponse from the embedded-auth layer (specifically,
 * `respond-to-invalid-session-token` when a session token is invalid or
 * expired on a client-side data fetch). The library renders `error.data ||
 * 'Handling response'` for any thrown 4xx/5xx Response; when the response
 * body is empty, that literal string is all the merchant sees.
 *
 * The Shopify library's own paths (admin strategies, billing) and the app's
 * own error responses (e.g. 404s) always carry a body when they throw, so
 * only the empty-body case reaches this check. Detecting it here lets the
 * shared `/app` ErrorBoundary offer a real recovery action ("Reload") instead
 * of passing through to the library's fallback text.
 *
 * Setup and other routes save progress per-step to the database, so a page
 * reload loses nothing — it is a safe and expected recovery path the merchant
 * should be told about.
 */
export interface StaleSessionError {
  heading: string;
  message: string;
}

export function describeStaleSessionError(
  error: unknown,
): StaleSessionError | null {
  if (!isRouteErrorResponse(error) || error.data) return null;

  return {
    heading: "Session expired",
    message: "Reload the page to continue — nothing you entered was lost.",
  };
}
