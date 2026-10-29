/**
 * A per-key cache that answers fast (docs/rig-builder.md § Cache). Shopify's
 * App Proxy gives up near 5 seconds and reading the catalogue takes about 3,
 * so a buyer must never wait for a refresh when there is an older answer:
 *
 * - fresh (younger than `ttlMs`): returned as it is.
 * - stale (older than `ttlMs`, younger than `maxStaleMs`): returned at once,
 *   and one refresh runs in the background.
 * - missing, or older than `maxStaleMs`: the caller waits for the load.
 *
 * Single-flight: while a load for a key runs, every caller shares it; a
 * background refresh is never started twice. A refresh that fails keeps the
 * stale value and is tried again by the next call.
 */

export interface SnapshotCacheOptions<T> {
  /** How long a value is fresh. */
  ttlMs: number;
  /** How long a stale value may still be served; beyond it the caller waits. */
  maxStaleMs: number;
  load(key: string): Promise<T>;
  now(): number;
  /** Called with a background refresh that failed. */
  onRefreshError?(key: string, error: unknown): void;
}

interface Entry<T> {
  value: T;
  loadedAtMs: number;
}

export class SnapshotCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inFlight = new Map<string, Promise<Entry<T>>>();

  constructor(private readonly options: SnapshotCacheOptions<T>) {}

  /** Runs (or joins) the load for `key`; the entry replaces the cached one when it lands. */
  private refresh(key: string): Promise<Entry<T>> {
    const running = this.inFlight.get(key);
    if (running) return running;
    const promise = (async () => {
      try {
        const value = await this.options.load(key);
        const entry = { value, loadedAtMs: this.options.now() };
        this.entries.set(key, entry);
        return entry;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  async get(key: string): Promise<T> {
    const entry = this.entries.get(key);
    if (!entry) return (await this.refresh(key)).value;
    const age = this.options.now() - entry.loadedAtMs;
    if (age < this.options.ttlMs) return entry.value;
    if (age >= this.options.maxStaleMs) return (await this.refresh(key)).value;
    if (!this.inFlight.has(key)) {
      this.refresh(key).catch((error: unknown) => {
        this.options.onRefreshError?.(key, error);
      });
    }
    return entry.value;
  }

  /** Forgets a key, so the next call loads it. */
  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
