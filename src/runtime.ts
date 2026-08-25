import { App, ExpressReceiver } from "@slack/bolt";
import { createProductionNutritionAnalyzer } from "./ai/nutrition-analyzer.js";
import type { AppConfig } from "./config.js";
import { DofekClient } from "./dofek/client.js";
import { completeSlackDofekLink, startSlackDofekLink } from "./dofek/link-flow.js";
import { DofekLinkStore } from "./dofek/link-store.js";
import { BullFoodJobQueue } from "./jobs/queue.js";
import { createFoodWorker } from "./jobs/worker.js";
import { createRedisConnection, RedisAdapter } from "./redis/client.js";
import { EncryptedJsonStore } from "./redis/encrypted-json-store.js";
import { registerSlackHandlers, type SlackRegistrar } from "./slack/app.js";
import { RedisInstallationStore } from "./slack/installation-store.js";
import { InstalledSlackMessenger } from "./slack/installed-messenger.js";
import { RedisPendingEntryStore } from "./slack/pending-entry-store.js";
import { FoodWorkflow } from "./workflows/food-workflow.js";

export function createApplicationRuntime(config: AppConfig) {
  const redis = createRedisConnection(config.redisUrl);
  const redisAdapter = new RedisAdapter(redis);
  const encryptedStore = new EncryptedJsonStore(
    redisAdapter,
    Buffer.from(config.security.stateEncryptionKey, "base64url"),
  );
  const installations = new RedisInstallationStore(encryptedStore);
  const pending = new RedisPendingEntryStore(() => Promise.resolve(redisAdapter));
  const grants = new DofekLinkStore(encryptedStore);
  const target = new DofekClient({
    baseUrl: config.target.apiBaseUrl,
    clientId: config.target.clientId,
    clientSecret: config.target.clientSecret,
  });
  const analyzer = createProductionNutritionAnalyzer(config.ai);
  const messenger = new InstalledSlackMessenger((teamId) => installations.fetchBotToken(teamId));
  const workflow = new FoodWorkflow({ analyzer, pending, grants, target, messenger });
  const queue = new BullFoodJobQueue(redis);
  return { redis, installations, pending, grants, workflowTarget: target, workflow, queue };
}

export function createWebRuntime(config: AppConfig) {
  const runtime = createApplicationRuntime(config);
  const receiver = new ExpressReceiver({
    signingSecret: config.slack.signingSecret,
    clientId: config.slack.clientId,
    clientSecret: config.slack.clientSecret,
    stateSecret: config.slack.stateSecret,
    redirectUri: `${config.publicBaseUrl}/slack/oauth_redirect`,
    installationStore: runtime.installations as never,
    scopes: ["app_mentions:read", "chat:write", "commands", "im:history"],
  });
  receiver.app.get("/health", (_request, response) => response.status(200).json({ status: "ok" }));
  receiver.app.get("/dofek/link/callback", async (request, response) => {
    try {
      const state = queryValue(request.query.state);
      const linkId = queryValue(request.query.link_id);
      const code = queryValue(request.query.code);
      if (!state || !linkId || !code)
        return response.status(400).send("Invalid Dofek link callback.");
      await completeSlackDofekLink({
        target: runtime.workflowTarget,
        store: runtime.grants,
        state,
        linkId,
        code,
      });
      return response.status(200).send("Your Dofek account is linked. You can return to Slack.");
    } catch {
      return response.status(400).send("This Dofek link is invalid or expired.");
    }
  });
  const app = new App({ receiver });
  registerSlackHandlers(app as unknown as SlackRegistrar, {
    queue: runtime.queue,
    pending: runtime.pending,
    now: localDateTime,
    startLink: (identity) =>
      startSlackDofekLink({
        target: runtime.workflowTarget,
        store: runtime.grants,
        identity,
        redirectUri: `${config.publicBaseUrl}/dofek/link/callback`,
      }),
  });
  return {
    start: () => receiver.start(config.port),
    stop: () => receiver.stop(),
  };
}

export function createWorkerRuntime(config: AppConfig) {
  const runtime = createApplicationRuntime(config);
  const worker = createFoodWorker(runtime.redis, runtime.workflow);
  return {
    worker,
    stop: async () => {
      await worker.close();
      await runtime.queue.close();
      await runtime.redis.quit();
    },
  };
}

function localDateTime(now = new Date()): { date: string; time: string } {
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5);
  return { date, time };
}

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
