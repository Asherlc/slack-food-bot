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

  it("preserves the number of consumed units in an intake item", () => {
    expect(
      nutritionItemSchema.parse({
        foodName: "RX Bar",
        foodDescription: "Two bars",
        category: "snacks",
        meal: "snack",
        numberOfUnits: 2,
        nutrients: { calories: 420, protein: 24 },
      }),
    ).toEqual({
      foodName: "RX Bar",
      foodDescription: "Two bars",
      category: "snacks",
      meal: "snack",
      numberOfUnits: 2,
      nutrients: { calories: 420, protein: 24 },
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
      reissueGrant: async () => ({
        externalSubject: "opaque-subject",
        grantId: "grant",
        accessToken: "rotated-token",
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
