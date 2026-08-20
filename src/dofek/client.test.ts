import { describe, expect, it, vi } from "vitest";
import { DofekClient } from "./client.js";

describe("DofekClient", () => {
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
