import { describe, expect, it, vi } from "vitest";
import { notifySlackLinkCompleted, resolveAiCredentials } from "./runtime.js";

describe("Cloudflare AI credentials", () => {
  it("uses the legacy generic key for a configured Gemini provider", () => {
    expect(resolveAiCredentials({ AI_PROVIDER: "gemini", AI_API_KEY: "key" })).toEqual({
      geminiApiKey: "key",
    });
  });
});

describe("Slack link completion", () => {
  it("sends the linked user a direct Slack confirmation", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://slack.com/api/chat.postMessage");
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          Authorization: "Bearer bot-token",
          "content-type": "application/json; charset=utf-8",
        },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "U1",
        text: "Your Dofek account is linked. You can log food now.",
      });
      return Response.json({ ok: true, ts: "1.0" });
    });
    vi.stubGlobal("fetch", fetch);

    try {
      await notifySlackLinkCompleted({
        teamId: "T1",
        userId: "U1",
        store: {
          loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
