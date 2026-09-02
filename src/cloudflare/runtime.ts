import {
  createProductionNutritionAnalyzer,
  type WorkersAiBinding,
} from "../ai/nutrition-analyzer.js";
import { DofekClient } from "../dofek/client.js";
import {
  type BlockKitBlock,
  formatConfirmation,
  formatConfirmationFailure,
  formatDraft,
  formatProcessing,
} from "../slack/formatting.js";
import type { ConfirmedNutritionWrite, NutritionItem } from "../targets/types.js";
import { processFoodQueueJob } from "./consumer.js";
import type { SlackQueueJob } from "./slack.js";
import { CloudflareStore, type D1DatabaseLike } from "./store.js";

const maxSlackImageBytes = 5 * 1024 * 1024;

export type CloudflareRuntimeEnv = {
  BOT_STATE_ENCRYPTION_KEY: string;
  FOOD_BOT_DB: D1DatabaseLike;
  AI: WorkersAiBinding;
  TARGET_API_BASE_URL: string;
  TARGET_API_CLIENT_ID: string;
  TARGET_API_CLIENT_SECRET: string;
};

export async function processCloudflareFoodJob(
  job: SlackQueueJob,
  env: CloudflareRuntimeEnv,
): Promise<string> {
  const store = new CloudflareStore(env.FOOD_BOT_DB, env.BOT_STATE_ENCRYPTION_KEY);
  const analyzer = createCloudflareNutritionAnalyzer({
    AI: traceWorkersAiBinding(env.AI, (sequence, outcome) =>
      store.recordQueueOutcome(`${job.deliveryId}:ai:${sequence}`, outcome),
    ),
  });
  const target = new DofekClient({
    baseUrl: env.TARGET_API_BASE_URL,
    clientId: env.TARGET_API_CLIENT_ID,
    clientSecret: env.TARGET_API_CLIENT_SECRET,
  });
  const messenger = new CloudflareSlackMessenger(store);
  return processFoodQueueJob(job, {
    analyze: (text, localTime) => analyzer.analyze(text, localTime),
    analyzeImage: async (input) => {
      const installation = await store.loadInstallation<SlackInstallation>(input.teamId);
      if (!installation?.botToken) throw new Error("Slack app is not installed for this workspace");
      return analyzeSlackImage({
        ...input,
        botToken: installation.botToken,
        analyze: (image, mediaType, text, localTime) =>
          analyzer.analyzeImage(image, mediaType, text, localTime),
      });
    },
    saveClarification: (input) => store.saveClarification(input),
    consumeClarification: (input) => store.consumeClarification(input),
    publishDraft: (input) => messenger.publishDraft(input),
    publishClarification: (input) => messenger.publishClarification(input),
    publishLinkRequired: (input) => messenger.publishLinkRequired(input),
    publishAnalysisFailure: (input) => messenger.publishAnalysisFailure(input),
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

export async function analyzeSlackImage(input: {
  fileId?: string;
  url?: string;
  mediaType?: string;
  text: string;
  localTime: string;
  botToken: string;
  analyze(
    image: Uint8Array,
    mediaType: string,
    text: string,
    localTime: string,
  ): Promise<NutritionItem[]>;
}): Promise<NutritionItem[]> {
  const imageReference = await resolveSlackImageReference(input);
  const url = trustedSlackImageUrl(imageReference.url);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${input.botToken}` },
  });
  if (!response.ok) throw new Error(`Slack image download failed with status ${response.status}`);
  const responseMediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (!responseMediaType?.startsWith("image/"))
    throw new Error("Slack image download did not return an image");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxSlackImageBytes)
    throw new Error("Slack image download exceeds 5 MiB");
  const image = await readImageBytes(response);
  if (image.byteLength === 0) throw new Error("Slack image download was empty");
  return input.analyze(image, responseMediaType, input.text, input.localTime);
}

async function resolveSlackImageReference(input: {
  fileId?: string;
  url?: string;
  mediaType?: string;
  botToken: string;
}): Promise<{ url: string; mediaType: string }> {
  if (input.url && input.mediaType) return { url: input.url, mediaType: input.mediaType };
  if (!input.fileId) throw new Error("Slack image metadata is unavailable");
  const response = await fetch(
    `https://slack.com/api/files.info?file=${encodeURIComponent(input.fileId)}`,
    { headers: { Authorization: `Bearer ${input.botToken}` } },
  );
  if (!response.ok) throw new Error(`Slack file lookup failed with status ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Slack file lookup returned an invalid response");
  const file = (body as Record<string, unknown>).file;
  if (!file || typeof file !== "object" || Array.isArray(file))
    throw new Error("Slack file lookup omitted file metadata");
  const metadata = file as Record<string, unknown>;
  const mediaType = typeof metadata.mimetype === "string" ? metadata.mimetype : undefined;
  const url =
    typeof metadata.url_private_download === "string"
      ? metadata.url_private_download
      : typeof metadata.url_private === "string"
        ? metadata.url_private
        : undefined;
  if (!mediaType?.startsWith("image/") || !url)
    throw new Error("Slack file lookup did not return an image");
  return { url, mediaType };
}

function trustedSlackImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Slack image URL");
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "files.slack.com" && url.hostname !== "slack.com")
  )
    throw new Error("Invalid Slack image URL");
  return url;
}

async function readImageBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxSlackImageBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Slack image download exceeds 5 MiB");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const image = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    image.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return image;
}

export function createCloudflareNutritionAnalyzer(env: Pick<CloudflareRuntimeEnv, "AI">) {
  return createProductionNutritionAnalyzer({ workersAi: env.AI });
}

export function traceWorkersAiBinding(
  binding: WorkersAiBinding,
  record: (sequence: number, outcome: string) => Promise<unknown>,
): WorkersAiBinding {
  let sequence = 0;
  return {
    async run(model, input) {
      await recordAiTrace(
        record,
        ++sequence,
        `ai-request:model=${model};hasImage=${containsImage(input)}`,
      );
      try {
        const result = await binding.run(model, input);
        await recordAiTrace(
          record,
          ++sequence,
          `ai-response:model=${model};response=${summarizeAiResponse(result)}`,
        );
        return result;
      } catch (error) {
        await recordAiTrace(
          record,
          ++sequence,
          `ai-error:model=${model};error=${summarizeText(
            error instanceof Error ? error.message : "Unknown error",
          )}`,
        );
        throw error;
      }
    },
  };
}

async function recordAiTrace(
  record: (sequence: number, outcome: string) => Promise<unknown>,
  sequence: number,
  outcome: string,
): Promise<void> {
  try {
    await record(sequence, outcome);
  } catch (error) {
    console.error("Unable to persist Workers AI trace", {
      sequence,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "image_url" && record.image_url) return true;
  return Object.values(record).some(containsImage);
}

function summarizeAiResponse(result: Awaited<ReturnType<WorkersAiBinding["run"]>>): string {
  const response = result.response ?? result.answer ?? result.choices?.[0]?.message?.content;
  return summarizeText(typeof response === "string" ? response : JSON.stringify(response));
}

function summarizeText(value: string | undefined): string {
  return (value ?? "undefined").replace(/[\r\n\t]+/g, " ").slice(0, 800);
}

export async function publishInteractiveMessageUpdate(
  responseUrl: string,
  input: { text: string; blocks: BlockKitBlock[] },
): Promise<void> {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ replace_original: true, ...input }),
  });
  if (!response.ok)
    throw new Error(`Slack interactive response failed with status ${response.status}`);
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

export async function notifySlackAnalysisFailure(input: {
  teamId: string;
  channelId: string;
  threadTs: string;
  reason: "timeout" | "no-food" | "error";
  store: SlackInstallationStore;
}): Promise<void> {
  await new CloudflareSlackMessenger(input.store).publishAnalysisFailure(input);
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

  async publishAnalysisFailure(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    reason: "timeout" | "no-food" | "error";
  }): Promise<void> {
    await this.#call(input.teamId, "chat.postMessage", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      text:
        input.reason === "no-food"
          ? "I couldn't confidently identify food or a drink in that photo, so I didn't create a draft."
          : input.reason === "timeout"
            ? "I couldn't analyze that message in time. Please try again. If it included a photo, make sure Slack Food Bot was reinstalled with file access."
            : "I couldn't analyze that message. Please try again.",
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
    dofekStatus?: number;
    responseUrl?: string;
  }): Promise<void> {
    const blocks = formatConfirmationFailure(
      input.dofekStatus === undefined ? {} : { dofekStatus: input.dofekStatus },
    );
    if (input.responseUrl) {
      try {
        await publishInteractiveMessageUpdate(input.responseUrl, {
          text: "Food log could not be saved. Try again.",
          blocks,
        });
        return;
      } catch (error) {
        console.error("Unable to update Slack interaction response", {
          teamId: input.teamId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    await this.#call(input.teamId, "chat.update", {
      channel: input.channelId,
      ts: input.confirmationMessageTs,
      text: "Food log could not be saved. Try again.",
      blocks,
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
    const result = (await response.json()) as { ok?: unknown; error?: unknown } & T;
    if (result.ok !== true) {
      const code = typeof result.error === "string" ? `: ${result.error}` : "";
      throw new Error(`Slack ${method} rejected the request${code}`);
    }
    return result;
  }
}
