import { Redis } from "ioredis";

export class RedisAdapter {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async get(key: string): Promise<string | null> {
    return this.#redis.get(key);
  }

  async getDel(key: string): Promise<string | null> {
    const value = await this.#redis.call("GETDEL", key);
    return typeof value === "string" ? value : null;
  }

  async set(
    key: string,
    value: string,
    options?: { PX: number; NX?: boolean },
  ): Promise<"OK" | null> {
    if (!options) return this.#redis.set(key, value);
    return options.NX
      ? this.#redis.set(key, value, "PX", options.PX, "NX")
      : this.#redis.set(key, value, "PX", options.PX);
  }

  async del(...keys: string[]): Promise<number> {
    return this.#redis.del(...keys);
  }
}

export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}
