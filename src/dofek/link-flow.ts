import { createHash, randomBytes } from "node:crypto";
import type { ExternalIdentity, IdentityLinkStart, TargetGrant } from "../targets/types.js";
import type { DofekLinkStore } from "./link-store.js";

type LinkStartTarget = {
  startIdentityLink(input: {
    redirectUri: string;
    codeChallenge: string;
    requestedScopes: ReadonlyArray<string>;
    state?: string;
  }): Promise<IdentityLinkStart>;
};

type LinkExchangeTarget = {
  exchangeIdentityLink(input: {
    linkId: string;
    code: string;
    codeVerifier: string;
    identity: ExternalIdentity;
  }): Promise<TargetGrant>;
};

export async function startSlackDofekLink(input: {
  target: LinkStartTarget;
  store: Pick<DofekLinkStore, "create">;
  identity: ExternalIdentity;
  redirectUri: string;
  generate?: () => string;
}): Promise<{ authorizationUrl: string }> {
  const state = input.generate?.() ?? randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const start = await input.target.startIdentityLink({
    redirectUri: input.redirectUri,
    codeChallenge: pkceS256(codeVerifier),
    requestedScopes: ["nutrition:write"],
    state,
  });
  await input.store.create(
    state,
    { linkId: start.linkId, codeVerifier, identity: input.identity },
    ttlFromExpiry(start.expiresAt),
  );
  return { authorizationUrl: start.authorizationUrl };
}

export async function completeSlackDofekLink(input: {
  target: LinkExchangeTarget;
  store: Pick<DofekLinkStore, "consume" | "saveGrant">;
  state: string;
  linkId: string;
  code: string;
}): Promise<{ externalSubject: string }> {
  const pending = await input.store.consume(input.state);
  if (!pending || pending.linkId !== input.linkId) throw new Error("Invalid or expired link state");
  const grant = await input.target.exchangeIdentityLink({
    linkId: input.linkId,
    code: input.code,
    codeVerifier: pending.codeVerifier,
    identity: pending.identity,
  });
  await input.store.saveGrant(pending.identity, grant);
  return { externalSubject: grant.externalSubject };
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function ttlFromExpiry(expiresAt: string): number {
  const remainingMs = Date.parse(expiresAt) - Date.now();
  return Number.isFinite(remainingMs) && remainingMs > 0
    ? Math.min(remainingMs, 15 * 60 * 1_000)
    : 1;
}
