import { describe, expect, it } from "vitest";
import { ConfigError, type Environment, loadConfig } from "./config.js";

function validEnvironment(overrides: Environment = {}): Environment {
  return {
    SLACK_CLIENT_ID: "client-id",
    SLACK_CLIENT_SECRET: "client-secret",
    SLACK_SIGNING_SECRET: "signing-secret",
    SLACK_STATE_SECRET: "state-secret-state-secret-state-secret",
    REDIS_URL: "redis://localhost:6379",
    TARGET_API_BASE_URL: "https://target.example.test",
    TARGET_API_CLIENT_ID: "client-id",
    TARGET_API_CLIENT_SECRET: "client-secret",
    BOT_STATE_ENCRYPTION_KEY: "a".repeat(43),
    PUBLIC_BASE_URL: "https://food-bot.example.test",
    GEMINI_API_KEY: "gemini-key",
    PORT: "4310",
    TELEMETRY_DSN: "https://telemetry.example.test/123",
    TELEMETRY_ENVIRONMENT: "test",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("fails with every missing required configuration name", () => {
    expect(() => loadConfig({})).toThrowError(
      new ConfigError([
        "SLACK_CLIENT_ID",
        "SLACK_CLIENT_SECRET",
        "SLACK_SIGNING_SECRET",
        "SLACK_STATE_SECRET",
        "REDIS_URL",
        "TARGET_API_BASE_URL",
        "TARGET_API_CLIENT_ID",
        "TARGET_API_CLIENT_SECRET",
        "BOT_STATE_ENCRYPTION_KEY",
        "PUBLIC_BASE_URL",
      ]),
    );
  });

  it("parses Gemini production configuration without manufacturing optional secrets", () => {
    const config = loadConfig(validEnvironment());

    expect(config).toEqual({
      slack: {
        clientId: "client-id",
        clientSecret: "client-secret",
        signingSecret: "signing-secret",
        stateSecret: "state-secret-state-secret-state-secret",
      },
      redisUrl: "redis://localhost:6379",
      target: {
        apiBaseUrl: "https://target.example.test",
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      ai: { geminiApiKey: "gemini-key" },
      security: { stateEncryptionKey: "a".repeat(43) },
      publicBaseUrl: "https://food-bot.example.test",
      telemetry: {
        dsn: "https://telemetry.example.test/123",
        environment: "test",
      },
      port: 4310,
    });
  });

  it("accepts Mistral as the only configured parser provider", () => {
    const environment = validEnvironment({
      GEMINI_API_KEY: undefined,
      MISTRAL_API_KEY: "mistral-key",
    });

    expect(loadConfig(environment).ai).toEqual({ mistralApiKey: "mistral-key" });
  });

  it("requires a parser provider", () => {
    expect(() =>
      loadConfig(validEnvironment({ GEMINI_API_KEY: undefined, MISTRAL_API_KEY: undefined })),
    ).toThrowError(new ConfigError(["GEMINI_API_KEY", "MISTRAL_API_KEY"]));
  });

  it("rejects a public callback URL that is not HTTPS", () => {
    expect(() =>
      loadConfig(validEnvironment({ PUBLIC_BASE_URL: "http://food-bot.example.test" })),
    ).toThrowError(new ConfigError(["PUBLIC_BASE_URL"]));
  });
});
