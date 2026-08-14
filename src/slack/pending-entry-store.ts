import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NutritionItem, nutritionItemSchema } from "../targets/types.js";

const PENDING_ENTRY_TTL_MS = 24 * 60 * 60 * 1_000;
const ENTRY_KEY_PREFIX = "slack-food-bot:pending:entry:";
const MESSAGE_INDEX_KEY_PREFIX = "slack-food-bot:pending:message:";
const SUBJECT_INDEX_KEY_PREFIX = "slack-food-bot:pending:subject:";

const pendingEntrySchema = z
  .object({
    id: z.uuid(),
    externalSubject: z.string().min(1),
    item: nutritionItemSchema,
    channelId: z.string().min(1),
    confirmationMessageTs: z.string().min(1),
    threadTs: z.string().min(1),
    sourceMessageTs: z.string().min(1),
    slackUserId: z.string().min(1),
  })
  .strict();

export type PendingEntryInput = {
  externalSubject: string;
  item: NutritionItem;
  channelId: string;
  confirmationMessageTs: string;
  threadTs: string;
  sourceMessageTs: string;
  slackUserId: string;
};

export type PendingEntry = PendingEntryInput & { id: string };

export interface PendingEntryStore {
  save(entries: ReadonlyArray<PendingEntryInput>): Promise<string[]>;
  loadByIds(ids: ReadonlyArray<string>): Promise<PendingEntry[]>;
  deleteByIds(ids: ReadonlyArray<string>): Promise<void>;
  findIdsByMessage(channelId: string, confirmationMessageTs: string): Promise<string[]>;
  deleteBySubject(externalSubject: string): Promise<void>;
}

export interface PendingRedisClient {
  set(key: string, value: string, options: { PX: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export class InMemoryPendingEntryStore implements PendingEntryStore {
  readonly #entries = new Map<string, PendingEntry>();
  readonly #messageIndex = new Map<string, Set<string>>();
  readonly #subjectIndex = new Map<string, Set<string>>();

  async save(entries: ReadonlyArray<PendingEntryInput>): Promise<string[]> {
    const ids: string[] = [];
    for (const input of entries) {
      const id = randomUUID();
      const entry = { id, ...input };
      this.#entries.set(id, entry);
      addIndex(this.#messageIndex, messageKey(input.channelId, input.confirmationMessageTs), id);
      addIndex(this.#subjectIndex, input.externalSubject, id);
      ids.push(id);
    }
    return ids;
  }

  async loadByIds(ids: ReadonlyArray<string>): Promise<PendingEntry[]> {
    return ids.flatMap((id) => {
      const entry = this.#entries.get(id);
      return entry ? [entry] : [];
    });
  }

  async deleteByIds(ids: ReadonlyArray<string>): Promise<void> {
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      this.#entries.delete(id);
      removeIndex(this.#messageIndex, messageKey(entry.channelId, entry.confirmationMessageTs), id);
      removeIndex(this.#subjectIndex, entry.externalSubject, id);
    }
  }

  async findIdsByMessage(channelId: string, confirmationMessageTs: string): Promise<string[]> {
    return [...(this.#messageIndex.get(messageKey(channelId, confirmationMessageTs)) ?? [])];
  }

  async deleteBySubject(externalSubject: string): Promise<void> {
    await this.deleteByIds([...(this.#subjectIndex.get(externalSubject) ?? [])]);
  }
}

export class RedisPendingEntryStore implements PendingEntryStore {
  readonly #getRedisClient: () => Promise<PendingRedisClient>;

  constructor(getRedisClient: () => Promise<PendingRedisClient>) {
    this.#getRedisClient = getRedisClient;
  }

  async save(entries: ReadonlyArray<PendingEntryInput>): Promise<string[]> {
    const redis = await this.#getRedisClient();
    const ids: string[] = [];
    for (const input of entries) {
      const id = randomUUID();
      const entry: PendingEntry = { id, ...input };
      await redis.set(entryKey(id), JSON.stringify(entry), { PX: PENDING_ENTRY_TTL_MS });
      await appendIndex(redis, messageIndexKey(input.channelId, input.confirmationMessageTs), id);
      await appendIndex(redis, subjectIndexKey(input.externalSubject), id);
      ids.push(id);
    }
    return ids;
  }

  async loadByIds(ids: ReadonlyArray<string>): Promise<PendingEntry[]> {
    const redis = await this.#getRedisClient();
    const entries: PendingEntry[] = [];
    for (const id of ids) {
      const payload = await redis.get(entryKey(id));
      if (!payload) continue;
      const parsed = parsePendingEntry(payload);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  async deleteByIds(ids: ReadonlyArray<string>): Promise<void> {
    const redis = await this.#getRedisClient();
    const entries = await this.loadByIds(ids);
    for (const entry of entries) {
      await removeFromIndex(
        redis,
        messageIndexKey(entry.channelId, entry.confirmationMessageTs),
        entry.id,
      );
      await removeFromIndex(redis, subjectIndexKey(entry.externalSubject), entry.id);
    }
    if (ids.length > 0) await redis.del(...ids.map(entryKey));
  }

  async findIdsByMessage(channelId: string, confirmationMessageTs: string): Promise<string[]> {
    const redis = await this.#getRedisClient();
    return readIndex(redis, messageIndexKey(channelId, confirmationMessageTs));
  }

  async deleteBySubject(externalSubject: string): Promise<void> {
    const redis = await this.#getRedisClient();
    const indexKey = subjectIndexKey(externalSubject);
    const ids = await readIndex(redis, indexKey);
    await this.deleteByIds(ids);
    await redis.del(indexKey);
  }
}

function messageKey(channelId: string, confirmationMessageTs: string): string {
  return `${channelId}:${confirmationMessageTs}`;
}

function addIndex(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key) ?? new Set<string>();
  ids.add(id);
  index.set(key, ids);
}

function removeIndex(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key);
  if (!ids) return;
  ids.delete(id);
  if (ids.size === 0) index.delete(key);
}

function entryKey(id: string): string {
  return `${ENTRY_KEY_PREFIX}${id}`;
}

function messageIndexKey(channelId: string, confirmationMessageTs: string): string {
  return `${MESSAGE_INDEX_KEY_PREFIX}${channelId}:${confirmationMessageTs}`;
}

function subjectIndexKey(externalSubject: string): string {
  return `${SUBJECT_INDEX_KEY_PREFIX}${externalSubject}`;
}

async function appendIndex(redis: PendingRedisClient, key: string, id: string): Promise<void> {
  const ids = await readIndex(redis, key);
  if (!ids.includes(id)) ids.push(id);
  await redis.set(key, JSON.stringify(ids), { PX: PENDING_ENTRY_TTL_MS });
}

async function removeFromIndex(redis: PendingRedisClient, key: string, id: string): Promise<void> {
  const ids = (await readIndex(redis, key)).filter((currentId) => currentId !== id);
  if (ids.length === 0) await redis.del(key);
  else await redis.set(key, JSON.stringify(ids), { PX: PENDING_ENTRY_TTL_MS });
}

async function readIndex(redis: PendingRedisClient, key: string): Promise<string[]> {
  const payload = await redis.get(key);
  if (!payload) return [];
  try {
    const parsed: unknown = JSON.parse(payload);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parsePendingEntry(payload: string): PendingEntry | null {
  try {
    const parsed = pendingEntrySchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
