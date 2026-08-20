export type SlackQueueJob =
  | {
      kind: "event";
      deliveryId: string;
      payload: Record<string, unknown>;
    }
  | {
      kind: "action";
      action: "confirm" | "cancel";
      deliveryId: string;
      payload: Record<string, unknown>;
    };

type SlackDependencies = {
  signingSecret: string;
  recordDelivery(deliveryId: string): Promise<boolean>;
  enqueue(job: SlackQueueJob): Promise<void>;
  startLink?(identity: {
    namespace: string;
    subject: string;
  }): Promise<{ authorizationUrl: string }>;
};

export async function handleSlackRequest(
  request: Request,
  dependencies: SlackDependencies,
): Promise<Response> {
  if (request.method !== "POST") return notFound();
  const path = new URL(request.url).pathname;
  if (path !== "/slack/events" && path !== "/slack/actions" && path !== "/slack/commands")
    return notFound();

  const body = await request.text();
  if (!(await hasValidSignature(request.headers, body, dependencies.signingSecret)))
    return unauthorized();

  if (path === "/slack/actions") return handleAction(body, dependencies);
  if (path === "/slack/commands") return handleCommand(body, dependencies);

  let payload: Record<string, unknown>;
  try {
    payload = asObject(JSON.parse(body));
  } catch {
    return badRequest();
  }

  if (payload.type === "url_verification") {
    const challenge = stringField(payload, "challenge");
    return challenge ? Response.json({ challenge }) : badRequest();
  }

  if (payload.type !== "event_callback") return Response.json({ ok: true });
  const deliveryId = stringField(payload, "event_id");
  if (!deliveryId) return badRequest();
  if (!(await dependencies.recordDelivery(deliveryId))) return Response.json({ ok: true });
  await dependencies.enqueue({ kind: "event", deliveryId, payload });
  return Response.json({ ok: true });
}

async function handleAction(
  body: string,
  dependencies: Pick<SlackDependencies, "recordDelivery" | "enqueue">,
): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    const encoded = new URLSearchParams(body).get("payload");
    payload = asObject(JSON.parse(encoded ?? ""));
  } catch {
    return badRequest();
  }
  const actionId = nestedString(payload, "actions", 0, "action_id");
  const action =
    actionId === "food_confirm" ? "confirm" : actionId === "food_cancel" ? "cancel" : null;
  const teamId = nestedString(payload, "team", "id");
  const userId = nestedString(payload, "user", "id");
  const messageTs = nestedString(payload, "container", "message_ts");
  if (!action || !teamId || !userId || !messageTs) return badRequest();
  const deliveryId = `action:${action}:${teamId}:${userId}:${messageTs}`;
  if (await dependencies.recordDelivery(deliveryId))
    await dependencies.enqueue({ kind: "action", action, deliveryId, payload });
  return Response.json({ ok: true });
}

async function handleCommand(body: string, dependencies: SlackDependencies): Promise<Response> {
  if (!dependencies.startLink) return badRequest();
  const command = new URLSearchParams(body);
  if (command.get("command") !== "/link-dofek") return badRequest();
  const teamId = command.get("team_id");
  const userId = command.get("user_id");
  if (!teamId || !userId) return badRequest();
  const link = await dependencies.startLink({ namespace: "slack", subject: `${teamId}:${userId}` });
  return Response.json({
    response_type: "ephemeral",
    text: `Finish linking your Dofek account: ${link.authorizationUrl}`,
  });
}

async function hasValidSignature(
  headers: Headers,
  body: string,
  signingSecret: string,
): Promise<boolean> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() / 1_000 - requestTime) > 300)
    return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    fromHex(signature.slice(3)) as unknown as BufferSource,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function nestedString(
  value: Record<string, unknown>,
  key: string,
  nestedKey: string | number,
  childKey?: string,
): string | undefined {
  const nested = value[key];
  if (Array.isArray(nested) && typeof nestedKey === "number") {
    const child = nested[nestedKey];
    return child && typeof child === "object" && childKey
      ? stringField(child as Record<string, unknown>, childKey)
      : undefined;
  }
  return nested && typeof nested === "object" && typeof nestedKey === "string"
    ? stringField(nested as Record<string, unknown>, nestedKey)
    : undefined;
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function badRequest(): Response {
  return Response.json({ error: "Bad Request" }, { status: 400 });
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}
