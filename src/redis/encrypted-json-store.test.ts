import { describe, expect, it } from "vitest";
import { EncryptedJsonStore, type StringRedisClient } from "./encrypted-json-store.js";

class MemoryRedis implements StringRedisClient {
  readonly values = new Map<string, string>();
  readonly setOptions = new Map<string, { PX: number } | undefined>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { PX: number }): Promise<"OK"> {
    this.values.set(key, value);
    this.setOptions.set(key, options);
    return "OK";
  }

  async getDel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
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

  it("expires a secret record and consumes it only once", async () => {
    const redis = new MemoryRedis();
    const store = new EncryptedJsonStore(redis, Buffer.alloc(32, 4));

    await store.set("link:state", { verifier: "secret" }, { ttlMs: 900_000 });

    expect(redis.setOptions.get("link:state")).toEqual({ PX: 900_000 });
    await expect(store.take<{ verifier: string }>("link:state")).resolves.toEqual({
      verifier: "secret",
    });
    await expect(store.take("link:state")).resolves.toBeNull();
  });
});
