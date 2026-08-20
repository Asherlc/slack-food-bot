import type {
  ConfirmedNutritionWrite,
  NutritionItem,
  NutritionWriteEntry,
  TargetGrant,
} from "../targets/types.js";
import type { SlackQueueJob } from "./slack.js";
import type { PendingRecord } from "./store.js";

export type CloudflarePendingEntry = PendingRecord & {
  externalSubject: string;
  date: string;
  item: NutritionItem;
  slackUserId: string;
  threadTs: string;
  sourceMessageTs: string;
};

type ConsumerDependencies = Partial<{
  analyze(text: string, localTime: string): Promise<NutritionItem[]>;
  publishDraft(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    items: ReadonlyArray<NutritionItem>;
  }): Promise<{ confirmationMessageTs: string }>;
  savePending(entries: ReadonlyArray<CloudflarePendingEntry>): Promise<void>;
  findPending(channelId: string, confirmationMessageTs: string): Promise<CloudflarePendingEntry[]>;
  deletePending(ids: ReadonlyArray<string>): Promise<void>;
  loadGrant(subject: string): Promise<TargetGrant | null>;
  saveGrant(subject: string, grant: TargetGrant): Promise<void>;
  reissueGrant(input: { identity: { namespace: string; subject: string } }): Promise<TargetGrant>;
  confirmFood(input: {
    grant: TargetGrant;
    idempotencyKey: string;
    entries: ReadonlyArray<NutritionWriteEntry>;
  }): Promise<ConfirmedNutritionWrite>;
  publishConfirmed(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
    result: ConfirmedNutritionWrite;
  }): Promise<void>;
}>;

export async function processFoodQueueJob(
  job: SlackQueueJob,
  dependencies: ConsumerDependencies,
): Promise<void> {
  if (job.kind === "action") return processAction(job, dependencies);
  return processEvent(job, dependencies);
}

async function processEvent(
  job: Extract<SlackQueueJob, { kind: "event" }>,
  dependencies: ConsumerDependencies,
): Promise<void> {
  if (!dependencies.analyze || !dependencies.publishDraft || !dependencies.savePending)
    throw new Error("Cloudflare analysis workflow is not configured");
  const event = objectField(job.payload, "event");
  if (!event || stringField(event, "subtype") || stringField(event, "bot_id")) return;
  const type = stringField(event, "type");
  const channelType = stringField(event, "channel_type");
  if (
    type !== "app_mention" &&
    (type !== "message" || (channelType !== "im" && channelType !== "app_home"))
  ) {
    return;
  }
  const teamId = stringField(job.payload, "team_id");
  const userId = stringField(event, "user");
  const channelId = stringField(event, "channel");
  const sourceMessageTs = stringField(event, "ts");
  const rawText = stringField(event, "text");
  if (!teamId || !userId || !channelId || !sourceMessageTs || !rawText) return;
  const text = type === "app_mention" ? rawText.replace(/<@[^>]+>/g, "").trim() : rawText.trim();
  if (!text) return;

  const time = new Date(Number.parseFloat(sourceMessageTs) * 1_000);
  if (Number.isNaN(time.valueOf())) return;
  const items = await dependencies.analyze(text, time.toTimeString().slice(0, 5));
  const threadTs = stringField(event, "thread_ts") ?? sourceMessageTs;
  const draft = await dependencies.publishDraft({ teamId, channelId, threadTs, items });
  await dependencies.savePending(
    items.map((item, index) => ({
      id: `entry:${job.deliveryId}:${index}`,
      externalSubject: `slack:${teamId}:${userId}`,
      date: time.toISOString().slice(0, 10),
      item,
      channelId,
      confirmationMessageTs: draft.confirmationMessageTs,
      slackUserId: userId,
      threadTs,
      sourceMessageTs,
    })),
  );
}

async function processAction(
  job: Extract<SlackQueueJob, { kind: "action" }>,
  dependencies: ConsumerDependencies,
): Promise<void> {
  if (job.action !== "confirm") return;
  if (
    !dependencies.findPending ||
    !dependencies.loadGrant ||
    !dependencies.saveGrant ||
    !dependencies.reissueGrant ||
    !dependencies.confirmFood ||
    !dependencies.publishConfirmed ||
    !dependencies.deletePending
  ) {
    throw new Error("Cloudflare confirmation workflow is not configured");
  }
  const teamId = nestedString(job.payload, "team", "id");
  const userId = nestedString(job.payload, "user", "id");
  const channelId = nestedString(job.payload, "container", "channel_id");
  const messageTs = nestedString(job.payload, "container", "message_ts");
  if (!teamId || !userId || !channelId || !messageTs) return;
  const entries = await dependencies.findPending(channelId, messageTs);
  if (entries.length === 0) return;
  const externalSubject = `slack:${teamId}:${userId}`;
  if (
    entries.some(
      (entry) => entry.externalSubject !== externalSubject || entry.slackUserId !== userId,
    )
  ) {
    return;
  }
  const subject = `${teamId}:${userId}`;
  const identity = { namespace: "slack", subject };
  const grant =
    (await dependencies.loadGrant(subject)) ?? (await dependencies.reissueGrant({ identity }));
  await dependencies.saveGrant(subject, grant);
  const result = await dependencies.confirmFood({
    grant,
    idempotencyKey: await confirmationIdempotencyKey(entries.map((entry) => entry.id)),
    entries: entries.map((entry) => ({ ...entry.item, date: entry.date, externalId: entry.id })),
  });
  await dependencies.publishConfirmed({
    teamId,
    channelId,
    confirmationMessageTs: messageTs,
    result,
  });
  await dependencies.deletePending(entries.map((entry) => entry.id));
}

function objectField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function nestedString(
  value: Record<string, unknown>,
  key: string,
  childKey: string,
): string | undefined {
  const nested = objectField(value, key);
  return nested ? stringField(nested, childKey) : undefined;
}

async function confirmationIdempotencyKey(entryIds: ReadonlyArray<string>): Promise<string> {
  const data = new TextEncoder().encode([...entryIds].sort().join(":"));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return `slack-food-confirmation:${[...hash]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
