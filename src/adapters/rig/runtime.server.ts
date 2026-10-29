import { createHmac } from "node:crypto";

import { getRigAiProvider } from "~/adapters/ai/rig-provider.server";
import { getEnv } from "~/adapters/config/env.server";
import {
  findRigShop,
  loadRigSource,
  poolCallsSince,
  recordRigUsage,
  rigRequestExists,
  saveRigRequest,
} from "~/adapters/db/repositories/rig.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { addRigBreadcrumb } from "~/adapters/observability/sentry.server";
import { createRigApi, type RigStore } from "~/adapters/rig/api.server";
import { RateLimiter } from "~/adapters/rig/rate-limit";
import shopify from "~/adapters/shopify/shopify.server";
import { placeholderRules } from "~/domain/rig/rules";
import { serviceToken } from "~/domain/types";

/**
 * The rig API wired to the real world: the database, claude-pool, the Shopify
 * proxy signature and this process's rate limiters. Built once per process on
 * first use, so importing a route does not read the environment.
 */

/** Explain waits on a model, so its limits are the tight ones (PRD 4 US-401). */
const EXPLAIN_WINDOWS = [
  { ms: 60_000, limit: 3 },
  { ms: 3_600_000, limit: 10 },
] as const;

const store: RigStore = {
  findShop: findRigShop,
  loadSource: (domain) => loadRigSource(serviceToken(domain, "rig-proxy")),
  requestExists: rigRequestExists,
  saveRequest: saveRigRequest,
  poolCallsSince,
  recordUsage: recordRigUsage,
};

let api: ReturnType<typeof createRigApi> | undefined;

export function rigApi(): ReturnType<typeof createRigApi> {
  if (!api) {
    const env = getEnv();
    api = createRigApi({
      // Shopify signs the query string; an invalid signature throws a 400
      // Response, which is a "no" here. The shop comes from the signed query.
      authenticate: async (request) => {
        try {
          await shopify.authenticate.public.appProxy(request);
        } catch {
          return null;
        }
        return new URL(request.url).searchParams.get("shop");
      },
      store,
      provider: getRigAiProvider(),
      // PLACEHOLDER until Recharge staff sign off the real table.
      rules: placeholderRules(),
      buildLimiter: new RateLimiter([
        { ms: 60_000, limit: env.RIG_BUILD_PER_MINUTE },
        { ms: 3_600_000, limit: env.RIG_BUILD_PER_HOUR },
      ]),
      explainLimiter: new RateLimiter([...EXPLAIN_WINDOWS]),
      config: {
        model: env.RIG_AI_MODEL,
        timeoutMs: env.RIG_AI_TIMEOUT_MS,
        dailyCalls: env.RIG_AI_DAILY_CALLS,
        ipSalt: createHmac("sha256", env.ENCRYPTION_KEY)
          .update("rig-ip-salt-v1")
          .digest("hex"),
        cacheSeconds: 300,
      },
      now: () => new Date(),
      log: (fields, message) => getLogger().info(fields, message),
      logError: (fields, message) => getLogger().error(fields, message),
      breadcrumb: (call) => addRigBreadcrumb({ ...call }, call.status >= 400),
    });
  }
  return api;
}
