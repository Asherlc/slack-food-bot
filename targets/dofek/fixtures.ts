import {
  dofekErasureAckRequestSchema,
  dofekLinkExchangeResponseSchema,
  dofekLinkStartRequestSchema,
  dofekNutritionEntriesRequestSchema,
  dofekNutritionEntriesResponseSchema,
} from "./schemas.js";

export const dofekFixtureExamples = {
  linkStartRequest: dofekLinkStartRequestSchema.parse({
    redirectUri: "https://bot.example.test/link/callback",
    codeChallenge: "a".repeat(43),
    requestedScopes: ["nutrition:write"],
  }),
  linkExchangeResponse: dofekLinkExchangeResponseSchema.parse({
    externalSubject: "opaque-subject",
    grantId: "grant-id",
    accessToken: "opaque-access-token",
    tokenType: "Bearer",
    expiresIn: 900,
    scope: "nutrition:write",
  }),
  nutritionEntriesRequest: dofekNutritionEntriesRequestSchema.parse({
    entries: [
      {
        date: "2026-08-13",
        foodName: "Oatmeal",
        foodDescription: "One bowl",
        category: "breads_and_cereals",
        meal: "breakfast",
        externalId: "draft-entry",
        nutrients: { calories: 320 },
      },
    ],
  }),
  nutritionEntriesResponse: dofekNutritionEntriesResponseSchema.parse({
    entries: [{ id: "123e4567-e89b-12d3-a456-426614174000", externalId: "draft-entry" }],
    dailyIntake: {
      date: "2026-08-13",
      state: "available",
      summary: { calories: 320 },
      resolution: {},
    },
  }),
  erasureAcknowledgement: dofekErasureAckRequestSchema.parse({
    eventId: "event-id",
    result: "completed",
  }),
} as const;
