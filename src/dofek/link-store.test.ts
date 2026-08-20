import { describe, expect, it } from "vitest";
import { EncryptedJsonStore, type StringRedisClient } from "../redis/encrypted-json-store.js";
import { DofekLinkStore } from "./link-store.js";

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

describe("DofekLinkStore", () => {
  it("consumes PKCE state exactly once without persisting the verifier in plaintext", async () => {
    const redis = new MemoryRedis();
    const store = new DofekLinkStore(new EncryptedJsonStore(redis, Buffer.alloc(32, 6)));

    await store.create("state-1", {
      linkId: "link-1",
      codeVerifier: "verifier-secret",
      identity: { namespace: "slack", subject: "T1:U1" },
    });

    expect([...redis.values.values()].join(" ")).not.toContain("verifier-secret");
    await expect(store.consume("state-1")).resolves.toEqual({
      linkId: "link-1",
      codeVerifier: "verifier-secret",
      identity: { namespace: "slack", subject: "T1:U1" },
    });
    await expect(store.consume("state-1")).resolves.toBeNull();
  });

  it("stores and loads a Dofek bearer grant encrypted by Slack identity", async () => {
    const redis = new MemoryRedis();
    const store = new DofekLinkStore(new EncryptedJsonStore(redis, Buffer.alloc(32, 6)));
    const identity = { namespace: "slack", subject: "T1:U1" };
    const grant = {
      externalSubject: "opaque-subject",
      grantId: "grant-1",
      accessToken: "access-token",
      expiresInSeconds: 900,
    };

    await store.saveGrant(identity, grant);

    expect([...redis.values.values()].join(" ")).not.toContain("access-token");
    await expect(store.loadGrant(identity)).resolves.toEqual(grant);
  });
});
