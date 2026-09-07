import { describe, expect, it } from "vitest";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";

import { describeStaleSessionError } from "~/web/lib/route-errors";

/**
 * The shared /app ErrorBoundary detects an empty-body ErrorResponse —
 * specifically, what the embedded-auth layer throws when a session token
 * is invalid or expired on a client-side data fetch. The library renders
 * `error.data || 'Handling response'` for any thrown 4xx/5xx Response; an
 * empty body means the merchant gets the literal string "Handling response"
 * with no explanation or recovery path.
 *
 * This test ensures `describeStaleSessionError` correctly identifies this
 * specific case and leaves all others untouched (real error messages and
 * non-ErrorResponse values).
 */
describe("describeStaleSessionError", () => {
  it("detects an empty-body ErrorResponse as a stale session", () => {
    const error = new ErrorResponseImpl(401, "Unauthorized", undefined);
    const result = describeStaleSessionError(error);

    expect(result).toBeTruthy();
    expect(result?.heading).toBe("Session expired");
    expect(result?.recover).toBe("navigate");
    expect(result?.message).toContain("Redirecting");
    expect(result?.message).toContain("nothing lost");
  });

  it("leaves an ErrorResponse with a body untouched", () => {
    const error = new ErrorResponseImpl(404, "Not Found", "Order not found");
    const result = describeStaleSessionError(error);

    expect(result).toBeNull();
  });

  it("leaves a non-ErrorResponse error untouched", () => {
    const error = new Error("Something went wrong");
    const result = describeStaleSessionError(error);

    expect(result).toBeNull();
  });

  it("handles null/undefined gracefully", () => {
    expect(describeStaleSessionError(null)).toBeNull();
    expect(describeStaleSessionError(undefined)).toBeNull();
  });

  it("detects empty string as a stale session too", () => {
    // The library could emit either undefined or an empty string; both are
    // "no body" and should trigger the recovery UI.
    const error = new ErrorResponseImpl(401, "Unauthorized", "");
    const result = describeStaleSessionError(error);

    expect(result).toBeTruthy();
    expect(result?.heading).toBe("Session expired");
    expect(result?.recover).toBe("navigate");
  });
});
