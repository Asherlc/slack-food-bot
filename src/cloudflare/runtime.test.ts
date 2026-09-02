import { describe, expect, it, vi } from "vitest";
import {
  analyzeSlackImage,
  notifySlackLinkCompleted,
  publishInteractiveMessageUpdate,
  resolveAiCredentials,
} from "./runtime.js";

const items = [
  {
    foodName: "Oatmeal",
    foodDescription: "One bowl",
    category: "breads_and_cereals" as const,
    meal: "breakfast" as const,
    nutrients: { calories: 320 },
  },
];

describe("Cloudflare AI credentials", () => {
  it("uses the legacy generic key for a configured Gemini provider", () => {
    expect(resolveAiCredentials({ AI_PROVIDER: "gemini", AI_API_KEY: "key" })).toEqual({
      geminiApiKey: "key",
    });
  });
});

describe("Slack image analysis", () => {
  it("downloads a private Slack image with the installation token and passes only its bytes to analysis", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://files.slack.test/F1.jpg");
      expect(init?.headers).toEqual({ Authorization: "Bearer bot-token" });
      return new Response(new Uint8Array([255, 216, 255]), {
        headers: { "content-type": "image/jpeg" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const inputs: unknown[] = [];

    try {
      await analyzeSlackImage({
        url: "https://files.slack.test/F1.jpg",
        mediaType: "image/jpeg",
        text: "lunch",
        localTime: "12:00",
        botToken: "bot-token",
        analyze: async (image, mediaType, text, localTime) => {
          inputs.push({ image: [...image], mediaType, text, localTime });
          return items;
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(inputs).toEqual([
      { image: [255, 216, 255], mediaType: "image/jpeg", text: "lunch", localTime: "12:00" },
    ]);
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

describe("Slack interactive response", () => {
  it("replaces the source message through Slack's response URL", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://hooks.slack.test/response");
      expect(init).toMatchObject({
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        replace_original: true,
        text: "Food log could not be saved. Try again.",
        blocks: [
          expect.objectContaining({ type: "section" }),
          expect.objectContaining({ type: "actions" }),
        ],
      });
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetch);

    try {
      await publishInteractiveMessageUpdate("https://hooks.slack.test/response", {
        text: "Food log could not be saved. Try again.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "This food log could not be saved." } },
          { type: "actions", elements: [] },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
