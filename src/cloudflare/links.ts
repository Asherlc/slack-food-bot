import type { ExternalIdentity, TargetGrant } from "../targets/types.js";

type LinkTarget = {
  startIdentityLink(input: {
    redirectUri: string;
    codeChallenge: string;
    requestedScopes: ReadonlyArray<string>;
    state?: string;
  }): Promise<{ linkId: string; authorizationUrl: string; expiresAt: string }>;
  exchangeIdentityLink(input: {
    linkId: string;
    code: string;
    codeVerifier: string;
    identity: ExternalIdentity;
  }): Promise<TargetGrant>;
};

type LinkState = { linkId: string; verifier: string; identity: ExternalIdentity };

export async function startDofekLink(input: {
  identity: ExternalIdentity;
  redirectUri: string;
  store: { saveLink(state: string, value: LinkState, ttlSeconds: number): Promise<void> };
  target: Pick<LinkTarget, "startIdentityLink">;
}): Promise<{ authorizationUrl: string }> {
  const verifier = randomBase64Url(48);
  const state = randomBase64Url(32);
  const start = await input.target.startIdentityLink({
    redirectUri: input.redirectUri,
    codeChallenge: await pkceS256(verifier),
    requestedScopes: ["nutrition:write"],
    state,
  });
  const expiry = Date.parse(start.expiresAt);
  const ttlSeconds = Number.isFinite(expiry)
    ? Math.max(1, Math.min(3_600, Math.floor((expiry - Date.now()) / 1_000)))
    : 600;
  await input.store.saveLink(
    state,
    { linkId: start.linkId, verifier, identity: input.identity },
    ttlSeconds,
  );
  return { authorizationUrl: start.authorizationUrl };
}

export async function completeDofekLink(input: {
  state: string;
  code: string;
  linkId: string;
  store: {
    consumeLink(state: string): Promise<LinkState | null>;
    saveGrant(subject: string, grant: TargetGrant): Promise<void>;
  };
  target: Pick<LinkTarget, "exchangeIdentityLink">;
}): Promise<ExternalIdentity> {
  const link = await input.store.consumeLink(input.state);
  if (!link || link.linkId !== input.linkId) throw new Error("Invalid or expired link state");
  const grant = await input.target.exchangeIdentityLink({
    linkId: input.linkId,
    code: input.code,
    codeVerifier: link.verifier,
    identity: link.identity,
  });
  await input.store.saveGrant(link.identity.subject, grant);
  return link.identity;
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return toBase64Url(digest);
}

function randomBase64Url(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return toBase64Url(bytes);
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
