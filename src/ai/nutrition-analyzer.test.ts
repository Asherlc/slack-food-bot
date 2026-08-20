import { describe, expect, it, vi } from "vitest";
import {
  createProductionNutritionAnalyzer,
  NutritionAnalyzer,
  type NutritionGenerator,
} from "./nutrition-analyzer.js";

const items = [
  {
    foodName: "Oatmeal",
    foodDescription: "One bowl",
    category: "breads_and_cereals" as const,
    meal: "breakfast" as const,
    nutrients: { calories: 320, protein_g: 12 },
  },
];

describe("NutritionAnalyzer", () => {
  it("uses Gemini first for structured intake parsing", async () => {
    const gemini: NutritionGenerator = { generate: vi.fn(async () => ({ items })) };
    const mistral: NutritionGenerator = { generate: vi.fn(async () => ({ items: [] })) };
    const analyzer = new NutritionAnalyzer({ gemini, mistral });

    await expect(analyzer.analyze("oatmeal for breakfast", "08:00")).resolves.toEqual(items);

    expect(gemini.generate).toHaveBeenCalledWith({
      kind: "analyze",
      text: "oatmeal for breakfast",
      localTime: "08:00",
    });
    expect(mistral.generate).not.toHaveBeenCalled();
  });

  it("falls back to Mistral only after a Gemini rate limit", async () => {
    const gemini: NutritionGenerator = {
      generate: vi.fn(async () => {
        throw new Error("429 Too Many Requests");
      }),
    };
    const mistral: NutritionGenerator = { generate: vi.fn(async () => ({ items })) };
    const analyzer = new NutritionAnalyzer({ gemini, mistral });

    await expect(analyzer.analyze("oatmeal for breakfast", "08:00")).resolves.toEqual(items);
    expect(mistral.generate).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on a non-rate-limit Gemini failure", async () => {
    const gemini: NutritionGenerator = {
      generate: vi.fn(async () => {
        throw new Error("invalid credentials");
      }),
    };
    const mistral: NutritionGenerator = { generate: vi.fn(async () => ({ items })) };
    const analyzer = new NutritionAnalyzer({ gemini, mistral });

    await expect(analyzer.analyze("oatmeal for breakfast", "08:00")).rejects.toThrow(
      "invalid credentials",
    );
    expect(mistral.generate).not.toHaveBeenCalled();
  });

  it("rejects model output containing expenditure nutrients", async () => {
    const gemini: NutritionGenerator = {
      generate: vi.fn(async () => ({
        items: [{ ...items[0], nutrients: { expenditure_calories: 500 } }],
      })),
    };
    const analyzer = new NutritionAnalyzer({ gemini });

    await expect(analyzer.analyze("ran 5k and ate oatmeal", "08:00")).rejects.toThrow(
      /intake nutrients/,
    );
  });

  it("uses a Workers AI binding when external model keys are unavailable", async () => {
    const workersAi = {
      run: vi.fn(async () => ({ response: { items } })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("oatmeal for breakfast", "08:00")).resolves.toEqual(items);
    expect(workersAi.run).toHaveBeenCalledWith(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      expect.objectContaining({
        response_format: expect.objectContaining({
          type: "json_schema",
          json_schema: expect.objectContaining({
            properties: expect.objectContaining({ items: expect.any(Object) }),
          }),
        }),
      }),
    );
    const firstRequest = workersAi.run.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(JSON.stringify(firstRequest?.[1])).not.toContain("propertyNames");
    expect(JSON.stringify(firstRequest?.[1])).toContain(
      "Do not invent ingredients or accompaniments",
    );
    expect(JSON.stringify(firstRequest?.[1])).toContain("least-composite interpretation");
  });
});
