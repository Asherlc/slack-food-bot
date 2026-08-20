import { describe, expect, it } from "vitest";
import { decryptRecord, encryptRecord } from "./encrypted-record.js";

const key = Buffer.alloc(32, 7);

describe("encrypted records", () => {
  it("round-trips a record without leaving its plaintext in the ciphertext", () => {
    const encrypted = encryptRecord(key, { accessToken: "very-secret-token" });

    expect(encrypted).not.toContain("very-secret-token");
    expect(decryptRecord<{ accessToken: string }>(key, encrypted)).toEqual({
      accessToken: "very-secret-token",
    });
  });

  it("refuses a ciphertext whose authentication tag was changed", () => {
    const encrypted = encryptRecord(key, { accessToken: "very-secret-token" });
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    expect(() => decryptRecord(key, tampered)).toThrow(
      "Encrypted record could not be authenticated",
    );
  });

  it("uses a fresh initialization vector for each record", () => {
    expect(encryptRecord(key, { value: "same" })).not.toBe(encryptRecord(key, { value: "same" }));
  });
});
