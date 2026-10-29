import { describe, expect, it } from "vitest";

import { SnapshotCache } from "~/adapters/rig/snapshot-cache";

/** A load the test releases by hand, so timing is under its control. */
function gate<T>() {
  let release!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

function setup(options: { ttlMs?: number; maxStaleMs?: number } = {}) {
  let clock = 0;
  let calls = 0;
  const pending: Array<ReturnType<typeof gate<string>>> = [];
  const errors: unknown[] = [];
  const cache = new SnapshotCache<string>({
    ttlMs: options.ttlMs ?? 300_000,
    maxStaleMs: options.maxStaleMs ?? 1_800_000,
    now: () => clock,
    load: () => {
      calls += 1;
      const entry = gate<string>();
      pending.push(entry);
      return entry.promise;
    },
    onRefreshError: (_key, error) => errors.push(error),
  });
  return {
    cache,
    errors,
    pending,
    advance: (ms: number) => {
      clock += ms;
    },
    calls: () => calls,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SnapshotCache: single flight", () => {
  it("shares one load between callers that arrive while it runs", async () => {
    const t = setup();
    const a = t.cache.get("shop");
    const b = t.cache.get("shop");
    const c = t.cache.get("shop");
    expect(t.calls()).toBe(1);
    t.pending[0]?.release("v1");
    expect(await Promise.all([a, b, c])).toEqual(["v1", "v1", "v1"]);
    expect(t.calls()).toBe(1);
  });

  it("keeps shops apart", async () => {
    const t = setup();
    const a = t.cache.get("a");
    const b = t.cache.get("b");
    expect(t.calls()).toBe(2);
    t.pending[0]?.release("A");
    t.pending[1]?.release("B");
    expect(await Promise.all([a, b])).toEqual(["A", "B"]);
  });

  it("starts one background refresh however many callers see the stale value", async () => {
    const t = setup();
    const first = t.cache.get("shop");
    t.pending[0]?.release("v1");
    await first;
    t.advance(301_000);
    const readers = await Promise.all([
      t.cache.get("shop"),
      t.cache.get("shop"),
      t.cache.get("shop"),
    ]);
    expect(readers).toEqual(["v1", "v1", "v1"]);
    expect(t.calls()).toBe(2);
  });
});

describe("SnapshotCache: stale while revalidate", () => {
  it("serves a fresh value without loading", async () => {
    const t = setup();
    const first = t.cache.get("shop");
    t.pending[0]?.release("v1");
    await first;
    t.advance(299_000);
    expect(await t.cache.get("shop")).toBe("v1");
    expect(t.calls()).toBe(1);
  });

  it("serves the stale value at once while the refresh is still running, then the new one", async () => {
    const t = setup();
    const first = t.cache.get("shop");
    t.pending[0]?.release("v1");
    await first;

    t.advance(301_000);
    // The refresh has not finished, and the caller did not wait for it.
    expect(await t.cache.get("shop")).toBe("v1");
    expect(t.calls()).toBe(2);

    t.pending[1]?.release("v2");
    await flush();
    expect(await t.cache.get("shop")).toBe("v2");
    expect(t.calls()).toBe(2);
  });

  it("keeps the stale value when the refresh fails, reports it, and tries again", async () => {
    const t = setup();
    const first = t.cache.get("shop");
    t.pending[0]?.release("v1");
    await first;

    t.advance(301_000);
    expect(await t.cache.get("shop")).toBe("v1");
    t.pending[1]?.fail(new Error("db down"));
    await flush();
    expect(t.errors).toHaveLength(1);

    expect(await t.cache.get("shop")).toBe("v1");
    expect(t.calls()).toBe(3);
  });

  it("makes the caller wait once the value is older than the stale limit", async () => {
    const t = setup({ maxStaleMs: 600_000 });
    const first = t.cache.get("shop");
    t.pending[0]?.release("v1");
    await first;

    t.advance(601_000);
    const waiting = t.cache.get("shop");
    expect(t.calls()).toBe(2);
    t.pending[1]?.release("v2");
    expect(await waiting).toBe("v2");
  });

  it("makes the first caller wait, and passes its error on", async () => {
    const t = setup();
    const first = t.cache.get("shop");
    t.pending[0]?.fail(new Error("db down"));
    await expect(first).rejects.toThrow("db down");
    // Nothing was cached, so the next call loads again.
    const second = t.cache.get("shop");
    expect(t.calls()).toBe(2);
    t.pending[1]?.release("v1");
    expect(await second).toBe("v1");
  });
});
