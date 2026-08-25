import { describe, expect, it, vi } from "vitest";
import { DofekClient } from "./client.js";

describe("DofekClient", () => {
  it("preserves the global fetch receiver when no fetch override is supplied", async () => {
    const originalFetch = globalThis.fetch;
    const receiverAwareFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        Response.json({
          linkId: "link-1",
          authorizationUrl: "https://dofek.example.test/link",
          expiresAt: "2026-08-20T20:00:00.000Z",
        }),
      );
    });
    globalThis.fetch = receiverAwareFetch as typeof fetch;
    try {
      const client = new DofekClient({
        baseUrl: "https://dofek.example.test",
        clientId: "ext_client",
        clientSecret: "secret",
      });

      await expect(
        client.startIdentityLink({
          redirectUri: "https://food-bot.example.test/dofek/link/callback",
          codeChallenge: "a".repeat(43),
          requestedScopes: ["nutrition:write"],
        }),
      ).resolves.toMatchObject({ linkId: "link-1" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("starts a PKCE link using client credentials", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        linkId: "link-1",
        authorizationUrl: "https://dofek.example.test/api/external/v1/link/authorize?linkId=link-1",
        expiresAt: "2026-08-20T20:00:00.000Z",
      }),
    );
    const client = new DofekClient({
      baseUrl: "https://dofek.example.test",
      clientId: "ext_client",
      clientSecret: "secret",
      fetch,
    });

    await expect(
      client.startIdentityLink({
        redirectUri: "https://food-bot.example.test/dofek/link/callback",
        codeChallenge: "a".repeat(43),
        requestedScopes: ["nutrition:write"],
      }),
    ).resolves.toEqual({
      linkId: "link-1",
      authorizationUrl: "https://dofek.example.test/api/external/v1/link/authorize?linkId=link-1",
      expiresAt: "2026-08-20T20:00:00.000Z",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://dofek.example.test/api/external/v1/link/start",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ext_client.secret" }),
      }),
    );
  });

  it("reissues a grant using client credentials and the external subject", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        externalSubject: "opaque-subject",
        grantId: "grant-1",
        accessToken: "new-token",
        tokenType: "Bearer",
        expiresIn: 900,
        scope: "nutrition:write",
      }),
    );
    const client = new DofekClient({
      baseUrl: "https://dofek.example.test",
      clientId: "ext_client",
      clientSecret: "secret",
      fetch,
    });

    await expect(
      client.reissueGrant({ identity: { namespace: "slack", subject: "T1:U1" } }),
    ).resolves.toEqual({
      externalSubject: "opaque-subject",
      grantId: "grant-1",
      accessToken: "new-token",
      expiresInSeconds: 900,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://dofek.example.test/api/external/v1/link/reissue",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer ext_client.secret" }),
        body: JSON.stringify({ namespace: "slack", subject: "T1:U1" }),
      }),
    );
  });

  it("exchanges an approved PKCE link using the application identity", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        externalSubject: "opaque-subject",
        grantId: "grant-1",
        accessToken: "access-token",
        tokenType: "Bearer",
        expiresIn: 900,
        scope: "nutrition:write",
      }),
    );
    const client = new DofekClient({
      baseUrl: "https://dofek.example.test",
      clientId: "ext_client",
      clientSecret: "secret",
      fetch,
    });

    await expect(
      client.exchangeIdentityLink({
        linkId: "link-1",
        code: "one-time-code",
        codeVerifier: "a".repeat(43),
        identity: { namespace: "slack", subject: "T1:U1" },
      }),
    ).resolves.toEqual({
      externalSubject: "opaque-subject",
      grantId: "grant-1",
      accessToken: "access-token",
      expiresInSeconds: 900,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://dofek.example.test/api/external/v1/link/exchange",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer ext_client.secret" }),
        body: JSON.stringify({
          linkId: "link-1",
          code: "one-time-code",
          codeVerifier: "a".repeat(43),
          externalSubject: { namespace: "slack", subject: "T1:U1" },
        }),
      }),
    );
  });

  it("writes confirmed food with the grant bearer token and stable idempotency key", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        entries: [{ id: "entry-1", externalId: "draft-1" }],
        dailyIntake: {
          date: "2026-08-20",
          state: "available",
          summary: { calories: 320 },
          resolution: { source: "server" },
        },
      }),
    );
    const client = new DofekClient({
      baseUrl: "https://dofek.example.test",
      clientId: "ext_client",
      clientSecret: "secret",
      fetch,
    });
    const entry = {
      date: "2026-08-20",
      meal: "breakfast" as const,
      foodName: "Oatmeal",
      foodDescription: "One bowl",
      category: "breads_and_cereals" as const,
      nutrients: { calories: 320, protein_g: 12, carbs_g: 48, fat_g: 6 },
      externalId: "draft-1",
    };

    await expect(
      client.confirmFood({
        grant: {
          externalSubject: "opaque-subject",
          grantId: "grant-1",
          accessToken: "access-token",
          expiresInSeconds: 900,
        },
        idempotencyKey: "confirmation-draft-1",
        entries: [entry],
      }),
    ).resolves.toEqual({
      entries: [{ id: "entry-1", externalId: "draft-1" }],
      dailyIntake: {
        date: "2026-08-20",
        state: "available",
        summary: { calories: 320 },
        resolution: { source: "server" },
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://dofek.example.test/api/external/v1/nutrition/entries",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "Idempotency-Key": "confirmation-draft-1",
        }),
        body: JSON.stringify({
          entries: [
            {
              ...entry,
              nutrients: { calories: 320, protein: 12, carbohydrate: 48, fat: 6 },
            },
          ],
        }),
      }),
    );
  });
});
