import { describe, expect, it } from "vitest";
import worker from "./worker.js";

const completeEnvironment = {
  SLACK_CLIENT_ID: "client-id",
  SLACK_CLIENT_SECRET: "client-secret",
  SLACK_SIGNING_SECRET: "signing-secret",
  REDIS_URL: "redis://localhost:6379",
  TARGET_API_BASE_URL: "https://target.example.test",
  TARGET_API_CLIENT_CREDENTIAL: "credential",
  AI_PROVIDER: "test-provider",
  AI_API_KEY: "api-key",
};

describe("Cloudflare Worker", () => {
  it("serves the health response with valid bindings", async () => {
    const response = await worker.fetch(
      new Request("https://bot.example/health"),
      completeEnvironment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("hides invalid binding details", async () => {
    const response = await worker.fetch(new Request("https://bot.example/health"), {});

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal Server Error" });
  });
});
