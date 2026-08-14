const DEDUPE_KEY_PREFIX = "slack-food-bot:dedupe:";
const SUBJECT_INDEX_KEY_PREFIX = "slack-food-bot:dedupe:subject:";

export interface SlackDedupeStore {
  claim(key: string, ttlMilliseconds: number, externalSubject: string): Promise<boolean>;
  deleteBySubject(externalSubject: string): Promise<void>;
}

export interface DedupeRedisClient {
  set(key: string, value: string, options: { PX: number; NX?: boolean }): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export class InMemorySlackDedupeStore implements SlackDedupeStore {
  readonly #expirationByKey = new Map<string, number>();
  readonly #subjectKeys = new Map<string, Set<string>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async claim(key: string, ttlMilliseconds: number, externalSubject: string): Promise<boolean> {
    const fullKey = `${DEDUPE_KEY_PREFIX}${key}`;
    const now = this.#now();
    const existingExpiry = this.#expirationByKey.get(fullKey);
    if (typeof existingExpiry === "number" && existingExpiry > now) return false;
    this.#expirationByKey.set(fullKey, now + ttlMilliseconds);
    const subjectKeys = this.#subjectKeys.get(externalSubject) ?? new Set<string>();
    subjectKeys.add(fullKey);
    this.#subjectKeys.set(externalSubject, subjectKeys);
    return true;
  }

  async deleteBySubject(externalSubject: string): Promise<void> {
    const keys = this.#subjectKeys.get(externalSubject);
    if (!keys) return;
    for (const key of keys) this.#expirationByKey.delete(key);
    this.#subjectKeys.delete(externalSubject);
  }
}

export class RedisSlackDedupeStore implements SlackDedupeStore {
  readonly #getRedisClient: () => Promise<DedupeRedisClient>;

  constructor(getRedisClient: () => Promise<DedupeRedisClient>) {
    this.#getRedisClient = getRedisClient;
  }

  async claim(key: string, ttlMilliseconds: number, externalSubject: string): Promise<boolean> {
    const redis = await this.#getRedisClient();
    const fullKey = `${DEDUPE_KEY_PREFIX}${key}`;
    const result = await redis.set(fullKey, "1", { PX: ttlMilliseconds, NX: true });
    if (result !== "OK") return false;
    await addSubjectKey(redis, externalSubject, fullKey, ttlMilliseconds);
    return true;
  }

  async deleteBySubject(externalSubject: string): Promise<void> {
    const redis = await this.#getRedisClient();
    const indexKey = `${SUBJECT_INDEX_KEY_PREFIX}${externalSubject}`;
    const keys = await readKeys(redis, indexKey);
    if (keys.length > 0) await redis.del(...keys);
    await redis.del(indexKey);
  }
}

async function addSubjectKey(
  redis: DedupeRedisClient,
  externalSubject: string,
  key: string,
  ttlMilliseconds: number,
): Promise<void> {
  const indexKey = `${SUBJECT_INDEX_KEY_PREFIX}${externalSubject}`;
  const keys = await readKeys(redis, indexKey);
  if (!keys.includes(key)) keys.push(key);
  await redis.set(indexKey, JSON.stringify(keys), { PX: ttlMilliseconds });
}

async function readKeys(redis: DedupeRedisClient, indexKey: string): Promise<string[]> {
  const payload = await redis.get(indexKey);
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
