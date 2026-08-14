import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("fails with every missing required configuration name", () => {
    expect(() => loadConfig({})).toThrowError(
      new ConfigError([
        "SLACK_CLIENT_ID",
        "SLACK_CLIENT_SECRET",
        "SLACK_SIGNING_SECRET",
        "REDIS_URL",
        "TARGET_API_BASE_URL",
        "TARGET_API_CLIENT_CREDENTIAL",
        "AI_PROVIDER",
        "AI_API_KEY",
      ]),
    );
  });

  it("parses complete configuration without manufacturing optional secrets", () => {
    const config = loadConfig({
      SLACK_CLIENT_ID: "client-id",
      SLACK_CLIENT_SECRET: "client-secret",
      SLACK_SIGNING_SECRET: "signing-secret",
      REDIS_URL: "redis://localhost:6379",
      TARGET_API_BASE_URL: "https://target.example.test",
      TARGET_API_CLIENT_CREDENTIAL: "client-credential",
      AI_PROVIDER: "test-provider",
      AI_API_KEY: "ai-key",
      PORT: "4310",
      TELEMETRY_DSN: "https://telemetry.example.test/123",
      TELEMETRY_ENVIRONMENT: "test",
    });

    expect(config).toEqual({
      slack: {
        clientId: "client-id",
        clientSecret: "client-secret",
        signingSecret: "signing-secret",
      },
      redisUrl: "redis://localhost:6379",
      target: {
        apiBaseUrl: "https://target.example.test",
        clientCredential: "client-credential",
      },
      ai: { provider: "test-provider", apiKey: "ai-key" },
      telemetry: {
        dsn: "https://telemetry.example.test/123",
        environment: "test",
      },
      port: 4310,
    });
  });
});
