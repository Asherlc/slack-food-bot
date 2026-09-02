import { describe, expect, it } from "vitest";
import { startSlackOAuth } from "./oauth.js";

describe("Slack OAuth", () => {
  it("requests access to private Slack files for photo analysis", async () => {
    const response = await startSlackOAuth({
      clientId: "client-id",
      redirectUri: "https://bot.example.test/slack/oauth_redirect",
      store: { saveLink: async () => undefined },
    });

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("scope")).toContain(
      "files:read",
    );
  });
});
