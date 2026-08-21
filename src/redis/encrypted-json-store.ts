import { decryptRecord, encryptRecord } from "../security/encrypted-record.js";

export interface StringRedisClient {
  get(key: string): Promise<string | null>;
  getDel(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX: number }): Promise<"OK" | null>;
  del(key: string): Promise<number>;
}

export class EncryptedJsonStore {
  readonly #redis: StringRedisClient;
  readonly #key: Buffer;

  constructor(redis: StringRedisClient, key: Buffer) {
    this.#redis = redis;
    this.#key = key;
  }

  async set(key: string, value: unknown, options?: { ttlMs: number }): Promise<void> {
    await this.#redis.set(
      key,
      encryptRecord(this.#key, value),
      options ? { PX: options.ttlMs } : undefined,
    );
  }

  async get<Value>(key: string): Promise<Value | null> {
    const encrypted = await this.#redis.get(key);
    return encrypted ? decryptRecord<Value>(this.#key, encrypted) : null;
  }

  async take<Value>(key: string): Promise<Value | null> {
    const encrypted = await this.#redis.getDel(key);
    return encrypted ? decryptRecord<Value>(this.#key, encrypted) : null;
  }

  async delete(key: string): Promise<void> {
    await this.#redis.del(key);
  }
}
