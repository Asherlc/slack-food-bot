import { describe, expect, it, vi } from "vitest";
import { completeDofekLink, startDofekLink } from "./links.js";

describe("Cloudflare Dofek linking", () => {
  it("starts an S256 PKCE link and stores one-time state", async () => {
    const saveLink = vi.fn(async () => undefined);
    const result = await startDofekLink({
      identity: { namespace: "slack", subject: "T1:U1" },
      redirectUri: "https://food-bot.example/dofek/link/callback",
      store: { saveLink },
      target: {
        startIdentityLink: async (input) => {
          expect(input.redirectUri).toBe("https://food-bot.example/dofek/link/callback");
          expect(input.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
          return {
            linkId: "link-1",
            authorizationUrl: "https://dofek.example/link",
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
        },
      },
    });

    expect(result).toEqual({ authorizationUrl: "https://dofek.example/link" });
    expect(saveLink).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({
        linkId: "link-1",
        identity: { namespace: "slack", subject: "T1:U1" },
      }),
      expect.any(Number),
    );
  });

  it("exchanges each callback state once and encrypts the resulting grant", async () => {
    const saveGrant = vi.fn(async () => undefined);
    await expect(
      completeDofekLink({
        state: "state-1",
        code: "code-1",
        linkId: "link-1",
        store: {
          consumeLink: async () => ({
            linkId: "link-1",
            verifier: "verifier",
            identity: { namespace: "slack", subject: "T1:U1" },
          }),
          saveGrant,
        },
        target: {
          exchangeIdentityLink: async (input) => {
            expect(input).toEqual({
              linkId: "link-1",
              code: "code-1",
              codeVerifier: "verifier",
              identity: { namespace: "slack", subject: "T1:U1" },
            });
            return {
              externalSubject: "T1:U1",
              grantId: "grant-1",
              accessToken: "token",
              expiresInSeconds: 900,
            };
          },
        },
      }),
    ).resolves.toEqual({ namespace: "slack", subject: "T1:U1" });

    expect(saveGrant).toHaveBeenCalledWith(
      "T1:U1",
      expect.objectContaining({ grantId: "grant-1" }),
    );
  });
});
