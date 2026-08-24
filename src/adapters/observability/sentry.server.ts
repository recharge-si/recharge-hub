import * as Sentry from "@sentry/node";

import { getEnv } from "~/adapters/config/env.server";
import { getLogger } from "~/adapters/observability/logger.server";

let initialised = false;

/**
 * Called once per process (web and worker each call it at startup).
 * With no SENTRY_DSN configured this is a no-op, so local development and tests
 * do not need an error backend.
 */
export function initSentry(processName: "web" | "worker"): void {
  if (initialised) return;
  initialised = true;

  const env = getEnv();
  if (!env.SENTRY_DSN) {
    getLogger().debug(
      { process: processName },
      "SENTRY_DSN not set, error reporting disabled",
    );
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    initialScope: { tags: { process: processName } },
    // CLAUDE.md section 10: secrets and PII never leave the VM.
    sendDefaultPii: false,
    beforeSend(event) {
      delete event.request?.cookies;
      if (event.request?.headers) {
        delete event.request.headers["authorization"];
        delete event.request.headers["x-shopify-hmac-sha256"];
        delete event.request.headers["x-metakocka-signature"];
      }
      return event;
    },
  });

  getLogger().info({ process: processName }, "Sentry initialised");
}

export function captureException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

export { Sentry };
