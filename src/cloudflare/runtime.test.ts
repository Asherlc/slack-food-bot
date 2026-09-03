import { describe, expect, it, vi } from "vitest";
import {
  analyzeSlackImage,
  createCloudflareNutritionAnalyzer,
  notifySlackAnalysisFailure,
  notifySlackLinkCompleted,
  publishInteractiveMessageUpdate,
  resolveSlackUserTimeZone,
  traceWorkersAiBinding,
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

describe("Cloudflare AI backend", () => {
  it("uses only the native Workers AI binding", async () => {
    const generate = vi.fn(async () => ({
      response: JSON.stringify({
        items: [
          {
            foodName: "Oatmeal",
            foodDescription: "One bowl",
            category: "breads_and_cereals",
            meal: "breakfast",
            nutrients: { calories: 320 },
          },
        ],
      }),
    }));
    const analyzer = createCloudflareNutritionAnalyzer({ AI: { run: generate } });

    await expect(analyzer.analyze("oatmeal", "08:00")).resolves.toEqual(items);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("records image presence and raw AI responses without storing image data", async () => {
    const traces: Array<{ sequence: number; outcome: string }> = [];
    const binding = traceWorkersAiBinding(
      {
        run: async () => ({
          response: '{"isFood":true,"visibleContents":"a white toilet"}',
        }),
      },
      async (sequence, outcome) => traces.push({ sequence, outcome }),
    );

    await binding.run("vision-model", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "classify" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,secret" } },
          ],
        },
      ],
    });

    expect(traces).toEqual([
      { sequence: 1, outcome: "ai-request:model=vision-model;hasImage=true" },
      {
        sequence: 2,
        outcome:
          'ai-response:model=vision-model;response={"isFood":true,"visibleContents":"a white toilet"}',
      },
    ]);
    expect(JSON.stringify(traces)).not.toContain("base64,secret");
  });
});

describe("Slack user timezone", () => {
  it("loads the sender's IANA timezone from Slack", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        user: {
          id: "U1",
          team_id: "T1",
          name: "asher",
          deleted: false,
          real_name: "Asher Cohen",
          tz: "America/Los_Angeles",
          tz_label: "Pacific Daylight Time",
          tz_offset: -25_200,
          profile: {
            real_name: "Asher Cohen",
            display_name: "asher",
          },
        },
      }),
    );

    await expect(
      resolveSlackUserTimeZone({
        teamId: "T1",
        userId: "U1",
        fallbackTimeZone: "UTC",
        store: {
          loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
        },
        fetch,
      }),
    ).resolves.toBe("America/Los_Angeles");

    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/users.info?user=U1",
      expect.objectContaining({ headers: { Authorization: "Bearer bot-token" } }),
    );
  });

  it("uses the configured timezone when Slack's user lookup times out", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let requestSignal: AbortSignal | undefined;

    try {
      await expect(
        resolveSlackUserTimeZone({
          teamId: "T1",
          userId: "U1",
          fallbackTimeZone: "America/Los_Angeles",
          timeoutMs: 1,
          store: {
            loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
          },
          fetch: async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              requestSignal = init?.signal ?? undefined;
              if (!requestSignal) {
                reject(new Error("Slack lookup did not receive an abort signal"));
                return;
              }
              requestSignal.addEventListener(
                "abort",
                () => reject(new DOMException("The operation was aborted", "AbortError")),
                { once: true },
              );
            }),
        }),
      ).resolves.toBe("America/Los_Angeles");

      expect(requestSignal?.aborted).toBe(true);
      expect(warning).toHaveBeenCalledWith("Unable to resolve Slack user timezone", {
        reason: "request_timeout",
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("uses the configured timezone when an existing Slack install lacks profile access", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        resolveSlackUserTimeZone({
          teamId: "T1",
          userId: "U1",
          fallbackTimeZone: "America/Los_Angeles",
          store: {
            loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
          },
          fetch: async () => Response.json({ ok: false, error: "missing_scope" }),
        }),
      ).resolves.toBe("America/Los_Angeles");

      expect(warning).toHaveBeenCalledWith("Unable to resolve Slack user timezone", {
        reason: "missing_scope",
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("does not include raw Slack API errors in timezone diagnostics", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rawError = "unexpected remote details\nthat must stay private";

    try {
      await expect(
        resolveSlackUserTimeZone({
          teamId: "T1",
          userId: "U1",
          fallbackTimeZone: "America/Los_Angeles",
          store: {
            loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
          },
          fetch: async () => Response.json({ ok: false, error: rawError }),
        }),
      ).resolves.toBe("America/Los_Angeles");

      expect(warning).toHaveBeenCalledWith("Unable to resolve Slack user timezone", {
        reason: "api_rejected",
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(rawError);
    } finally {
      warning.mockRestore();
    }
  });

  it("uses the configured timezone when Slack returns an invalid timezone", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        resolveSlackUserTimeZone({
          teamId: "T1",
          userId: "U1",
          fallbackTimeZone: "America/Los_Angeles",
          store: {
            loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
          },
          fetch: async () =>
            Response.json({
              ok: true,
              user: {
                id: "U1",
                team_id: "T1",
                name: "asher",
                deleted: false,
                real_name: "Asher Cohen",
                tz: "Not/AZone",
                tz_label: "Invalid Time",
                tz_offset: 0,
                profile: { real_name: "Asher Cohen", display_name: "asher" },
              },
            }),
        }),
      ).resolves.toBe("America/Los_Angeles");

      expect(warning).toHaveBeenCalledWith("Unable to resolve Slack user timezone", {
        reason: "timezone_invalid",
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("uses UTC when the configured fallback timezone is invalid", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        resolveSlackUserTimeZone({
          teamId: "T1",
          userId: "U1",
          fallbackTimeZone: "Not/AZone",
          store: {
            loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
          },
          fetch: async () => Response.json({ ok: false, error: "missing_scope" }),
        }),
      ).resolves.toBe("UTC");

      expect(warning).toHaveBeenCalledWith("Invalid default timezone configuration", {
        reason: "fallback_timezone_invalid",
      });
    } finally {
      warning.mockRestore();
    }
  });
});

describe("Slack image analysis", () => {
  it("resolves pending Slack file metadata before downloading the image", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          file: {
            mimetype: "image/jpeg",
            url_private_download: "https://files.slack.com/files-pri/T1-F1/F1.jpg",
            thumb_1024: "https://files.slack.com/files-tmb/T1-F1/F1_1024.jpg",
            thumb_480: "https://files.slack.com/files-tmb/T1-F1/F1_480.jpg",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([255, 216, 255]), {
          headers: { "content-type": "image/jpeg" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const analyzed: unknown[] = [];

    try {
      await analyzeSlackImage({
        fileId: "F1",
        text: "",
        localTime: "12:00",
        botToken: "bot-token",
        analyze: async (image, mediaType) => {
          analyzed.push({ image: [...image], mediaType });
          return items;
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenNthCalledWith(1, "https://slack.com/api/files.info?file=F1", {
      headers: { Authorization: "Bearer bot-token" },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://files.slack.com/files-tmb/T1-F1/F1_1024.jpg"),
      { headers: { Authorization: "Bearer bot-token" } },
    );
    expect(analyzed).toEqual([{ image: [255, 216, 255], mediaType: "image/jpeg" }]);
  });

  it("reports a failed Slack image download", async () => {
    vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.slack.com/files-pri/T1-F1/F1.jpg",
          mediaType: "image/jpeg",
          text: "lunch",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow("Slack image download failed with status 403");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a non-image Slack download before analysis", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("Slack error page", { headers: { "content-type": "text/html" } }),
    );

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.slack.com/files-pri/T1-F1/F1.jpg",
          mediaType: "image/jpeg",
          text: "lunch",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow("Slack image download did not return an image");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an empty Slack image before analysis", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(new Uint8Array(), { headers: { "content-type": "image/jpeg" } }),
    );

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.slack.com/files-pri/T1-F1/F1.jpg",
          mediaType: "image/jpeg",
          text: "",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow("Slack image download was empty");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an oversized Slack image from its declared length", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(new Uint8Array(), {
          headers: { "content-type": "image/jpeg", "content-length": "5242881" },
        }),
    );

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.slack.com/files-pri/T1-F1/F1.jpg",
          mediaType: "image/jpeg",
          text: "lunch",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow("Slack image download exceeds 5 MiB");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an oversized chunked Slack image before buffering it", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
              controller.close();
            },
          }),
          { headers: { "content-type": "image/jpeg" } },
        ),
    );

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.slack.com/files-pri/T1-F1/F1.jpg",
          mediaType: "image/jpeg",
          text: "lunch",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow("Slack image download exceeds 5 MiB");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a Slack image at the size limit", async () => {
    const image = new Uint8Array(5 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(image, {
          headers: { "content-type": "image/jpeg", "content-length": String(image.byteLength) },
        }),
    );
    const received: number[] = [];

    try {
      await analyzeSlackImage({
        url: "https://files.slack.com/files-pri/T1-F1/F1.jpg",
        mediaType: "image/jpeg",
        text: "lunch",
        localTime: "12:00",
        botToken: "bot-token",
        analyze: async (value) => {
          received.push(value.byteLength);
          return items;
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(received).toEqual([5 * 1024 * 1024]);
  });

  it("downloads a private Slack image with the installation token and passes only its bytes to analysis", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://files.slack.com/files-pri/T1-F1/download/F1.jpg");
      expect(init?.headers).toEqual({ Authorization: "Bearer bot-token" });
      return new Response(new Uint8Array([255, 216, 255]), {
        headers: { "content-type": "image/jpeg" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const inputs: unknown[] = [];

    try {
      await analyzeSlackImage({
        url: "https://files.slack.com/files-pri/T1-F1/download/F1.jpg",
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

  it("does not send the Slack bot token to an untrusted download host", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([255, 216, 255])));
    vi.stubGlobal("fetch", fetch);

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.example.test/F1.jpg",
          mediaType: "image/jpeg",
          text: "",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow(/Slack image URL/);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized Slack image before buffering its response", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array(), {
          headers: { "content-length": "999999999", "content-type": "image/jpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.slack.com/files-pri/T1-F1/download/F1.jpg",
          mediaType: "image/jpeg",
          text: "",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow("Slack image download exceeds 5 MiB");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops reading an oversized Slack image when content length is absent", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(6 * 1024 * 1024));
              controller.enqueue(new Uint8Array(6 * 1024 * 1024));
              controller.close();
            },
          }),
          { headers: { "content-type": "image/jpeg" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.slack.com/files-pri/T1-F1/download/F1.jpg",
          mediaType: "image/jpeg",
          text: "",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow("Slack image download exceeds 5 MiB");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a non-image Slack response instead of sending login HTML to the model", async () => {
    const fetch = vi.fn(
      async () => new Response("sign in", { headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetch);

    try {
      await expect(
        analyzeSlackImage({
          url: "https://files.slack.com/files-pri/T1-F1/download/F1.jpg",
          mediaType: "image/jpeg",
          text: "",
          localTime: "12:00",
          botToken: "bot-token",
          analyze: async () => items,
        }),
      ).rejects.toThrow("Slack image download did not return an image");
    } finally {
      vi.unstubAllGlobals();
    }
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

describe("Slack analysis failure", () => {
  it("replies in the source thread with photo recovery guidance", async () => {
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
        channel: "D1",
        thread_ts: "1.0",
        text: "I couldn't analyze that message in time. Please try again. If it included a photo, make sure Slack Food Bot was reinstalled with file access.",
      });
      return Response.json({ ok: true, ts: "2.0" });
    });
    vi.stubGlobal("fetch", fetch);

    try {
      await notifySlackAnalysisFailure({
        teamId: "T1",
        channelId: "D1",
        threadTs: "1.0",
        reason: "timeout",
        store: {
          loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("explains when a photo does not clearly contain food", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "D1",
        thread_ts: "1.0",
        text: "I couldn't confidently identify food or a drink in that photo, so I didn't create a draft.",
      });
      return Response.json({ ok: true, ts: "2.0" });
    });
    vi.stubGlobal("fetch", fetch);

    try {
      await notifySlackAnalysisFailure({
        teamId: "T1",
        channelId: "D1",
        threadTs: "1.0",
        reason: "no-food",
        store: {
          loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces Slack API error codes", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ok: false, error: "missing_scope" }));

    try {
      await expect(
        notifySlackAnalysisFailure({
          teamId: "T1",
          channelId: "D1",
          threadTs: "1.0",
          reason: "error",
          store: { loadInstallation: async <T>() => ({ botToken: "bot-token" }) as T },
        }),
      ).rejects.toThrow("Slack chat.postMessage rejected the request: missing_scope");
    } finally {
      vi.unstubAllGlobals();
    }
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
