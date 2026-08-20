import { z } from "zod";

const requiredConfiguration = [
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_STATE_SECRET",
  "REDIS_URL",
  "TARGET_API_BASE_URL",
  "TARGET_API_CLIENT_CREDENTIAL",
  "BOT_STATE_ENCRYPTION_KEY",
  "PUBLIC_BASE_URL",
] as const;

const configurationSchema = z.object({
  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_STATE_SECRET: z.string().min(32),
  REDIS_URL: z.url(),
  TARGET_API_BASE_URL: z.url(),
  TARGET_API_CLIENT_CREDENTIAL: z.string().min(1),
  BOT_STATE_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  PUBLIC_BASE_URL: z.url().refine((value) => new URL(value).protocol === "https:"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  MISTRAL_API_KEY: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TELEMETRY_DSN: z.url().optional(),
  TELEMETRY_ENVIRONMENT: z.string().min(1).optional(),
});

export type AppConfig = {
  slack: {
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    stateSecret: string;
  };
  redisUrl: string;
  target: {
    apiBaseUrl: string;
    clientCredential: string;
  };
  ai: {
    geminiApiKey?: string;
    mistralApiKey?: string;
  };
  security: {
    stateEncryptionKey: string;
  };
  publicBaseUrl: string;
  telemetry: {
    dsn?: string;
    environment?: string;
  };
  port: number;
};

export type Environment = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  readonly missingKeys: readonly string[];

  constructor(missingKeys: readonly string[]) {
    super(`Missing or invalid required configuration: ${missingKeys.join(", ")}`);
    this.name = "ConfigError";
    this.missingKeys = missingKeys;
  }
}

export function loadConfig(env: Environment = process.env): AppConfig {
  const missingKeys = requiredConfiguration.filter((key) => !env[key]?.trim());
  if (missingKeys.length > 0) {
    throw new ConfigError(missingKeys);
  }

  if (!env.GEMINI_API_KEY?.trim() && !env.MISTRAL_API_KEY?.trim()) {
    throw new ConfigError(["GEMINI_API_KEY", "MISTRAL_API_KEY"]);
  }

  const result = configurationSchema.safeParse(env);
  if (!result.success) {
    const invalidKeys = result.error.issues
      .map((issue) => issue.path[0])
      .filter((key): key is string => typeof key === "string");
    throw new ConfigError([...new Set(invalidKeys)]);
  }

  const value = result.data;
  return {
    slack: {
      clientId: value.SLACK_CLIENT_ID,
      clientSecret: value.SLACK_CLIENT_SECRET,
      signingSecret: value.SLACK_SIGNING_SECRET,
      stateSecret: value.SLACK_STATE_SECRET,
    },
    redisUrl: value.REDIS_URL,
    target: {
      apiBaseUrl: value.TARGET_API_BASE_URL,
      clientCredential: value.TARGET_API_CLIENT_CREDENTIAL,
    },
    ai: {
      ...(value.GEMINI_API_KEY ? { geminiApiKey: value.GEMINI_API_KEY } : {}),
      ...(value.MISTRAL_API_KEY ? { mistralApiKey: value.MISTRAL_API_KEY } : {}),
    },
    security: { stateEncryptionKey: value.BOT_STATE_ENCRYPTION_KEY },
    publicBaseUrl: value.PUBLIC_BASE_URL,
    telemetry: {
      ...(value.TELEMETRY_DSN ? { dsn: value.TELEMETRY_DSN } : {}),
      ...(value.TELEMETRY_ENVIRONMENT ? { environment: value.TELEMETRY_ENVIRONMENT } : {}),
    },
    port: value.PORT,
  };
}
