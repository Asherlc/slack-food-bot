import { describe, expect, it } from "vitest";
import { parseNutritionItems, parseRefinement } from "./parser.js";

const item = {
  foodName: "Oatmeal",
  foodDescription: "One bowl",
  category: "breads_and_cereals",
  meal: "breakfast",
  nutrients: { calories: 320, protein_g: 12 },
} as const;

describe("nutrition parser contracts", () => {
  it("parses a multi-item intake result", () => {
    expect(parseNutritionItems({ items: [item, { ...item, foodName: "Banana" }] })).toEqual([
      item,
      { ...item, foodName: "Banana" },
    ]);
  });

  it("rejects negative nutrients and expenditure calories", () => {
    expect(() =>
      parseNutritionItems({ items: [{ ...item, nutrients: { calories: -1 } }] }),
    ).toThrow();
    expect(() =>
      parseNutritionItems({ items: [{ ...item, nutrients: { expenditure_calories: 500 } }] }),
    ).toThrow();
    expect(() => parseNutritionItems({ items: [{ ...item, expenditureCalories: 500 }] })).toThrow();
  });

  it("rejects all-zero nutrient estimates for a supplement", () => {
    expect(() =>
      parseNutritionItems({
        items: [
          {
            foodName: "Collagen Powder",
            foodDescription: "30 g",
            category: "supplement",
            meal: "snack",
            nutrients: { calories: 0, carbohydrates: 0, fat: 0, protein: 0 },
          },
        ],
      }),
    ).toThrow(/all-zero nutrient estimates/i);
  });

  it("rejects zero calories when an energy-bearing macronutrient is positive", () => {
    expect(() =>
      parseNutritionItems({
        items: [
          {
            foodName: "Collagen Powder",
            foodDescription: "25 g protein",
            category: "supplement",
            meal: "snack",
            nutrients: { calories: 0, carbohydrates: 0, fat: 0, protein: 25 },
          },
        ],
      }),
    ).toThrow(/zero calories.*positive macronutrient/i);
  });

  it("allows an explicitly zero-calorie beverage", () => {
    expect(
      parseNutritionItems({
        items: [
          {
            foodName: "Water",
            foodDescription: "One glass",
            category: "beverages",
            meal: "snack",
            nutrients: { calories: 0 },
          },
        ],
      }),
    ).toEqual([
      {
        foodName: "Water",
        foodDescription: "One glass",
        category: "beverages",
        meal: "snack",
        nutrients: { calories: 0 },
      },
    ]);
  });

  it("parses a refinement with the previous draft and correction", () => {
    expect(
      parseRefinement({
        previousItems: [item],
        instruction: "Use two bowls",
        localTime: "08:30",
      }),
    ).toEqual({
      previousItems: [item],
      instruction: "Use two bowls",
      localTime: "08:30",
    });
  });
});
