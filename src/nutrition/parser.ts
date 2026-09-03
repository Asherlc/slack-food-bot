import { z } from "zod";
import { type NutritionItem, nutritionItemSchema } from "../targets/types.js";

const prohibitedNutrientKey = /(expenditure|burned|energy[_ ]out)/i;
const calorieNutrientKeys = new Set(["calorie", "calories"]);
const energyBearingMacronutrientKeys = new Set([
  "protein",
  "protein_g",
  "protein_grams",
  "carbohydrate",
  "carbohydrates",
  "carbs",
  "carbohydrate_g",
  "carbohydrates_g",
  "carbs_g",
  "fat",
  "fats",
  "fat_g",
]);

export type NutritionEstimateIssue = "all-zero" | "zero-calories-with-positive-macronutrient";

export function findNutritionEstimateIssue(value: unknown): NutritionEstimateIssue | undefined {
  if (!isRecord(value) || !isRecord(value.nutrients)) return undefined;

  const nutrients = Object.entries(value.nutrients);
  const hasZeroCalorieEstimate = nutrients.some(
    ([name, amount]) => calorieNutrientKeys.has(normalizeNutrientName(name)) && amount === 0,
  );
  const hasPositiveMacronutrient = nutrients.some(
    ([name, amount]) =>
      energyBearingMacronutrientKeys.has(normalizeNutrientName(name)) &&
      typeof amount === "number" &&
      amount > 0,
  );
  if (hasZeroCalorieEstimate && hasPositiveMacronutrient)
    return "zero-calories-with-positive-macronutrient";

  const nutrientValues = nutrients.map(([, amount]) => amount);
  if (
    value.category !== "beverages" &&
    (nutrientValues.length === 0 || nutrientValues.every((nutrient) => nutrient === 0))
  )
    return "all-zero";

  return undefined;
}

const intakeItemSchema = nutritionItemSchema.superRefine((item, context) => {
  const estimateIssue = findNutritionEstimateIssue(item);
  if (estimateIssue === "all-zero") {
    context.addIssue({
      code: "custom",
      path: ["nutrients"],
      message: "Food and supplements cannot have all-zero nutrient estimates",
    });
  }
  if (estimateIssue === "zero-calories-with-positive-macronutrient") {
    context.addIssue({
      code: "custom",
      path: ["nutrients", "calories"],
      message: "Zero calories cannot be paired with a positive macronutrient estimate",
    });
  }
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

function normalizeNutrientName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
