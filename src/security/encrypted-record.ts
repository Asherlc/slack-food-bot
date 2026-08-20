import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const initializationVectorLength = 12;
const authenticationTagLength = 16;

export function encryptRecord(key: Buffer, value: unknown): string {
  assertEncryptionKey(key);
  const initializationVector = randomBytes(initializationVectorLength);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);

  return Buffer.concat([initializationVector, ciphertext, cipher.getAuthTag()]).toString(
    "base64url",
  );
}

export function decryptRecord<Value>(key: Buffer, encrypted: string): Value {
  assertEncryptionKey(key);

  try {
    const payload = Buffer.from(encrypted, "base64url");
    if (payload.length <= initializationVectorLength + authenticationTagLength) throw new Error();

    const initializationVector = payload.subarray(0, initializationVectorLength);
    const authenticationTag = payload.subarray(-authenticationTagLength);
    const ciphertext = payload.subarray(initializationVectorLength, -authenticationTagLength);
    const decipher = createDecipheriv("aes-256-gcm", key, initializationVector);
    decipher.setAuthTag(authenticationTag);
    return JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    ) as Value;
  } catch {
    throw new Error("Encrypted record could not be authenticated");
  }
}

function assertEncryptionKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("Encrypted record key must be exactly 32 bytes");
}
