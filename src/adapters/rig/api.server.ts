import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { ProviderResult, RigAiProvider } from "~/adapters/ai/rig-provider.server";
import { clientIp, hashIp, type RateLimiter } from "~/adapters/rig/rate-limit";
import type { RigSource, RigRequestWrite, RigUsageWrite } from "~/adapters/db/repositories/rig.server";
import { SnapshotCache } from "~/adapters/rig/snapshot-cache";
import {
  candidatesFrom,
  readinessFromCandidates,
  type RigReadiness,
} from "~/domain/rig/candidates";
import {
  buildRig,
  checkReport,
  resolveFit,
  uncheckedWarnings,
} from "~/domain/rig/engine";
import { warningMessage } from "~/domain/rig/messages";
import {
  answersSchema,
  LIMITS,
  mergeProfile,
  parseProfile,
  type Answers,
  type ParsedModelProfile,
} from "~/domain/rig/profile";
import type {
  BuildResult,
  Check,
  EngineWarning,
  Profile,
  Rig,
  RigCandidate,
  RigItem,
  RigRules,
} from "~/domain/rig/types";
import {
  acceptWhy,
  buildProfilePrompt,
  buildWhyPrompt,
  profileReplySchema,
  PROMPT_VERSION,
  templateWhy,
  whyReplySchema,
  type Locale,
  type RiderFacts,
} from "~/domain/rig/words";

/**
 * The three public routes behind the Shopify App Proxy (docs/rig-builder.md
 * § Contract): `build`, `explain` and `verify`. The route files are thin;
 * everything that decides lives here with its dependencies passed in, so the
 * tests run it without Shopify, a database or a model.
 *
 * Order of work for every request: method, signature (401, and nothing else
 * runs), rate limit (429), body (400 / 413), readiness (409). Only `explain`
 * ever waits on a model, and only after the engine has produced the rig.
 */

export interface RigStore {
  findShop(
    domain: string,
  ): Promise<{ id: string; enabled: boolean; installed: boolean } | null>;
  loadSource(domain: string): Promise<RigSource>;
  requestExists(shopId: string, id: string): Promise<boolean>;
  saveRequest(write: RigRequestWrite, existing: boolean): Promise<void>;
  poolCallsSince(shopId: string, since: Date): Promise<number>;
  recordUsage(write: RigUsageWrite): Promise<void>;
}

export interface RigApiConfig {
  model: string;
  /** Per-call and whole-explain budget, ms. */
  timeoutMs: number;
  dailyCalls: number;
  /** Secret that salts the IP hash. */
  ipSalt: string;
  /** Seconds a loaded catalogue is fresh; after that it is served stale while it refreshes. */
  cacheSeconds: number;
  /** Seconds a stale catalogue may still be served before a caller waits for the load (default 1800). */
  maxStaleSeconds?: number;
}

export interface RigApiDeps {
  /** The shop domain a verified proxy request is for, or null when the signature is not valid. */
  authenticate(request: Request): Promise<string | null>;
  store: RigStore;
  provider: RigAiProvider;
  rules: RigRules;
  buildLimiter: RateLimiter;
  explainLimiter: RateLimiter;
  config: RigApiConfig;
  now(): Date;
  log?: (fields: Record<string, unknown>, message: string) => void;
  /** Where a failure the API turns into a 409 is recorded, with its cause. */
  logError?: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * The status of "not ready" and "unavailable". Shopify's App Proxy replaces a
 * 5xx answer with the store's own error page, so the buyer's page would never
 * see the JSON; a 409 is passed through like the 400 and 429 are. The code in
 * the body is what the page reads.
 */
export const NOT_SERVED = 409;

/** A snapshot older than this is called stale (PRD 4 US-402). */
export const STALE_MINUTES = 30;
const BODY_LIMIT_BYTES = 32_000;
const REQUEST_ID = /^rb_[0-9a-f]{24}$/;
/** Below this much budget left, a model call is not started. */
const MIN_CALL_MS = 2_000;

/* -------------------------------------------------------------------------- */
/* Wire format                                                                */
/* -------------------------------------------------------------------------- */

const bodySchema = z
  .object({
    text: z.string().optional(),
    answers: answersSchema.optional(),
    locale: z.enum(["en", "sl"]).optional(),
    requestId: z.string().regex(REQUEST_ID).optional(),
  })
  .strict();

const verifySchema = z
  .object({
    variantIds: z.array(z.number().int().positive()).min(1).max(12),
    answers: answersSchema.optional(),
    locale: z.enum(["en", "sl"]).optional(),
  })
  .strict();

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function formatMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

interface WireWarning {
  code: string;
  message: string;
}

function wireWarnings(
  warnings: readonly EngineWarning[],
  locale: Locale,
): WireWarning[] {
  const seen = new Set<string>();
  const out: WireWarning[] = [];
  for (const warning of warnings) {
    if (seen.has(warning.code)) continue;
    seen.add(warning.code);
    out.push({
      code: warning.code,
      message: warningMessage(warning.code, locale, warning.detail),
    });
  }
  return out;
}

/** The profile the buyer sees as chips: only what is known, and where it came from. */
export function wireProfile(profile: Profile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = [
    "discipline",
    "weightKg",
    "heightCm",
    "skill",
    "windMinKn",
    "windMaxKn",
    "budgetEur",
    "boardKind",
    "ownedBoomMinCm",
    "ownedBoomMaxCm",
  ] as const;
  for (const field of fields) {
    if (profile[field] !== null) out[field] = profile[field];
  }
  if (profile.owns.length > 0) out["owns"] = profile.owns;
  out["source"] = profile.source;
  return out;
}

function wireItem(
  item: RigItem,
  rider: RiderFacts,
  locale: Locale,
  why: string | undefined,
  stale: boolean,
) {
  return {
    role: item.role,
    productId: item.productId,
    variantId: item.variantId,
    title: item.title,
    variantTitle: item.variantTitle,
    url: item.handle ? `/products/${item.handle}` : null,
    image: item.imageUrl,
    price: formatMinor(item.priceMinor),
    currency: item.currency,
    available: item.available,
    quantity: item.quantity,
    why: why ?? templateWhy(item, rider, locale),
    specs: item.specs,
    ...(item.derived.length > 0 ? { derived: item.derived } : {}),
    ...(stale ? { checkAvailability: true } : {}),
  };
}

function wireRig(
  rig: Rig,
  rider: RiderFacts,
  locale: Locale,
  whys: Record<string, string>,
  stale: boolean,
) {
  return {
    label: rig.label,
    items: rig.items.map((item) =>
      wireItem(item, rider, locale, whys[String(item.variantId)], stale),
    ),
    total: formatMinor(rig.totalMinor),
    currency: rig.currency,
    checks: rig.checks,
    ...(rig.unchecked.length > 0 ? { unchecked: rig.unchecked } : {}),
    alternatives: rig.alternatives.map((alternative) => ({
      role: alternative.role,
      variantId: alternative.variantId,
      title: alternative.title,
      variantTitle: alternative.variantTitle,
      price: formatMinor(alternative.priceMinor),
      currency: alternative.currency,
      why: templateWhy(alternative, rider, locale),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* The catalogue, prepared                                                    */
/* -------------------------------------------------------------------------- */

interface Prepared {
  shopId: string;
  candidates: RigCandidate[];
  byVariant: Map<number, RigCandidate>;
  titles: string[];
  readiness: RigReadiness;
  /** When the newest row was touched (ms), for the age of the stock. */
  newestMs: number | null;
}

function prepare(source: RigSource): Prepared {
  const candidates = candidatesFrom(source.plan, source.products);
  const touched = [source.snapshotAt, source.observedAt].filter(
    (date): date is Date => date !== null,
  );
  const newest = touched.length
    ? Math.max(...touched.map((date) => date.getTime()))
    : null;
  return {
    shopId: source.shopId,
    candidates,
    byVariant: new Map(candidates.map((c) => [c.variantId, c])),
    titles: candidates.map((c) => c.title),
    readiness: readinessFromCandidates(candidates),
    newestMs: newest,
  };
}

/* -------------------------------------------------------------------------- */
/* The API                                                                    */
/* -------------------------------------------------------------------------- */

type Handler = (request: Request) => Promise<Response>;

/** What is worth logging about a thrown value: its kind, message and Prisma code. */
function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message.slice(0, 500),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { message: String(error).slice(0, 500) };
}

export function createRigApi(deps: RigApiDeps): {
  build: Handler;
  explain: Handler;
  verify: Handler;
} {
  const { store, config, rules } = deps;
  const log = deps.log ?? (() => undefined);

  /** Fresh for `cacheSeconds`, then served stale while one refresh runs (snapshot-cache.ts). */
  const cache = new SnapshotCache<Prepared>({
    ttlMs: config.cacheSeconds * 1000,
    maxStaleMs: Math.max(config.maxStaleSeconds ?? 1800, config.cacheSeconds) * 1000,
    load: async (domain) => prepare(await store.loadSource(domain)),
    now: () => deps.now().getTime(),
    onRefreshError: (domain, error) =>
      deps.logError?.(
        { domain, error: errorFields(error) },
        "The rig catalogue could not be refreshed; serving the last one",
      ),
  });

  const load = (domain: string): Promise<Prepared> => cache.get(domain);

  /** Minutes since the newest row was touched, as of now. */
  function ageMinutes(prepared: Prepared): number | null {
    return prepared.newestMs === null
      ? null
      : Math.max(
          0,
          Math.floor((deps.now().getTime() - prepared.newestMs) / 60_000),
        );
  }

  /**
   * The catalogue, or a 409 when it cannot be read. A failed read (a database
   * error, a column a migration has not added yet) is logged with its cause and
   * answered as "unavailable", never as a raw 500 a buyer's page cannot read.
   */
  async function loadOrRefuse(domain: string): Promise<Prepared | Response> {
    try {
      return await load(domain);
    } catch (error) {
      deps.logError?.(
        { domain, error: errorFields(error) },
        "The rig catalogue could not be read",
      );
      return json(NOT_SERVED, { code: "unavailable" }, { "Retry-After": "30" });
    }
  }

  interface Context {
    domain: string;
    shopId: string;
    enabled: boolean;
    ipHash: string;
    locale: Locale;
  }

  /** Method, signature, shop and rate limit, in that order. */
  async function admit(
    request: Request,
    limiter: RateLimiter,
  ): Promise<Response | Omit<Context, "locale">> {
    if (request.method !== "POST") {
      return json(405, { code: "method_not_allowed" }, { Allow: "POST" });
    }
    let domain: string | null = null;
    try {
      domain = await deps.authenticate(request);
    } catch {
      domain = null;
    }
    if (!domain) return json(401, { code: "unauthorized" });
    const shop = await store.findShop(domain);
    if (!shop || !shop.installed) return json(401, { code: "unauthorized" });

    const ipHash = hashIp(clientIp(request.headers), config.ipSalt);
    const limited = limiter.check(ipHash, deps.now().getTime());
    if (!limited.ok) {
      return json(
        429,
        { code: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds },
        { "Retry-After": String(limited.retryAfterSeconds) },
      );
    }
    return { domain, shopId: shop.id, enabled: shop.enabled, ipHash };
  }

  async function readBody(request: Request): Promise<Response | unknown> {
    const text = await request.text();
    if (text.length > BODY_LIMIT_BYTES) {
      return json(413, { code: "body_too_large" });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return json(400, { code: "invalid_json" });
    }
  }

  function invalid(error: z.ZodError): Response {
    const issue = error.issues[0];
    const keys =
      issue && "keys" in issue && Array.isArray(issue.keys)
        ? (issue.keys as string[])
        : [];
    const field =
      keys.length > 0
        ? [...(issue?.path ?? []).map(String), keys[0]].join(".")
        : (issue?.path ?? []).map(String).join(".");
    return json(400, {
      code: "invalid_body",
      field,
      message: issue?.message ?? "Invalid request.",
    });
  }

  /** The 413 for text over the limit comes before schema validation. */
  function textTooLong(body: unknown): Response | null {
    if (
      body &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>)["text"] === "string" &&
      ((body as Record<string, unknown>)["text"] as string).length > LIMITS.text
    ) {
      return json(413, { code: "text_too_long", field: "text", max: LIMITS.text });
    }
    return null;
  }

  function notReady(
    context: Pick<Context, "enabled">,
    prepared: Prepared,
  ): Response | null {
    if (context.enabled && prepared.readiness.ready) return null;
    return json(NOT_SERVED, {
      code: "not_ready",
      reason: context.enabled ? "catalogue" : "disabled",
      ...(context.enabled && prepared.readiness.stockNotRead
        ? { detail: "stock_not_read" }
        : {}),
    });
  }

  function newId(): string {
    return `rb_${randomBytes(12).toString("hex")}`;
  }

  async function requestIdFor(
    shopId: string,
    sent: string | undefined,
  ): Promise<{ id: string; existing: boolean }> {
    if (sent && (await store.requestExists(shopId, sent))) {
      return { id: sent, existing: true };
    }
    return { id: newId(), existing: false };
  }

  function engineRun(profile: Profile, prepared: Prepared): BuildResult {
    return buildRig(profile, prepared.candidates, rules, {
      shopId: prepared.shopId,
    });
  }

  function staleWarning(prepared: Prepared): EngineWarning[] {
    const minutes = ageMinutes(prepared);
    return minutes !== null && minutes > STALE_MINUTES
      ? [{ code: "stale_snapshot", detail: { minutes } }]
      : [];
  }

  /* ------------------------------------------------------------------ build */

  const build: Handler = async (request) => {
    const admitted = await admit(request, deps.buildLimiter);
    if (admitted instanceof Response) return admitted;
    const started = deps.now().getTime();

    const raw = await readBody(request);
    if (raw instanceof Response) return raw;
    const long = textTooLong(raw);
    if (long) return long;
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;
    if (!hasContent(body.text, body.answers)) return emptyBody();
    const locale: Locale = body.locale ?? "en";

    const prepared = await loadOrRefuse(admitted.domain);
    if (prepared instanceof Response) return prepared;
    const refused = notReady(admitted, prepared);
    if (refused) return refused;

    const profile = mergeProfile(body.answers, undefined);
    const result = engineRun(profile, prepared);
    const warnings = [...result.warnings, ...staleWarning(prepared)];
    const snapshotAgeMinutes = ageMinutes(prepared);
    const stale = snapshotAgeMinutes !== null && snapshotAgeMinutes > STALE_MINUTES;
    const fit = resolveFit(profile, rules);
    const rider = riderFacts(profile, fit);

    const rig = result.rigs[0];
    let requestId: string | undefined;
    if (rig) {
      const ids = await requestIdFor(admitted.shopId, body.requestId);
      requestId = ids.id;
      await store.saveRequest(
        {
          id: ids.id,
          shopId: admitted.shopId,
          profile: wireProfile(profile),
          variantIds: rig.items.map((item) => item.variantId),
          mode: "plain",
          ipHash: admitted.ipHash,
          latencyMs: deps.now().getTime() - started,
        },
        ids.existing,
      );
    }
    log(
      {
        requestId,
        mode: "plain",
        latencyMs: deps.now().getTime() - started,
        parts: rig?.items.length ?? 0,
      },
      "rig build",
    );
    return json(200, {
      ...(requestId ? { requestId } : {}),
      profile: wireProfile(profile),
      needs: result.needs,
      rigs: rig ? [wireRig(rig, rider, locale, {}, stale)] : [],
      unmet: result.unmet,
      warnings: wireWarnings(warnings, locale),
      mode: "plain",
      snapshotAgeMinutes,
    });
  };

  /* --------------------------------------------------------------- explain */

  /** One model call with the capacity guard, usage row and a single retry on a transient error. */
  async function modelCall<T>(
    context: Pick<Context, "shopId" | "locale">,
    purpose: RigUsageWrite["purpose"],
    prompt: string,
    schema: z.ZodType<T>,
    deadlineMs: number,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    if (!(await deps.provider.ready())) {
      return { ok: false, reason: "unavailable" };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadlineMs - deps.now().getTime();
      if (remaining < MIN_CALL_MS) return { ok: false, reason: "timeout" };
      const used = await store.poolCallsSince(
        context.shopId,
        startOfUtcDay(deps.now()),
      );
      if (used >= config.dailyCalls) return { ok: false, reason: "daily_cap" };

      const result: ProviderResult<T> = await deps.provider.complete(prompt, schema, {
        timeoutMs: remaining,
      });
      if (result.ok || result.reason !== "busy") {
        await store.recordUsage({
          shopId: context.shopId,
          purpose,
          promptVersion: PROMPT_VERSION,
          locale: context.locale,
          model: (result.ok ? result.model : null) ?? config.model,
          result: result.ok ? "ok" : "failed",
          outcome: result.ok ? "ok" : result.reason,
          latencyMs: result.latencyMs,
        });
      }
      if (result.ok) return { ok: true, value: result.value };
      // Exhausted, busy and timed out are answers, not accidents: no retry.
      if (result.reason !== "error") return { ok: false, reason: result.reason };
    }
    return { ok: false, reason: "error" };
  }

  const explain: Handler = async (request) => {
    const admitted = await admit(request, deps.explainLimiter);
    if (admitted instanceof Response) return admitted;
    const started = deps.now().getTime();

    const raw = await readBody(request);
    if (raw instanceof Response) return raw;
    const long = textTooLong(raw);
    if (long) return long;
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;
    if (!hasContent(body.text, body.answers)) return emptyBody();
    const locale: Locale = body.locale ?? "en";
    const context = { shopId: admitted.shopId, locale };

    const prepared = await loadOrRefuse(admitted.domain);
    if (prepared instanceof Response) return prepared;
    const refused = notReady(admitted, prepared);
    if (refused) return refused;

    const deadline = started + config.timeoutMs;
    const warnings: EngineWarning[] = [];

    // 1. The buyer's text, read into a profile.
    let reading: ParsedModelProfile | undefined;
    const text = body.text?.trim() ?? "";
    if (text !== "") {
      const read = await modelCall(
        context,
        "rig_profile",
        buildProfilePrompt(text),
        profileReplySchema,
        deadline,
      );
      if (read.ok) {
        reading = parseProfile(read.value);
        for (const code of reading.warnings) warnings.push({ code });
      } else {
        warnings.push({ code: "text_not_read" });
      }
    }
    const profile = mergeProfile(body.answers, reading);

    // 2. The rig. The model has no say in it.
    const result = engineRun(profile, prepared);
    warnings.push(...result.warnings, ...staleWarning(prepared));
    const fit = resolveFit(profile, rules);
    const rider = riderFacts(profile, fit);
    const rig = result.rigs[0];

    // 3. The words.
    let whys: Record<string, string> = {};
    let wordsByModel = false;
    if (rig) {
      const asked = await modelCall(
        context,
        "rig_why",
        buildWhyPrompt(rig, rider, locale),
        whyReplySchema,
        deadline,
      );
      if (asked.ok) {
        const accepted = acceptWhy(
          asked.value.whys,
          rig.items,
          prepared.titles,
          rider,
          locale,
        );
        whys = accepted.whys;
        wordsByModel = true;
        if (accepted.replaced.length > 0) {
          log(
            { replaced: accepted.replaced.map((r) => r.reason) },
            "rig why filtered",
          );
        }
      } else {
        whys = Object.fromEntries(
          rig.items.map((item) => [
            String(item.variantId),
            templateWhy(item, rider, locale),
          ]),
        );
        warnings.push({ code: "mode_plain" });
      }
    }
    const mode = wordsByModel || (!rig && reading !== undefined) ? "ai" : "plain";
    if (!rig && mode === "plain" && text === "") warnings.push({ code: "mode_plain" });

    const ids = await requestIdFor(admitted.shopId, body.requestId);
    const latencyMs = deps.now().getTime() - started;
    await store.saveRequest(
      {
        id: ids.id,
        shopId: admitted.shopId,
        profile: wireProfile(profile),
        variantIds: rig?.items.map((item) => item.variantId) ?? [],
        mode,
        ipHash: admitted.ipHash,
        latencyMs,
        explainedAt: deps.now(),
      },
      ids.existing,
    );
    log({ requestId: ids.id, mode, latencyMs }, "rig explain");

    return json(200, {
      requestId: ids.id,
      profile: wireProfile(profile),
      needs: result.needs,
      whys,
      variantIds: rig?.items.map((item) => item.variantId) ?? [],
      mode,
      warnings: wireWarnings(warnings, locale),
    });
  };

  /* ---------------------------------------------------------------- verify */

  const verify: Handler = async (request) => {
    const admitted = await admit(request, deps.buildLimiter);
    if (admitted instanceof Response) return admitted;

    const raw = await readBody(request);
    if (raw instanceof Response) return raw;
    const parsed = verifySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;

    const prepared = await loadOrRefuse(admitted.domain);
    if (prepared instanceof Response) return prepared;
    const refused = notReady(admitted, prepared);
    if (refused) return refused;

    const profile = mergeProfile(body.answers, undefined);
    const fit = resolveFit(profile, rules);

    const selection: Partial<Record<RigCandidate["role"], RigCandidate>> = {};
    const problems: Check[] = [];
    const items: Array<{
      variantId: number;
      role: string;
      price: string;
      available: boolean;
    }> = [];
    let total = 0;
    for (const id of [...new Set(body.variantIds)].sort((a, b) => a - b)) {
      const candidate = prepared.byVariant.get(id);
      if (!candidate || candidate.shopId !== prepared.shopId) {
        problems.push({ id: `unknown-variant-${id}`, ok: false });
        continue;
      }
      const usable =
        candidate.status === "ACTIVE" &&
        candidate.inStock &&
        candidate.missing.length === 0;
      if (!usable) problems.push({ id: `unavailable-variant-${id}`, ok: false });
      if (selection[candidate.role]) {
        problems.push({ id: `duplicate-${candidate.role}`, ok: false });
        continue;
      }
      selection[candidate.role] = candidate;
      total += candidate.priceMinor;
      items.push({
        variantId: id,
        role: candidate.role,
        price: formatMinor(candidate.priceMinor),
        available: usable,
      });
    }
    // The same function the engine used to choose the parts.
    const report = checkReport(selection, fit.context);
    const checks = [...report.checks, ...problems];
    return json(200, {
      ok: checks.every((check) => check.ok),
      checks,
      ...(report.unchecked.length > 0 ? { unchecked: report.unchecked } : {}),
      items,
      total: formatMinor(total),
      currency: Object.values(selection)[0]?.currency ?? "",
      warnings: wireWarnings(
        [...fit.warnings, ...uncheckedWarnings(report.unchecked)],
        body.locale ?? "en",
      ),
    });
  };

  return { build, explain, verify };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function hasContent(text: string | undefined, answers: Answers | undefined): boolean {
  return (
    (text !== undefined && text.trim() !== "") ||
    (answers !== undefined && Object.keys(answers).length > 0)
  );
}

function emptyBody(): Response {
  return json(400, {
    code: "invalid_body",
    field: "text",
    message: "Give a description or at least one answer.",
  });
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function riderFacts(
  profile: Profile,
  fit: ReturnType<typeof resolveFit>,
): RiderFacts {
  return {
    weightKg: profile.weightKg,
    skill: fit.effective.skill,
    kind: fit.effective.kind,
    wind: fit.effective.wind,
  };
}
