import { describe, expect, it } from "vitest";
import type { ExternalIdentity, IdentityLinkStart, TargetGrant } from "../targets/types.js";
import { completeSlackDofekLink, startSlackDofekLink } from "./link-flow.js";
import type { DofekLinkStore, PendingDofekLink } from "./link-store.js";

class FakeLinkStore implements Pick<DofekLinkStore, "create" | "consume" | "saveGrant"> {
  created?: { state: string; link: PendingDofekLink; ttlMs?: number };
  consumed = false;
  savedGrant?: { identity: ExternalIdentity; grant: TargetGrant };

  async create(state: string, link: PendingDofekLink, ttlMs?: number): Promise<void> {
    this.created = { state, link, ...(ttlMs === undefined ? {} : { ttlMs }) };
  }

  async consume(state: string): Promise<PendingDofekLink | null> {
    if (this.consumed || this.created?.state !== state) return null;
    this.consumed = true;
    return this.created.link;
  }

  async saveGrant(identity: ExternalIdentity, grant: TargetGrant): Promise<void> {
    this.savedGrant = { identity, grant };
  }
}

describe("Slack Dofek link flow", () => {
  it("starts a PKCE-bound Dofek link and stores its one-time callback state", async () => {
    const store = new FakeLinkStore();
    const target = {
      async startIdentityLink(input: {
        redirectUri: string;
        codeChallenge: string;
        requestedScopes: ReadonlyArray<string>;
        state?: string;
      }): Promise<IdentityLinkStart> {
        expect(input).toMatchObject({
          redirectUri: "https://bot.example.test/dofek/link/callback",
          requestedScopes: ["nutrition:write"],
        });
        expect(input.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(input.state).toBe("state-1");
        return {
          linkId: "link-1",
          authorizationUrl: "https://dofek.example.test/authorize?linkId=link-1",
          expiresAt: "2099-08-20T20:00:00.000Z",
        };
      },
    };

    await expect(
      startSlackDofekLink({
        target,
        store,
        identity: { namespace: "slack", subject: "T1:U1" },
        redirectUri: "https://bot.example.test/dofek/link/callback",
        generate: () => "state-1",
      }),
    ).resolves.toEqual({ authorizationUrl: "https://dofek.example.test/authorize?linkId=link-1" });
    expect(store.created).toMatchObject({
      state: "state-1",
      link: { linkId: "link-1", identity: { namespace: "slack", subject: "T1:U1" } },
    });
    expect(store.created?.link.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("exchanges a callback once and saves its Dofek grant", async () => {
    const store = new FakeLinkStore();
    await store.create("state-1", {
      linkId: "link-1",
      codeVerifier: "v".repeat(43),
      identity: { namespace: "slack", subject: "T1:U1" },
    });
    const target = {
      async exchangeIdentityLink(input: {
        linkId: string;
        code: string;
        codeVerifier: string;
        identity: ExternalIdentity;
      }): Promise<TargetGrant> {
        expect(input).toEqual({
          linkId: "link-1",
          code: "code-1",
          codeVerifier: "v".repeat(43),
          identity: { namespace: "slack", subject: "T1:U1" },
        });
        return {
          externalSubject: "opaque-subject",
          grantId: "grant-1",
          accessToken: "access-token",
          expiresInSeconds: 900,
        };
      },
    };

    await expect(
      completeSlackDofekLink({ target, store, state: "state-1", linkId: "link-1", code: "code-1" }),
    ).resolves.toEqual({ externalSubject: "opaque-subject" });
    expect(store.savedGrant).toEqual({
      identity: { namespace: "slack", subject: "T1:U1" },
      grant: {
        externalSubject: "opaque-subject",
        grantId: "grant-1",
        accessToken: "access-token",
        expiresInSeconds: 900,
      },
    });
    await expect(
      completeSlackDofekLink({ target, store, state: "state-1", linkId: "link-1", code: "code-1" }),
    ).rejects.toThrow("Invalid or expired link state");
  });
});
