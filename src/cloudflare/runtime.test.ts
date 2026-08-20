import { describe, expect, it } from "vitest";
import { resolveAiCredentials } from "./runtime.js";

describe("Cloudflare AI credentials", () => {
  it("uses the legacy generic key for a configured Gemini provider", () => {
    expect(resolveAiCredentials({ AI_PROVIDER: "gemini", AI_API_KEY: "key" })).toEqual({
      geminiApiKey: "key",
    });
  });
});
