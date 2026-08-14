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
