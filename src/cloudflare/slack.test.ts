import { describe, expect, it } from "vitest";
import { handleSlackRequest } from "./slack.js";

const signingSecret = "slack-signing-secret";

async function signedRequest(
  path: string,
  body: string,
  contentType = "application/json",
): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const message = new TextEncoder().encode(`v0:${timestamp}:${body}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const digest = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(`https://food-bot.example${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${digest}`,
    },
    body,
  });
}

describe("Slack Worker endpoint", () => {
  it("acknowledges a new event and queues it after verifying Slack's signature", async () => {
    const jobs: unknown[] = [];
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev1",
      team_id: "T1",
      event: {
        type: "message",
        channel_type: "im",
        user: "U1",
        channel: "D1",
        ts: "1",
        text: "oatmeal",
      },
    });
    const response = await handleSlackRequest(await signedRequest("/slack/events", body), {
      signingSecret,
      recordDelivery: async () => true,
      enqueue: async (job) => {
        jobs.push(job);
      },
    });

    expect(response.status).toBe(200);
    expect(jobs).toEqual([expect.objectContaining({ kind: "event", deliveryId: "Ev1" })]);
  });

  it("returns the URL verification challenge without queueing it", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge-1" });
    const response = await handleSlackRequest(await signedRequest("/slack/events", body), {
      signingSecret,
      recordDelivery: async () => true,
      enqueue: async () => {
        throw new Error("must not enqueue URL verification");
      },
    });

    await expect(response.json()).resolves.toEqual({ challenge: "challenge-1" });
  });

  it("rejects a request with an invalid signature without exposing details", async () => {
    const response = await handleSlackRequest(
      new Request("https://food-bot.example/slack/events", {
        method: "POST",
        headers: { "x-slack-request-timestamp": "1", "x-slack-signature": "v0=bad" },
        body: "{}",
      }),
      { signingSecret, recordDelivery: async () => true, enqueue: async () => undefined },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("acknowledges a confirm action and queues its signed payload", async () => {
    const jobs: unknown[] = [];
    const payload = JSON.stringify({
      team: { id: "T1" },
      user: { id: "U1" },
      container: { channel_id: "D1", message_ts: "2.0" },
      actions: [{ action_id: "food_confirm" }],
    });
    const response = await handleSlackRequest(
      await signedRequest(
        "/slack/actions",
        `payload=${encodeURIComponent(payload)}`,
        "application/x-www-form-urlencoded",
      ),
      {
        signingSecret,
        recordDelivery: async () => true,
        enqueue: async (job) => {
          jobs.push(job);
        },
      },
    );

    expect(response.status).toBe(200);
    expect(jobs).toEqual([expect.objectContaining({ kind: "action", action: "confirm" })]);
  });

  it("returns an ephemeral Dofek URL for a signed link command", async () => {
    const response = await handleSlackRequest(
      await signedRequest(
        "/slack/commands",
        "command=%2Flink-dofek&team_id=T1&user_id=U1",
        "application/x-www-form-urlencoded",
      ),
      {
        signingSecret,
        recordDelivery: async () => true,
        enqueue: async () => undefined,
        startLink: async ({ namespace, subject }) => {
          expect({ namespace, subject }).toEqual({ namespace: "slack", subject: "T1:U1" });
          return { authorizationUrl: "https://dofek.example/link" };
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      response_type: "ephemeral",
      text: "Finish linking your Dofek account: https://dofek.example/link",
    });
  });
});
