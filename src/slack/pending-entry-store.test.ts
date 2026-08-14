import { describe, expect, it } from "vitest";
import {
  InMemoryPendingEntryStore,
  type PendingEntryInput,
  type PendingRedisClient,
  RedisPendingEntryStore,
} from "./pending-entry-store.js";

const entry = (externalSubject = "opaque-subject"): PendingEntryInput => ({
  externalSubject,
  item: {
    foodName: "Oatmeal",
    foodDescription: "One bowl",
    category: "breads_and_cereals",
    meal: "breakfast",
    nutrients: { calories: 320 },
  },
  channelId: "channel",
  confirmationMessageTs: "1700000000.000001",
  threadTs: "1700000000.000000",
  sourceMessageTs: "1700000000.000000",
  slackUserId: "slack-user",
});

describe.each([
  ["in-memory", () => new InMemoryPendingEntryStore()],
  [
    "redis",
    () => {
      const redis = new FakeRedisClient();
      return new RedisPendingEntryStore(() => Promise.resolve(redis));
    },
  ],
])("%s pending entry store", (_name, createStore) => {
  it("round-trips entries and indexes them by confirmation message", async () => {
    const store = createStore();
    const ids = await store.save([entry()]);

    expect(ids).toHaveLength(1);
    await expect(store.loadByIds(ids)).resolves.toMatchObject([
      { id: ids[0], externalSubject: "opaque-subject" },
    ]);
    await expect(store.findIdsByMessage("channel", "1700000000.000001")).resolves.toEqual(ids);
  });

  it("makes deletion and subject cleanup idempotent", async () => {
    const store = createStore();
    const ids = await store.save([entry(), entry("another-subject")]);
    const firstId = ids[0];
    if (!firstId) throw new Error("test setup did not create a pending entry");

    await store.deleteByIds([firstId, firstId, "missing"]);
    await expect(store.loadByIds([firstId])).resolves.toEqual([]);
    await store.deleteBySubject("another-subject");
    await store.deleteBySubject("another-subject");

    await expect(store.loadByIds(ids)).resolves.toEqual([]);
  });
});

class FakeRedisClient implements PendingRedisClient {
  readonly values = new Map<string, { value: string; expiresAt?: number }>();

  async set(key: string, value: string, options: { PX: number }): Promise<string | null> {
    this.values.set(key, { value, expiresAt: Date.now() + options.PX });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const value = this.values.get(key);
    if (!value) return null;
    if (value.expiresAt !== undefined && value.expiresAt <= Date.now()) {
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
