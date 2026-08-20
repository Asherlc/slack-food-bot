import { describe, expect, it, vi } from "vitest";
import { DofekClient } from "./client.js";

describe("DofekClient", () => {
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
      clientCredential: "ext_client.secret",
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
      clientCredential: "ext_client.secret",
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
      "https://dofek.example.test/api/external/v1/link/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer ext_client.secret" }),
        body: JSON.stringify({ externalSubject: { namespace: "slack", subject: "T1:U1" } }),
      }),
    );
  });
});
