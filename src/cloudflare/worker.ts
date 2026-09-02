import { DofekClient } from "../dofek/client.js";
import { completeDofekLink, startDofekLink } from "./links.js";
import { completeSlackOAuth, startSlackOAuth } from "./oauth.js";
import {
  type CloudflareRuntimeEnv,
  notifySlackLinkCompleted,
  processCloudflareFoodJob,
} from "./runtime.js";
import { handleSlackRequest, type SlackQueueJob } from "./slack.js";
import { CloudflareStore } from "./store.js";

export type CloudflareEnv = CloudflareRuntimeEnv & {
  SLACK_SIGNING_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  PUBLIC_BASE_URL: string;
  FOOD_JOBS: { send(message: SlackQueueJob): Promise<void> };
};

const worker = {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") return Response.json({ status: "ok" });
    if (request.method === "GET" && (path === "/" || path === "/slack/install")) {
      const store = new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY);
      return startSlackOAuth({
        clientId: env.SLACK_CLIENT_ID,
        redirectUri: `${env.PUBLIC_BASE_URL}/slack/oauth_redirect`,
        store,
      });
    }
    if (request.method === "GET" && path === "/slack/oauth_redirect")
      return completeOAuthCallback(request, env);
    if (request.method === "GET" && path === "/dofek/link/callback")
      return completeLinkCallback(request, env);
    if (path === "/slack/events" || path === "/slack/actions" || path === "/slack/commands") {
      const store = new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY);
      return handleSlackRequest(request, {
        signingSecret: env.SLACK_SIGNING_SECRET,
        recordDelivery: (deliveryId) => store.recordDelivery(deliveryId),
        enqueue: async (job) => {
          await env.FOOD_JOBS.send(job);
          await store.recordQueueOutcome(job.deliveryId, "enqueued");
        },
        startLink: (identity) =>
          startDofekLink({
            identity,
            redirectUri: `${env.PUBLIC_BASE_URL}/dofek/link/callback`,
            store,
            target: createDofekTarget(env),
          }),
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
  async queue(
    batch: { messages: Array<{ body: SlackQueueJob; retry(): void }> },
    env: CloudflareEnv,
  ) {
    for (const message of batch.messages) {
      try {
        const store = new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY);
        await store.recordQueueOutcome(message.body.deliveryId, "processing");
        const outcome = await processCloudflareFoodJob(message.body, env);
        await store.recordQueueOutcome(message.body.deliveryId, outcome);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Unknown error";
        console.error("Slack food job failed", {
          deliveryId: message.body.deliveryId,
          error: messageText,
        });
        await new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY).recordQueueFailure(
          message.body.deliveryId,
          messageText,
        );
        message.retry();
      }
    }
  },
};

async function completeLinkCallback(request: Request, env: CloudflareEnv): Promise<Response> {
  const state = new URL(request.url).searchParams.get("state");
  const linkId = new URL(request.url).searchParams.get("link_id");
  const code = new URL(request.url).searchParams.get("code");
  if (!state || !linkId || !code)
    return new Response("Invalid Dofek link callback.", { status: 400 });
  try {
    const store = new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY);
    const identity = await completeDofekLink({
      state,
      linkId,
      code,
      store,
      target: createDofekTarget(env),
    });
    const [teamId, userId] = identity.subject.split(":");
    if (identity.namespace === "slack" && teamId && userId) {
      try {
        await notifySlackLinkCompleted({ teamId, userId, store });
      } catch (error) {
        console.error("Unable to send Slack link completion", {
          teamId,
          userId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    return new Response("Your Dofek account is linked. You can return to Slack.");
  } catch {
    return new Response("This Dofek link is invalid or expired.", { status: 400 });
  }
}

async function completeOAuthCallback(request: Request, env: CloudflareEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return new Response("Invalid Slack OAuth callback.", { status: 400 });
  try {
    const store = new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY);
    await completeSlackOAuth({
      code,
      state,
      clientId: env.SLACK_CLIENT_ID,
      clientSecret: env.SLACK_CLIENT_SECRET,
      redirectUri: `${env.PUBLIC_BASE_URL}/slack/oauth_redirect`,
      store,
    });
    return new Response("Slack app installed. You can return to Slack.");
  } catch {
    return new Response("This Slack OAuth link is invalid or expired.", { status: 400 });
  }
}

function createDofekTarget(env: CloudflareEnv): DofekClient {
  return new DofekClient({
    baseUrl: env.TARGET_API_BASE_URL,
    clientId: env.TARGET_API_CLIENT_ID,
    clientSecret: env.TARGET_API_CLIENT_SECRET,
  });
}

export default worker;
