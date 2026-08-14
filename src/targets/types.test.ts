import { describe, expect, it } from "vitest";
import { dailyIntakeSummarySchema, type NutritionTarget, nutritionItemSchema } from "./types.js";

describe("target-neutral nutrition contracts", () => {
  it("accepts intake nutrients without target-specific fields", () => {
    expect(
      nutritionItemSchema.parse({
        foodName: "Oatmeal",
        foodDescription: "One bowl",
        category: "breads_and_cereals",
        meal: "breakfast",
        nutrients: { calories: 320, protein_g: 12 },
      }),
    ).toEqual({
      foodName: "Oatmeal",
      foodDescription: "One bowl",
      category: "breads_and_cereals",
      meal: "breakfast",
      nutrients: { calories: 320, protein_g: 12 },
    });
  });

  it("rejects expenditure calories from intake items", () => {
    expect(() =>
      nutritionItemSchema.parse({
        foodName: "Oatmeal",
        foodDescription: "One bowl",
        category: "breads_and_cereals",
        meal: "breakfast",
        nutrients: { calories: 320 },
        expenditureCalories: 600,
      }),
    ).toThrow();
  });

  it("accepts both server-owned daily summary states", () => {
    expect(
      dailyIntakeSummarySchema.parse({
        date: "2026-08-13",
        state: "available",
        summary: { calories: 800 },
        resolution: { source: "server" },
      }).state,
    ).toBe("available");
    expect(
      dailyIntakeSummarySchema.parse({
        date: "2026-08-13",
        state: "unavailable",
        summary: null,
        resolution: { message: "conflict" },
      }).state,
    ).toBe("unavailable");
  });

  it("allows a target implementation to depend only on opaque core types", () => {
    const target: NutritionTarget = {
      startIdentityLink: async () => ({
        linkId: "link",
        authorizationUrl: "https://target.example.test/authorize",
        expiresAt: "2026-08-13T12:00:00Z",
      }),
      exchangeIdentityLink: async () => ({
        externalSubject: "opaque-subject",
        grantId: "grant",
        accessToken: "opaque-token",
        expiresInSeconds: 900,
      }),
      getIdentityStatus: async () => ({ status: "linked" }),
      confirmFood: async () => ({
        entries: [{ id: "entry", externalId: "app-entry" }],
        dailyIntake: {
          date: "2026-08-13",
          state: "unavailable",
          summary: null,
          resolution: {},
        },
      }),
      acknowledgeErasure: async () => ({ accepted: true }),
    };

    expect(
      target.getIdentityStatus({ identity: { namespace: "app", subject: "user" } }),
    ).resolves.toEqual({ status: "linked" });
  });
});
