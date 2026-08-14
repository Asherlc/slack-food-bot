import { describe, expect, it } from "vitest";
import {
  dofekErasureAckRequestSchema,
  dofekIdempotencyKeySchema,
  dofekLinkExchangeResponseSchema,
  dofekLinkStartRequestSchema,
  dofekNutritionEntriesRequestSchema,
  dofekNutritionEntriesResponseSchema,
} from "./schemas.js";

describe("Dofek external API 1.0.0 fixture schemas", () => {
  it("validates the documented PKCE link start shape", () => {
    expect(
      dofekLinkStartRequestSchema.parse({
        redirectUri: "https://bot.example.test/link/callback",
        codeChallenge: "a".repeat(43),
        requestedScopes: ["nutrition:write"],
      }).requestedScopes,
    ).toEqual(["nutrition:write"]);
  });

  it("validates the documented link exchange response", () => {
    expect(
      dofekLinkExchangeResponseSchema.parse({
        externalSubject: "opaque-subject",
        grantId: "grant-id",
        accessToken: "opaque-access-token",
        tokenType: "Bearer",
        expiresIn: 900,
        scope: "nutrition:write",
      }).expiresIn,
    ).toBe(900);
  });

  it("requires a bounded idempotency key", () => {
    expect(() => dofekIdempotencyKeySchema.parse("too-short")).toThrow();
    expect(dofekIdempotencyKeySchema.parse("k".repeat(16))).toHaveLength(16);
    expect(() => dofekIdempotencyKeySchema.parse("k".repeat(201))).toThrow();
  });

  it("validates nutrition writes and server-computed responses", () => {
    const request = dofekNutritionEntriesRequestSchema.parse({
      entries: [
        {
          date: "2026-08-13",
          meal: "breakfast",
          foodName: "Oatmeal",
          foodDescription: "One bowl",
          category: "breads_and_cereals",
          numberOfUnits: 1,
          externalId: "draft-entry",
          nutrients: { calories: 320 },
        },
      ],
    });
    expect(request.entries).toHaveLength(1);
    expect(
      dofekNutritionEntriesResponseSchema.parse({
        entries: [{ id: "123e4567-e89b-12d3-a456-426614174000", externalId: "draft-entry" }],
        dailyIntake: {
          date: "2026-08-13",
          state: "available",
          summary: { calories: 320 },
          resolution: {},
        },
      }).dailyIntake.state,
    ).toBe("available");
  });

  it("validates idempotent erasure acknowledgement payloads", () => {
    expect(
      dofekErasureAckRequestSchema.parse({
        eventId: "event-id",
        result: "completed",
      }),
    ).toEqual({ eventId: "event-id", result: "completed" });
  });
});
