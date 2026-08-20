import type { FoodJobQueue } from "../jobs/queue.js";
import type { PendingEntryStore } from "./pending-entry-store.js";

export type SlackEventArgs = {
  event: Record<string, unknown>;
  body: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type SlackActionArgs = {
  ack: () => Promise<unknown>;
  body: Record<string, unknown>;
};

export type SlackRegistrar = {
  event(name: string, handler: (args: SlackEventArgs) => Promise<void>): void;
  action(name: string, handler: (args: SlackActionArgs) => Promise<void>): void;
};

export function registerSlackHandlers(
  app: SlackRegistrar,
  dependencies: {
    queue: FoodJobQueue;
    pending: Pick<PendingEntryStore, "findIdsByMessage">;
    now: () => { date: string; time: string };
  },
): void {
  app.event("app_mention", async (args) => enqueueFoodMessage(args, dependencies, true));
  app.event("message", async (args) => enqueueFoodMessage(args, dependencies, false));
  app.action("food_confirm", async (args) => enqueueAction(args, dependencies, "confirm"));
  app.action("food_cancel", async (args) => enqueueAction(args, dependencies, "cancel"));
}

async function enqueueFoodMessage(
  args: SlackEventArgs,
  dependencies: {
    queue: FoodJobQueue;
    now: () => { date: string; time: string };
  },
  isMention: boolean,
): Promise<void> {
  const event = args.event;
  if (event.subtype || event.bot_id) return;
  const text = stringField(event, "text");
  const userId = stringField(event, "user");
  const channelId = stringField(event, "channel");
  const timestamp = stringField(event, "ts");
  const teamId = stringField(args.body, "team_id") ?? stringField(args.context, "teamId");
  if (!text || !userId || !channelId || !timestamp || !teamId) return;
  const channelType = stringField(event, "channel_type");
  const botUserId = stringField(args.context, "botUserId");
  const directlyMentioned = botUserId ? text.includes(`<@${botUserId}>`) : isMention;
  if (!isMention && channelType !== "im" && !directlyMentioned) return;
  const cleanedText = (
    botUserId
      ? text.replaceAll(`<@${botUserId}>`, "")
      : isMention
        ? text.replace(/<@[^>]+>/g, "")
        : text
  ).trim();
  if (!cleanedText) return;
  const eventId = stringField(args.body, "event_id") ?? timestamp;
  const now = dependencies.now();
  await dependencies.queue.enqueue({
    kind: "analyze",
    id: `analyze:${teamId}:${eventId}`,
    teamId,
    userId,
    channelId,
    threadTs: stringField(event, "thread_ts") ?? timestamp,
    sourceMessageTs: timestamp,
    text: cleanedText,
    localDate: now.date,
    localTime: now.time,
  });
}

async function enqueueAction(
  args: SlackActionArgs,
  dependencies: { queue: FoodJobQueue; pending: Pick<PendingEntryStore, "findIdsByMessage"> },
  kind: "confirm" | "cancel",
): Promise<void> {
  await args.ack();
  const teamId = nestedString(args.body, "team", "id") ?? stringField(args.body, "team_id");
  const userId = nestedString(args.body, "user", "id");
  const channelId = nestedString(args.body, "container", "channel_id");
  const messageTs = nestedString(args.body, "container", "message_ts");
  if (!teamId || !userId || !channelId || !messageTs) return;
  const entryIds = await dependencies.pending.findIdsByMessage(channelId, messageTs);
  if (entryIds.length === 0) return;
  await dependencies.queue.enqueue({
    kind,
    id: `${kind}:${teamId}:${userId}:${messageTs}`,
    teamId,
    userId,
    channelId,
    entryIds,
  });
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function nestedString(
  value: Record<string, unknown>,
  key: string,
  nestedKey: string,
): string | undefined {
  const nested = value[key];
  return typeof nested === "object" && nested !== null
    ? stringField(nested as Record<string, unknown>, nestedKey)
    : undefined;
}
