import { describe, expect, it } from "vitest";
import worker, { type CloudflareEnv } from "./worker.js";

const env: CloudflareEnv = {
  SLACK_SIGNING_SECRET: "signing-secret",
  SLACK_CLIENT_ID: "client-id",
  SLACK_CLIENT_SECRET: "client-secret",
  BOT_STATE_ENCRYPTION_KEY: testEncryptionKey(),
  TARGET_API_BASE_URL: "https://dofek.example",
  TARGET_API_CLIENT_ID: "client",
  TARGET_API_CLIENT_SECRET: "credential",
  PUBLIC_BASE_URL: "https://food-bot.example",
  FOOD_BOT_DB: {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }),
  },
  FOOD_JOBS: { send: async () => undefined },
};

describe("Cloudflare Worker", () => {
  it("redirects the public root to Slack installation", async () => {
    const response = await worker.fetch(new Request("https://food-bot.example/"), env);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^https:\/\/slack\.com\/oauth\/v2\/authorize\?/,
    );
  });

  it("serves a secret-free health response without accessing state", async () => {
    const response = await worker.fetch(new Request("https://food-bot.example/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

function testEncryptionKey(): string {
  return btoa("0123456789abcdef0123456789abcdef")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
