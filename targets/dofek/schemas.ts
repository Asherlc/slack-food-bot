import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const externalSubjectSchema = z
  .object({
    namespace: z.string().min(1).max(100),
    subject: z.string().min(1).max(500),
  })
  .strict();
const nutrientsSchema = z.record(z.string().min(1), z.number().finite().nonnegative());
const dailyIntakeSchema = z.object({
  date: dateSchema,
  state: z.enum(["available", "unavailable"]),
  summary: z.record(z.string(), z.unknown()).nullable(),
  resolution: z.record(z.string(), z.unknown()),
});

export const dofekIdempotencyKeySchema = z.string().min(16).max(200);

export const dofekLinkStartRequestSchema = z
  .object({
    redirectUri: z.url(),
    codeChallenge: z.string().min(43).max(128),
    requestedScopes: z
      .array(z.literal("nutrition:write"))
      .min(1)
      .superRefine((scopes, context) => {
        if (new Set(scopes).size !== scopes.length) {
          context.addIssue({ code: "custom", message: "requestedScopes must be unique" });
        }
      }),
  })
  .strict();

export const dofekLinkStartResponseSchema = z
  .object({
    linkId: z.string().min(1),
    authorizationUrl: z.url(),
    expiresAt: z.string().min(1),
  })
  .strict();

export const dofekLinkExchangeRequestSchema = z
  .object({
    linkId: z.string().min(1),
    code: z.string().min(1),
    codeVerifier: z.string().min(43).max(128),
    externalSubject: externalSubjectSchema,
  })
  .strict();

export const dofekLinkExchangeResponseSchema = z
  .object({
    externalSubject: z.string().min(1),
    grantId: z.string().min(1),
    accessToken: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresIn: z.literal(900),
    scope: z.literal("nutrition:write"),
  })
  .strict();

export const dofekLinkStatusRequestSchema = externalSubjectSchema;

export const dofekLinkStatusResponseSchema = z
  .object({
    status: z.enum(["linked", "unlinked", "revoked"]),
    externalSubject: z.string().min(1).optional(),
    grantId: z.string().min(1).optional(),
  })
  .strict();

const dofekNutritionEntrySchema = z
  .object({
    date: dateSchema,
    meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
    foodName: z.string().min(1).max(500),
    foodDescription: z.string().max(2_000).nullable().optional(),
    category: z.string().max(100).nullable().optional(),
    numberOfUnits: z.number().positive().nullable().optional(),
    externalId: z.string().min(1).max(500),
    nutrients: nutrientsSchema,
  })
  .strict();

export const dofekNutritionEntriesRequestSchema = z
  .object({ entries: z.array(dofekNutritionEntrySchema).min(1).max(100) })
  .strict();

export const dofekNutritionEntriesResponseSchema = z
  .object({
    entries: z.array(z.object({ id: z.uuid(), externalId: z.string() }).strict()),
    dailyIntake: dailyIntakeSchema,
  })
  .strict();

export const dofekErasureAckRequestSchema = z
  .object({
    eventId: z.string().min(1),
    result: z.enum(["completed", "failed"]),
    reasonCode: z.string().min(1).optional(),
  })
  .strict();

export const dofekErasureAckResponseSchema = z.object({ accepted: z.boolean() }).strict();

export const dofekProblemSchema = z
  .object({
    type: z.url(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.array(z.unknown()).optional(),
  })
  .strict();
