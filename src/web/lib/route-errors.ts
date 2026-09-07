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
 * shared `/app` ErrorBoundary offer a real recovery action instead of passing
 * through to the library's fallback text.
 *
 * When React Router fetches a loader as a data request (client-side), it may
 * lack a valid session token. The loader call `authenticate.admin` runs with
 * no Authorization header and no token in the URL (the token was single-use
 * and spent on the prior page load, and action redirects deliberately drop it).
 * The library detects this and throws a 401. The recovery is to navigate to a
 * URL that forces a document-level request, which triggers the library's
 * bounce page for re-authentication.
 */
export interface StaleSessionError {
  heading: string;
  message: string;
  recover: "navigate" | "reload";
}

export function describeStaleSessionError(
  error: unknown,
): StaleSessionError | null {
  if (!isRouteErrorResponse(error) || error.data) return null;

  return {
    heading: "Session expired",
    message:
      "Redirecting to re-authenticate — you'll return to the same place with nothing lost.",
    recover: "navigate",
  };
}
