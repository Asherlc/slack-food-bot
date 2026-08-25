import {
  createProductionNutritionAnalyzer,
  type WorkersAiBinding,
} from "../ai/nutrition-analyzer.js";
import { DofekClient } from "../dofek/client.js";
import {
  formatConfirmation,
  formatConfirmationFailure,
  formatDraft,
  formatProcessing,
} from "../slack/formatting.js";
import type { ConfirmedNutritionWrite, NutritionItem } from "../targets/types.js";
import { processFoodQueueJob } from "./consumer.js";
import type { SlackQueueJob } from "./slack.js";
import { CloudflareStore, type D1DatabaseLike } from "./store.js";

export type CloudflareRuntimeEnv = {
  BOT_STATE_ENCRYPTION_KEY: string;
  FOOD_BOT_DB: D1DatabaseLike;
  AI?: WorkersAiBinding;
  GEMINI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  AI_PROVIDER?: string;
  AI_API_KEY?: string;
  TARGET_API_BASE_URL: string;
  TARGET_API_CLIENT_ID: string;
  TARGET_API_CLIENT_SECRET: string;
};

export async function processCloudflareFoodJob(
  job: SlackQueueJob,
  env: CloudflareRuntimeEnv,
): Promise<void> {
  const store = new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY);
  const analyzer = createProductionNutritionAnalyzer({
    ...resolveAiCredentials(env),
    ...(env.AI ? { workersAi: env.AI } : {}),
  });
  const target = new DofekClient({
    baseUrl: env.TARGET_API_BASE_URL,
    clientId: env.TARGET_API_CLIENT_ID,
    clientSecret: env.TARGET_API_CLIENT_SECRET,
  });
  const messenger = new CloudflareSlackMessenger(store);
  await processFoodQueueJob(job, {
    analyze: (text, localTime) => analyzer.analyze(text, localTime),
    saveClarification: (input) => store.saveClarification(input),
    consumeClarification: (input) => store.consumeClarification(input),
    publishDraft: (input) => messenger.publishDraft(input),
    publishClarification: (input) => messenger.publishClarification(input),
    publishLinkRequired: (input) => messenger.publishLinkRequired(input),
    savePending: (entries) => store.savePending(entries, 86_400),
    findPending: (channelId, messageTs) => store.findPending(channelId, messageTs),
    deletePending: (ids) => store.deletePending(ids),
    loadGrant: (subject) => store.loadGrant(subject),
    saveGrant: (subject, grant) => store.saveGrant(subject, grant),
    reissueGrant: (input) => target.reissueGrant(input),
    confirmFood: (input) => target.confirmFood(input),
    publishProcessing: (input) => messenger.publishProcessing(input),
    publishConfirmed: (input) => messenger.publishConfirmed(input),
    publishConfirmationFailure: (input) => messenger.publishConfirmationFailure(input),
  });
}

export function resolveAiCredentials(
  env: Pick<
    CloudflareRuntimeEnv,
    "GEMINI_API_KEY" | "MISTRAL_API_KEY" | "AI_PROVIDER" | "AI_API_KEY"
  >,
): {
  geminiApiKey?: string;
  mistralApiKey?: string;
} {
  const provider = env.AI_PROVIDER?.toLowerCase();
  return {
    ...(env.GEMINI_API_KEY ||
    (provider === "gemini" || provider === "google" ? env.AI_API_KEY : undefined)
      ? { geminiApiKey: env.GEMINI_API_KEY ?? env.AI_API_KEY }
      : {}),
    ...(env.MISTRAL_API_KEY || provider === "mistral"
      ? { mistralApiKey: env.MISTRAL_API_KEY ?? env.AI_API_KEY }
      : {}),
  };
}

type SlackInstallation = { botToken: string };
type SlackInstallationStore = Pick<CloudflareStore, "loadInstallation">;

export async function notifySlackLinkCompleted(input: {
  teamId: string;
  userId: string;
  store: SlackInstallationStore;
}): Promise<void> {
  await new CloudflareSlackMessenger(input.store).publishLinkCompleted(input);
}

class CloudflareSlackMessenger {
  readonly #store: SlackInstallationStore;

  constructor(store: SlackInstallationStore) {
    this.#store = store;
  }

  async publishDraft(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    items: ReadonlyArray<NutritionItem>;
  }): Promise<{ confirmationMessageTs: string }> {
    const message = await this.#call<{ ts?: unknown }>(input.teamId, "chat.postMessage", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: "Draft food log ready for confirmation.",
      blocks: formatDraft(input.items),
    });
    if (typeof message.ts !== "string" || message.ts.length === 0)
      throw new Error("Slack omitted message ts");
    return { confirmationMessageTs: message.ts };
  }

  async publishClarification(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    description: string;
  }): Promise<void> {
    await this.#call(input.teamId, "chat.postMessage", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: `I don't want to assume what “${input.description}” includes. Please reply with a complete description of its components, including any bread, sauces, toppings, or sides.`,
    });
  }

  async publishLinkRequired(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
  }): Promise<void> {
    await this.#call(input.teamId, "chat.postMessage", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: "Before I can log food, link your Dofek account with `/link-dofek`.",
    });
  }

  async publishLinkCompleted(input: { teamId: string; userId: string }): Promise<void> {
    await this.#call(input.teamId, "chat.postMessage", {
      channel: input.userId,
      text: "Your Dofek account is linked. You can log food now.",
    });
  }

  async publishConfirmed(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
    result: ConfirmedNutritionWrite;
  }): Promise<void> {
    await this.#call(input.teamId, "chat.update", {
      channel: input.channelId,
      ts: input.confirmationMessageTs,
      text: "Food confirmed.",
      blocks: formatConfirmation(input.result),
    });
  }

  async publishProcessing(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
  }): Promise<void> {
    await this.#call(input.teamId, "chat.update", {
      channel: input.channelId,
      ts: input.confirmationMessageTs,
      text: "Saving food log…",
      blocks: formatProcessing(),
    });
  }

  async publishConfirmationFailure(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
  }): Promise<void> {
    await this.#call(input.teamId, "chat.update", {
      channel: input.channelId,
      ts: input.confirmationMessageTs,
      text: "Food log could not be saved. Try again.",
      blocks: formatConfirmationFailure(),
    });
  }

  async #call<T extends Record<string, unknown>>(
    teamId: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const installation = await this.#store.loadInstallation<SlackInstallation>(teamId);
    if (!installation?.botToken) throw new Error("Slack app is not installed for this workspace");
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installation.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Slack ${method} failed with status ${response.status}`);
    const result = (await response.json()) as { ok?: unknown } & T;
    if (result.ok !== true) throw new Error(`Slack ${method} rejected the request`);
    return result;
  }
}
