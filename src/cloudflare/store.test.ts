import { describe, expect, it } from "vitest";
import { CloudflareStore, type D1DatabaseLike } from "./store.js";

class MemoryD1 implements D1DatabaseLike {
  readonly installations = new Map<string, string>();
  readonly grants = new Map<string, string>();
  readonly pending = new Map<string, string>();
  readonly links = new Map<string, string>();
  readonly values: string[] = [];
  readonly deliveries = new Set<string>();

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM installations")) {
            const value = this.installations.get(String(values[0]));
            return value ? ({ ciphertext: value } as T) : null;
          }
          if (query.includes("FROM grants")) {
            const value = this.grants.get(String(values[0]));
            return value ? ({ ciphertext: value } as T) : null;
          }
          if (query.includes("FROM pending_entries")) {
            const rows = [...this.pending.values()].map((ciphertext) => ({ ciphertext }));
            return (rows[0] as T | undefined) ?? null;
          }
          if (query.includes("DELETE FROM links")) {
            const value = this.links.get(String(values[0]));
            this.links.delete(String(values[0]));
            return value ? ({ ciphertext: value } as T) : null;
          }
          return null;
        },
        all: async <T>() => {
          if (query.includes("FROM pending_entries")) {
            return {
              results: [...this.pending.values()].map((ciphertext) => ({ ciphertext }) as T),
            };
          }
          return { results: [] as T[] };
        },
        run: async () => {
          this.values.push(...values.map(String));
          if (query.includes("INTO installations"))
            this.installations.set(String(values[0]), String(values[1]));
          if (query.includes("INTO grants")) this.grants.set(String(values[0]), String(values[1]));
          if (query.includes("INTO pending_entries"))
            this.pending.set(String(values[0]), String(values[1]));
          if (query.includes("DELETE FROM pending_entries")) {
            for (const id of values) this.pending.delete(String(id));
          }
          if (query.includes("INTO links")) this.links.set(String(values[0]), String(values[1]));
          if (query.includes("INTO deliveries")) {
            const deliveryId = String(values[0]);
            if (this.deliveries.has(deliveryId)) return { meta: { changes: 0 } };
            this.deliveries.add(deliveryId);
          }
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

const encryptionKey = "REDACTED_TEST_ENCRYPTION_KEY";

describe("CloudflareStore", () => {
  it("encrypts Slack installations before storing and restores them", async () => {
    const database = new MemoryD1();
    const store = new CloudflareStore(database, encryptionKey);
    const installation = { teamId: "T1", botToken: "test-bot-token" };

    await store.saveInstallation("T1", installation);

    expect(database.values.join(" ")).not.toContain("test-bot-token");
    await expect(store.loadInstallation<typeof installation>("T1")).resolves.toEqual(installation);
  });

  it("consumes Dofek link state only once", async () => {
    const store = new CloudflareStore(new MemoryD1(), encryptionKey);
    await store.saveLink("state-1", { verifier: "verifier", linkId: "link-1" }, 600);

    await expect(
      store.consumeLink<{ verifier: string; linkId: string }>("state-1"),
    ).resolves.toEqual({
      verifier: "verifier",
      linkId: "link-1",
    });
    await expect(store.consumeLink("state-1")).resolves.toBeNull();
  });

  it("accepts each Slack delivery ID once", async () => {
    const store = new CloudflareStore(new MemoryD1(), encryptionKey);

    await expect(store.recordDelivery("Ev1")).resolves.toBe(true);
    await expect(store.recordDelivery("Ev1")).resolves.toBe(false);
  });

  it("encrypts and restores a Dofek grant by Slack identity", async () => {
    const database = new MemoryD1();
    const store = new CloudflareStore(database, encryptionKey);
    const grant = { accessToken: "dofek-secret", grantId: "grant-1" };

    await store.saveGrant("T1:U1", grant);

    expect(database.values.join(" ")).not.toContain("dofek-secret");
    await expect(store.loadGrant<typeof grant>("T1:U1")).resolves.toEqual(grant);
  });

  it("encrypts pending drafts and finds them by their confirmation message", async () => {
    const database = new MemoryD1();
    const store = new CloudflareStore(database, encryptionKey);
    const entry = {
      id: "entry-1",
      channelId: "D1",
      confirmationMessageTs: "2.0",
      item: { foodName: "oatmeal" },
    };

    await store.savePending([entry], 3_600);

    expect(database.values.join(" ")).not.toContain("oatmeal");
    await expect(store.findPending<typeof entry>("D1", "2.0")).resolves.toEqual([entry]);
    await store.deletePending(["entry-1"]);
    await expect(store.findPending("D1", "2.0")).resolves.toEqual([]);
  });
});
