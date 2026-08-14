import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const externalIdentitySchema = z
  .object({
    namespace: z.string().min(1).max(100),
    subject: z.string().min(1).max(500),
  })
  .strict();

export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;

const mealSchema = z.enum(["breakfast", "lunch", "dinner", "snack", "other"]);

const categorySchema = z.enum([
  "beans_and_legumes",
  "beverages",
  "breads_and_cereals",
  "cheese_milk_and_dairy",
  "eggs",
  "fast_food",
  "fish_and_seafood",
  "fruit",
  "meat",
  "nuts_and_seeds",
  "pasta_rice_and_noodles",
  "salads",
  "sauces_spices_and_spreads",
  "snacks",
  "soups",
  "sweets_candy_and_desserts",
  "vegetables",
  "supplement",
  "other",
]);

const nutrientsSchema = z.record(z.string().min(1), z.number().finite().nonnegative());

export const nutritionItemSchema = z
  .object({
    foodName: z.string().min(1).max(500),
    foodDescription: z.string().max(2_000),
    category: categorySchema,
    meal: mealSchema,
    nutrients: nutrientsSchema,
  })
  .strict();

export type NutritionItem = z.infer<typeof nutritionItemSchema>;

export const nutritionWriteEntrySchema = nutritionItemSchema.extend({
  date: dateSchema,
  externalId: z.string().min(1).max(500),
  numberOfUnits: z.number().positive().optional(),
});

export type NutritionWriteEntry = z.infer<typeof nutritionWriteEntrySchema>;

const summaryDetailsSchema = z.record(z.string(), z.unknown());

export const dailyIntakeSummarySchema = z.discriminatedUnion("state", [
  z.object({
    date: dateSchema,
    state: z.literal("available"),
    summary: summaryDetailsSchema,
    resolution: summaryDetailsSchema,
  }),
  z.object({
    date: dateSchema,
    state: z.literal("unavailable"),
    summary: z.null(),
    resolution: summaryDetailsSchema,
  }),
]);

export type DailyIntakeSummary = z.infer<typeof dailyIntakeSummarySchema>;

export type IdentityLinkStart = {
  linkId: string;
  authorizationUrl: string;
  expiresAt: string;
};

export type TargetGrant = {
  externalSubject: string;
  grantId: string;
  accessToken: string;
  expiresInSeconds: number;
};

export type IdentityStatus =
  | { status: "linked"; externalSubject?: string; grantId?: string }
  | { status: "unlinked" }
  | { status: "revoked"; externalSubject?: string; grantId?: string };

export type ConfirmedNutritionWrite = {
  entries: ReadonlyArray<{ id: string; externalId: string }>;
  dailyIntake: DailyIntakeSummary;
};

export type ErasureAcknowledgement = { accepted: boolean };

export interface NutritionTarget {
  startIdentityLink(input: {
    redirectUri: string;
    codeChallenge: string;
    requestedScopes: ReadonlyArray<string>;
  }): Promise<IdentityLinkStart>;

  exchangeIdentityLink(input: {
    linkId: string;
    code: string;
    codeVerifier: string;
    identity: ExternalIdentity;
  }): Promise<TargetGrant>;

  getIdentityStatus(input: { identity: ExternalIdentity }): Promise<IdentityStatus>;

  confirmFood(input: {
    grant: TargetGrant;
    idempotencyKey: string;
    entries: ReadonlyArray<NutritionWriteEntry>;
  }): Promise<ConfirmedNutritionWrite>;

  acknowledgeErasure(input: {
    grant: TargetGrant;
    eventId: string;
    result: "completed" | "failed";
    reasonCode?: string;
  }): Promise<ErasureAcknowledgement>;
}
