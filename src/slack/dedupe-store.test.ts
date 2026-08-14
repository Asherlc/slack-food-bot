import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DedupeRedisClient,
  InMemorySlackDedupeStore,
  RedisSlackDedupeStore,
} from "./dedupe-store.js";

describe.each([
  ["in-memory", () => new InMemorySlackDedupeStore()],
  [
    "redis",
    () => {
      const redis = new FakeRedisClient();
      return new RedisSlackDedupeStore(() => Promise.resolve(redis));
    },
  ],
])("%s Slack dedupe store", (_name, createStore) => {
  afterEach(() => vi.useRealTimers());

  it("claims once within the TTL and can reclaim after expiry", async () => {
    vi.useFakeTimers();
    const store = createStore();

    await expect(store.claim("event", 1_000, "opaque-subject")).resolves.toBe(true);
    await expect(store.claim("event", 1_000, "opaque-subject")).resolves.toBe(false);
    vi.advanceTimersByTime(1_001);
    await expect(store.claim("event", 1_000, "opaque-subject")).resolves.toBe(true);
  });

  it("removes all claims for a subject safely when repeated", async () => {
    const store = createStore();

    await store.claim("event-1", 1_000, "opaque-subject");
    await store.claim("event-2", 1_000, "opaque-subject");
    await store.deleteBySubject("opaque-subject");
    await store.deleteBySubject("opaque-subject");

    await expect(store.claim("event-1", 1_000, "opaque-subject")).resolves.toBe(true);
  });
});

class FakeRedisClient implements DedupeRedisClient {
  readonly values = new Map<string, { value: string; expiresAt: number }>();

  async set(
    key: string,
    value: string,
    options: { PX: number; NX?: boolean },
  ): Promise<"OK" | null> {
    const existing = this.values.get(key);
    if (options.NX && existing && existing.expiresAt > Date.now()) return null;
    this.values.set(key, { value, expiresAt: Date.now() + options.PX });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const value = this.values.get(key);
    if (!value || value.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return value.value;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
    }
    return deleted;
  }
}
