import { createHmac } from "node:crypto";

/**
 * Per-caller rate limiting for the public rig routes (docs/rig-builder.md §
 * Limits). A sliding window per key in this process's memory: the web
 * process is one, a restart forgets the counts, and a second web instance
 * would count on its own. That is acceptable for a bound on abuse; it is not
 * an accounting system (the daily AI budget is, and it lives in `ai_usage`).
 */

export interface Window {
  ms: number;
  limit: number;
}

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

const MAX_KEYS = 20_000;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windows: readonly Window[]) {}

  /** Records the call when allowed. A refused call is not recorded. */
  check(key: string, nowMs: number): LimitResult {
    const longest = Math.max(...this.windows.map((window) => window.ms));
    const recent = (this.hits.get(key) ?? []).filter(
      (at) => at > nowMs - longest,
    );
    let retryAfter = 0;
    for (const window of this.windows) {
      const inWindow = recent.filter((at) => at > nowMs - window.ms);
      if (inWindow.length >= window.limit) {
        // The window frees a slot when its oldest counted call ages out.
        const oldest = inWindow[inWindow.length - window.limit] as number;
        retryAfter = Math.max(retryAfter, oldest + window.ms - nowMs);
      }
    }
    if (retryAfter > 0) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.ceil(retryAfter / 1000) };
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    if (this.hits.size > MAX_KEYS) this.sweep(nowMs, longest);
    return { ok: true };
  }

  private sweep(nowMs: number, longest: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((at) => at <= nowMs - longest)) this.hits.delete(key);
    }
  }
}

/**
 * The caller's address as a salted hash, so the raw address is never stored
 * or logged. The salt is a secret of this deployment: without it the
 * four-billion-address space could be hashed back.
 */
export function hashIp(ip: string, salt: string): string {
  return createHmac("sha256", salt)
    .update(`rig-ip-v1:${ip}`)
    .digest("hex")
    .slice(0, 32);
}

/** The address the request came from, as the proxies in front of the app report it. */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || "unknown";
}
