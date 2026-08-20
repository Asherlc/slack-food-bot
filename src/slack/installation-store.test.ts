import { describe, expect, it } from "vitest";
import { EncryptedJsonStore, type StringRedisClient } from "../redis/encrypted-json-store.js";
import { RedisInstallationStore } from "./installation-store.js";

class MemoryRedis implements StringRedisClient {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async getDel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

describe("RedisInstallationStore", () => {
  it("persists a Slack installation encrypted by team ID", async () => {
    const redis = new MemoryRedis();
    const store = new RedisInstallationStore(new EncryptedJsonStore(redis, Buffer.alloc(32, 9)));
    const installation = { team: { id: "T1" }, bot: { token: "xoxb-secret" } };

    await store.storeInstallation(installation);

    expect([...redis.values.values()].join(" ")).not.toContain("xoxb-secret");
    await expect(store.fetchInstallation({ teamId: "T1" })).resolves.toEqual(installation);
  });
});
