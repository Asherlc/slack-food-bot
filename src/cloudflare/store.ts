export type D1RunResult = { meta: { changes?: number } };

export type D1DatabaseLike = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<D1RunResult>;
    };
  };
};

type CiphertextRow = { ciphertext: string };

export type PendingRecord = {
  id: string;
  channelId: string;
  confirmationMessageTs: string;
};

export class CloudflareStore {
  readonly #database: D1DatabaseLike;
  readonly #encryptionKey: string;

  constructor(database: D1DatabaseLike, encryptionKey: string) {
    this.#database = database;
    this.#encryptionKey = encryptionKey;
  }

  async saveInstallation(teamId: string, installation: unknown): Promise<void> {
    const ciphertext = await encrypt(this.#encryptionKey, installation);
    await this.#database
      .prepare(
        "INSERT INTO installations (team_id, ciphertext) VALUES (?, ?) ON CONFLICT(team_id) DO UPDATE SET ciphertext = excluded.ciphertext",
      )
      .bind(teamId, ciphertext)
      .run();
  }

  async loadInstallation<T>(teamId: string): Promise<T | null> {
    const row = await this.#database
      .prepare("SELECT ciphertext FROM installations WHERE team_id = ?")
      .bind(teamId)
      .first<CiphertextRow>();
    return row ? decrypt<T>(this.#encryptionKey, row.ciphertext) : null;
  }

  async saveLink(state: string, value: unknown, ttlSeconds: number): Promise<void> {
    const ciphertext = await encrypt(this.#encryptionKey, value);
    await this.#database
      .prepare(
        "INSERT INTO links (state, ciphertext, expires_at) VALUES (?, ?, unixepoch() + ?) ON CONFLICT(state) DO UPDATE SET ciphertext = excluded.ciphertext, expires_at = excluded.expires_at",
      )
      .bind(state, ciphertext, ttlSeconds)
      .run();
  }

  async consumeLink<T>(state: string): Promise<T | null> {
    const row = await this.#database
      .prepare(
        "DELETE FROM links WHERE state = ? AND expires_at > unixepoch() RETURNING ciphertext",
      )
      .bind(state)
      .first<CiphertextRow>();
    return row ? decrypt<T>(this.#encryptionKey, row.ciphertext) : null;
  }

  async saveGrant(subject: string, grant: unknown): Promise<void> {
    const ciphertext = await encrypt(this.#encryptionKey, grant);
    await this.#database
      .prepare(
        "INSERT INTO grants (subject, ciphertext) VALUES (?, ?) ON CONFLICT(subject) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = unixepoch()",
      )
      .bind(subject, ciphertext)
      .run();
  }

  async loadGrant<T>(subject: string): Promise<T | null> {
    const row = await this.#database
      .prepare("SELECT ciphertext FROM grants WHERE subject = ?")
      .bind(subject)
      .first<CiphertextRow>();
    return row ? decrypt<T>(this.#encryptionKey, row.ciphertext) : null;
  }

  async savePending<T extends PendingRecord>(
    entries: ReadonlyArray<T>,
    ttlSeconds: number,
  ): Promise<void> {
    for (const entry of entries) {
      const ciphertext = await encrypt(this.#encryptionKey, entry);
      await this.#database
        .prepare(
          "INSERT INTO pending_entries (entry_id, ciphertext, channel_id, confirmation_message_ts, expires_at) VALUES (?, ?, ?, ?, unixepoch() + ?)",
        )
        .bind(entry.id, ciphertext, entry.channelId, entry.confirmationMessageTs, ttlSeconds)
        .run();
    }
  }

  async findPending<T>(channelId: string, confirmationMessageTs: string): Promise<T[]> {
    const result = await this.#database
      .prepare(
        "SELECT ciphertext FROM pending_entries WHERE channel_id = ? AND confirmation_message_ts = ? AND expires_at > unixepoch()",
      )
      .bind(channelId, confirmationMessageTs)
      .all<CiphertextRow>();
    return Promise.all(
      result.results.map((row) => decrypt<T>(this.#encryptionKey, row.ciphertext)),
    );
  }

  async deletePending(ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    await this.#database
      .prepare(`DELETE FROM pending_entries WHERE entry_id IN (${placeholders})`)
      .bind(...ids)
      .run();
  }

  async recordDelivery(deliveryId: string): Promise<boolean> {
    const result = await this.#database
      .prepare(
        "INSERT OR IGNORE INTO deliveries (delivery_id, expires_at) VALUES (?, unixepoch() + 86400)",
      )
      .bind(deliveryId)
      .run();
    return result.meta.changes === 1;
  }
}

async function encrypt(encryptionKey: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encryptionKey);
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded),
  );
  return base64Url(new Uint8Array([...iv, ...encrypted]));
}

async function decrypt<T>(encryptionKey: string, ciphertext: string): Promise<T> {
  const combined = fromBase64Url(ciphertext);
  if (combined.length <= 28) throw new Error("Invalid encrypted record");
  const key = await importEncryptionKey(encryptionKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

function importEncryptionKey(encoded: string): Promise<CryptoKey> {
  const raw = fromBase64Url(encoded);
  if (raw.length !== 32) throw new Error("BOT_STATE_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw as unknown as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
