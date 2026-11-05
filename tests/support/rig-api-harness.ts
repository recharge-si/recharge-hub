import { vi } from "vitest";
import type { ZodType } from "zod";

import type {
  ProviderResult,
  RigAiProvider,
} from "~/adapters/ai/rig-provider.server";
import type {
  RigRequestWrite,
  RigSource,
  RigUsageWrite,
} from "~/adapters/db/repositories/rig.server";
import { createRigApi, type RigCall, type RigStore } from "~/adapters/rig/api.server";
import { RateLimiter } from "~/adapters/rig/rate-limit";

import {
  SHOP_A,
  SHOP_B,
  loadCatalogue,
  rigPlan,
  rules,
} from "./rig-fixtures";

/* ------------------------------ test doubles ------------------------------ */

const DOMAINS: Record<string, string> = {
  "a.myshopify.com": SHOP_A,
  "b.myshopify.com": SHOP_B,
};

export class FakeStore implements RigStore {
  saved: Array<{ write: RigRequestWrite; existing: boolean }> = [];
  usage: RigUsageWrite[] = [];
  poolCalls = 0;
  enabled = true;
  loadSource = vi.fn(async (domain: string): Promise<RigSource> => {
    const shopId = DOMAINS[domain] as string;
    return {
      shopId,
      plan: rigPlan(),
      products: loadCatalogue().filter((p) => p.shopId === shopId),
      snapshotAt: new Date("2026-10-28T12:00:00Z"),
      observedAt: null,
      enabled: this.enabled,
      currency: "EUR",
    };
  });
  async findShop(domain: string) {
    const id = DOMAINS[domain];
    return id ? { id, enabled: this.enabled, installed: true } : null;
  }
  async requestExists(shopId: string, id: string) {
    return this.saved.some(
      (entry) => entry.write.shopId === shopId && entry.write.id === id,
    );
  }
  async saveRequest(write: RigRequestWrite, existing: boolean) {
    this.saved.push({ write, existing });
  }
  async poolCallsSince() {
    return this.poolCalls;
  }
  async recordUsage(write: RigUsageWrite) {
    this.usage.push(write);
  }
}

export type Script = (prompt: string) => ProviderResult<unknown>;

export class FakeProvider implements RigAiProvider {
  readonly name = "fake";
  prompts: string[] = [];
  isReady = true;
  constructor(private readonly script: Script) {}
  async ready() {
    return this.isReady;
  }
  async complete<T>(
    prompt: string,
    _schema: ZodType<T>,
    _options: { timeoutMs: number },
  ): Promise<ProviderResult<T>> {
    this.prompts.push(prompt);
    return this.script(prompt) as ProviderResult<T>;
  }
}

export const ok = (value: unknown): ProviderResult<unknown> => ({
  ok: true,
  value,
  model: "fake-model",
  latencyMs: 5,
});
export const fail = (
  reason: "timeout" | "busy" | "exhausted" | "error",
): ProviderResult<unknown> => ({ ok: false, reason, latencyMs: 5 });

/** A model that reads the text and writes a sentence for every id it is shown. */
export function goodModel(extra: Record<string, string> = {}): Script {
  return (prompt) => {
    if (prompt.includes("<buyer_text>")) {
      return ok({ weightKg: 82, skill: "intermediate", windMinKn: 15, windMaxKn: 25 });
    }
    const ids = [...prompt.matchAll(/^- id (\d+):/gm)].map((m) => m[1] as string);
    return ok({
      whys: Object.fromEntries(ids.map((id) => [id, extra[id] ?? `Reason ${id}.`])),
    });
  };
}

export function setup(options: {
  script?: Script;
  authenticate?: (request: Request) => Promise<string | null>;
  explainLimiter?: RateLimiter;
  buildLimiter?: RateLimiter;
  dailyCalls?: number;
  logError?: (fields: Record<string, unknown>, message: string) => void;
  breadcrumb?: (call: RigCall) => void;
} = {}) {
  const store = new FakeStore();
  const provider = new FakeProvider(options.script ?? goodModel());
  const clock = { ms: Date.parse("2026-10-28T12:10:00Z") };
  const api = createRigApi({
    authenticate: options.authenticate ?? (async () => "a.myshopify.com"),
    store,
    provider,
    rules,
    buildLimiter: options.buildLimiter ?? new RateLimiter([{ ms: 60_000, limit: 100 }]),
    explainLimiter:
      options.explainLimiter ??
      new RateLimiter([
        { ms: 60_000, limit: 3 },
        { ms: 3_600_000, limit: 10 },
      ]),
    config: {
      model: "sonnet",
      timeoutMs: 20_000,
      dailyCalls: options.dailyCalls ?? 500,
      ipSalt: "test-salt",
      cacheSeconds: 60,
    },
    now: () => new Date(clock.ms),
    ...(options.logError ? { logError: options.logError } : {}),
    ...(options.breadcrumb ? { breadcrumb: options.breadcrumb } : {}),
  });
  return { api, store, provider, clock };
}

export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://hub.test/proxy/rig/build?shop=a.myshopify.com&signature=x", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// A response body the tests index freely; the shapes are asserted by the tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export async function read(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

