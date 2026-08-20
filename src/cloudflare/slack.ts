export type SlackQueueJob = {
  kind: "event";
  deliveryId: string;
  payload: Record<string, unknown>;
};

export async function handleSlackRequest(
  request: Request,
  dependencies: {
    signingSecret: string;
    recordDelivery(deliveryId: string): Promise<boolean>;
    enqueue(job: SlackQueueJob): Promise<void>;
  },
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/slack/events")
    return notFound();

  const body = await request.text();
  if (!(await hasValidSignature(request.headers, body, dependencies.signingSecret)))
    return unauthorized();

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
