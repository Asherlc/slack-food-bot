import { describe, expect, it } from "vitest";
import { EncryptedJsonStore, type StringRedisClient } from "./encrypted-json-store.js";

class MemoryRedis implements StringRedisClient {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

describe("EncryptedJsonStore", () => {
  it("stores JSON encrypted and retrieves its original value", async () => {
    const redis = new MemoryRedis();
    const store = new EncryptedJsonStore(redis, Buffer.alloc(32, 4));

    await store.set("grant:T1:U1", { accessToken: "secret", grantId: "grant-1" });

    expect(redis.values.get("grant:T1:U1")).not.toContain("secret");
    await expect(
      store.get<{ accessToken: string; grantId: string }>("grant:T1:U1"),
    ).resolves.toEqual({
      accessToken: "secret",
      grantId: "grant-1",
    });
  });

  it("returns null for an absent record", async () => {
    const store = new EncryptedJsonStore(new MemoryRedis(), Buffer.alloc(32, 4));

    await expect(store.get("missing")).resolves.toBeNull();
  });
});
