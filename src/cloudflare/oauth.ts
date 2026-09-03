type OAuthStore = {
  saveLink(state: string, value: unknown, ttlSeconds: number): Promise<void>;
  consumeLink<T>(state: string): Promise<T | null>;
  saveInstallation(teamId: string, installation: unknown): Promise<void>;
};

export async function startSlackOAuth(input: {
  clientId: string;
  redirectUri: string;
  store: Pick<OAuthStore, "saveLink">;
}): Promise<Response> {
  const state = randomBase64Url(32);
  await input.store.saveLink(state, { kind: "slack-oauth" }, 600);
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "scope",
    "app_mentions:read,chat:write,commands,files:read,im:history,im:read,im:write,users:read",
  );
  return Response.redirect(url);
}

export async function completeSlackOAuth(input: {
  code: string;
  state: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  store: OAuthStore;
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const pending = await input.store.consumeLink<{ kind?: unknown }>(input.state);
  if (pending?.kind !== "slack-oauth") throw new Error("Invalid OAuth state");
  const response = await (input.fetch ?? globalThis.fetch)(
    "https://slack.com/api/oauth.v2.access",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    },
  );
  if (!response.ok) throw new Error("Slack OAuth exchange failed");
  const result = (await response.json()) as {
    ok?: unknown;
    access_token?: unknown;
    bot_user_id?: unknown;
    team?: { id?: unknown };
  };
  if (
    result.ok !== true ||
    typeof result.access_token !== "string" ||
    typeof result.bot_user_id !== "string" ||
    typeof result.team?.id !== "string"
  ) {
    throw new Error("Slack OAuth exchange was rejected");
  }
  await input.store.saveInstallation(result.team.id, {
    botToken: result.access_token,
    botUserId: result.bot_user_id,
  });
}

function randomBase64Url(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
