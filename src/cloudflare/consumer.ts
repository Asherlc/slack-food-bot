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
  analysisTimeoutMs: number;
  resolveUserTimeZone(input: { teamId: string; userId: string }): Promise<string | undefined>;
  analyze(text: string, localTime: string): Promise<NutritionItem[]>;
  analyzeImage(input: {
    teamId: string;
    fileId?: string;
    url?: string;
    mediaType?: string;
    text: string;
    localTime: string;
  }): Promise<NutritionItem[]>;
  saveClarification(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    description: string;
  }): Promise<void>;
  consumeClarification(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    userId: string;
  }): Promise<{ description: string } | null>;
  publishDraft(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    items: ReadonlyArray<NutritionItem>;
  }): Promise<{ confirmationMessageTs: string }>;
  publishClarification(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    description: string;
  }): Promise<void>;
  publishLinkRequired(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
  }): Promise<void>;
  publishAnalysisFailure(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    reason: "timeout" | "no-food" | "error";
  }): Promise<void>;
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
  publishProcessing(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
  }): Promise<void>;
  publishConfirmationFailure(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
    dofekStatus?: number;
    responseUrl?: string;
  }): Promise<void>;
}>;

export async function processFoodQueueJob(
  job: SlackQueueJob,
  dependencies: ConsumerDependencies,
): Promise<string> {
  if (job.kind === "action") {
    await processAction(job, dependencies);
    return "action";
  }
  return processEvent(job, dependencies);
}

async function processEvent(
  job: Extract<SlackQueueJob, { kind: "event" }>,
  dependencies: ConsumerDependencies,
): Promise<string> {
  if (
    !dependencies.publishDraft ||
    !dependencies.savePending ||
    !dependencies.loadGrant ||
    !dependencies.publishLinkRequired
  )
    throw new Error("Cloudflare analysis workflow is not configured");
  const eventEnvelope = objectField(job.payload, "event");
  if (!eventEnvelope) return "ignored:missing-or-bot";
  const subtype = stringField(eventEnvelope, "subtype");
  const changedMessage =
    subtype === "message_changed" ? objectField(eventEnvelope, "message") : undefined;
  const event = changedMessage ?? eventEnvelope;
  if (stringField(event, "bot_id")) return "ignored:missing-or-bot";
  if (subtype === "message_changed" && !imageFile(event)) return "ignored:subtype:message_changed";
  if (subtype && subtype !== "file_share" && subtype !== "message_changed")
    return `ignored:subtype:${subtype}`;
  const type = stringField(event, "type");
  const channelType =
    stringField(event, "channel_type") ?? stringField(eventEnvelope, "channel_type");
  if (
    type !== "app_mention" &&
    (type !== "message" || (channelType !== "im" && channelType !== "app_home"))
  ) {
    return `ignored:channel:${channelType ?? "unknown"}`;
  }
  const teamId = stringField(job.payload, "team_id");
  const userId = stringField(event, "user");
  const channelId = stringField(event, "channel") ?? stringField(eventEnvelope, "channel");
  const sourceMessageTs = stringField(event, "ts");
  const rawText = stringField(event, "text") ?? "";
  if (!teamId || !userId || !channelId || !sourceMessageTs) return "ignored:missing-identifiers";
  const text = type === "app_mention" ? rawText.replace(/<@[^>]+>/g, "").trim() : rawText.trim();
  const photo = imageFile(event);
  if (!text && !photo) return "ignored:empty";
  if (subtype === "file_share" && !photo) return "image-pending";
  if (!photo && isImageFilename(text)) return "image-pending";
  const threadTs = stringField(event, "thread_ts") ?? sourceMessageTs;
  if (!(await dependencies.loadGrant(`${teamId}:${userId}`))) {
    await dependencies.publishLinkRequired({ teamId, channelId, threadTs });
    return "link-required";
  }
  const clarification = await dependencies.consumeClarification?.({
    teamId,
    channelId,
    threadTs,
    userId,
  });
  if (!photo && !clarification && needsIngredientClarification(text)) {
    if (!dependencies.saveClarification || !dependencies.publishClarification)
      throw new Error("Cloudflare clarification workflow is not configured");
    await dependencies.saveClarification({
      teamId,
      channelId,
      threadTs,
      userId,
      description: text,
    });
    await dependencies.publishClarification({ teamId, channelId, threadTs, description: text });
    return "clarification-required";
  }

  const time = new Date(Number.parseFloat(sourceMessageTs) * 1_000);
  if (Number.isNaN(time.valueOf())) return "ignored:invalid-timestamp";
  const timeZone = await dependencies.resolveUserTimeZone?.({ teamId, userId });
  const localDateTime = formatLocalDateTime(time, timeZone);
  const description = clarification ? `${clarification.description}\nClarification: ${text}` : text;
  let items: NutritionItem[];
  try {
    const analysis = photo
      ? analyzeImage(dependencies, {
          teamId,
          ...photo,
          text: description,
          localTime: localDateTime.time,
        })
      : analyzeText(dependencies, description, localDateTime.time);
    items = await withTimeout(analysis, dependencies.analysisTimeoutMs ?? 25_000);
  } catch (error) {
    if (!dependencies.publishAnalysisFailure) throw error;
    console.error("Slack analysis failed", {
      deliveryId: job.deliveryId,
      kind: photo ? "image" : "text",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    await dependencies.publishAnalysisFailure({
      teamId,
      channelId,
      threadTs,
      reason: analysisFailureReason(error),
    });
    return "analysis-failed";
  }
  const draft = await dependencies.publishDraft({ teamId, channelId, threadTs, items });
  await dependencies.savePending(
    items.map((item, index) => ({
      id: `entry:${job.deliveryId}:${index}`,
      externalSubject: `slack:${teamId}:${userId}`,
      date: localDateTime.date,
      item,
      channelId,
      confirmationMessageTs: draft.confirmationMessageTs,
      slackUserId: userId,
      threadTs,
      sourceMessageTs,
    })),
  );
  return "draft-published";
}

function formatLocalDateTime(time: Date, timeZone = "UTC"): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(time);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (!year || !month || !day || !hour || !minute)
    throw new Error("Unable to format Slack message date and time");
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

function analysisFailureReason(error: unknown): "timeout" | "no-food" | "error" {
  if (error instanceof Error && error.name === "NoFoodDetectedError") return "no-food";
  if (error instanceof Error && /timed out/i.test(error.message)) return "timeout";
  return "error";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Nutrition analysis timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function analyzeText(
  dependencies: ConsumerDependencies,
  text: string,
  localTime: string,
): Promise<NutritionItem[]> {
  if (!dependencies.analyze) throw new Error("Cloudflare text analysis is not configured");
  return dependencies.analyze(text, localTime);
}

async function analyzeImage(
  dependencies: ConsumerDependencies,
  input: {
    teamId: string;
    fileId?: string;
    url?: string;
    mediaType?: string;
    text: string;
    localTime: string;
  },
): Promise<NutritionItem[]> {
  if (!dependencies.analyzeImage) throw new Error("Cloudflare image analysis is not configured");
  return dependencies.analyzeImage(input);
}

function imageFile(
  event: Record<string, unknown>,
): { fileId?: string; url?: string; mediaType?: string } | undefined {
  const files = event.files;
  if (!Array.isArray(files)) return undefined;
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) continue;
    const candidate = file as Record<string, unknown>;
    const fileId = stringField(candidate, "id");
    const mediaType = stringField(candidate, "mimetype");
    const url =
      stringField(candidate, "thumb_1024") ??
      stringField(candidate, "thumb_960") ??
      stringField(candidate, "thumb_800") ??
      stringField(candidate, "thumb_720") ??
      stringField(candidate, "thumb_480") ??
      stringField(candidate, "url_private_download") ??
      stringField(candidate, "url_private");
    if (mediaType?.startsWith("image/") && url)
      return { ...(fileId ? { fileId } : {}), mediaType, url };
    if (
      fileId &&
      (mediaType?.startsWith("image/") ||
        stringField(candidate, "file_access") === "check_file_info")
    )
      return { fileId, ...(mediaType ? { mediaType } : {}) };
  }
  return undefined;
}

function needsIngredientClarification(text: string): boolean {
  const words = text.replace(/^\s*\d+(?:\.\d+)?\s*(?:x\s*)?/i, "").match(/[a-z]+/gi);
  return words?.length === 2 && !/\b(?:with|without|no|and|or|plus|on)\b/i.test(text);
}

function isImageFilename(text: string): boolean {
  return (
    /https:\/\/files\.slack\.com\/files-pri\//i.test(text) ||
    /\.(?:avif|gif|heic|heif|jpe?g|png|webp)(?:$|[\s|>])/i.test(text.trim())
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
    !dependencies.publishProcessing ||
    !dependencies.publishConfirmed ||
    !dependencies.publishConfirmationFailure ||
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
  const responseUrl = stringField(job.payload, "response_url");
  try {
    await dependencies.publishProcessing({
      teamId,
      channelId,
      confirmationMessageTs: messageTs,
    });
    let grant =
      (await dependencies.loadGrant(subject)) ?? (await dependencies.reissueGrant({ identity }));
    await dependencies.saveGrant(subject, grant);
    const confirmation = {
      idempotencyKey: await confirmationIdempotencyKey(entries.map((entry) => entry.id)),
      entries: entries.map((entry) => ({ ...entry.item, date: entry.date, externalId: entry.id })),
    };
    let result: ConfirmedNutritionWrite;
    try {
      result = await dependencies.confirmFood({ grant, ...confirmation });
    } catch (error) {
      if (dofekStatus(error) !== 401) throw error;
      grant = await dependencies.reissueGrant({ identity });
      await dependencies.saveGrant(subject, grant);
      result = await dependencies.confirmFood({ grant, ...confirmation });
    }
    await dependencies.publishConfirmed({
      teamId,
      channelId,
      confirmationMessageTs: messageTs,
      result,
    });
    await dependencies.deletePending(entries.map((entry) => entry.id));
  } catch (error) {
    const status = dofekStatus(error);
    console.error("Slack food confirmation failed", {
      deliveryId: job.deliveryId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    await dependencies.publishConfirmationFailure({
      teamId,
      channelId,
      confirmationMessageTs: messageTs,
      ...(status === undefined ? {} : { dofekStatus: status }),
      ...(responseUrl === undefined ? {} : { responseUrl }),
    });
  }
}

function dofekStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /^Dofek nutrition write failed with status (\d{3})$/.exec(error.message);
  return match ? Number(match[1]) : undefined;
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
