import { z } from "zod";
import { type NutritionItem, nutritionItemSchema } from "../targets/types.js";

const prohibitedNutrientKey = /(expenditure|burned|energy[_ ]out)/i;

const intakeItemSchema = nutritionItemSchema.superRefine((item, context) => {
  for (const nutrientName of Object.keys(item.nutrients)) {
    if (prohibitedNutrientKey.test(nutrientName)) {
      context.addIssue({
        code: "custom",
        path: ["nutrients", nutrientName],
        message: "Expenditure calories are not intake nutrients",
      });
    }
  }
});

const itemListSchema = z.object({ items: z.array(intakeItemSchema).min(1) }).strict();

const refinementSchema = z
  .object({
    previousItems: z.array(intakeItemSchema).min(1),
    instruction: z.string().trim().min(1),
    localTime: z.string().trim().min(1).optional(),
  })
  .strict();

export type RefinementRequest = z.infer<typeof refinementSchema>;

export function parseNutritionItems(input: unknown): NutritionItem[] {
  return itemListSchema.parse(input).items;
}

export function parseRefinement(input: unknown): RefinementRequest {
  return refinementSchema.parse(input);
}
