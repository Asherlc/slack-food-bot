import { type CloudflareRuntimeEnv, processCloudflareFoodJob } from "./runtime.js";
import { handleSlackRequest, type SlackQueueJob } from "./slack.js";
import { CloudflareStore } from "./store.js";

export type CloudflareEnv = CloudflareRuntimeEnv & {
  SLACK_SIGNING_SECRET: string;
  FOOD_JOBS: { send(message: SlackQueueJob): Promise<void> };
};

const worker = {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") return Response.json({ status: "ok" });
    if (path === "/slack/events" || path === "/slack/actions") {
      const store = new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY);
      return handleSlackRequest(request, {
        signingSecret: env.SLACK_SIGNING_SECRET,
        recordDelivery: (deliveryId) => store.recordDelivery(deliveryId),
        enqueue: (job) => env.FOOD_JOBS.send(job),
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
        await processCloudflareFoodJob(message.body, env);
      } catch {
        message.retry();
      }
    }
  },
};

export default worker;
