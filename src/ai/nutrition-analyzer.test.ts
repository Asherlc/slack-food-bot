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
  it("passes a meal photo and optional caption to the vision analyzer", async () => {
    const gemini: NutritionGenerator = { generate: vi.fn(async () => ({ items })) };
    const analyzer = new NutritionAnalyzer({ gemini });
    const image = new Uint8Array([255, 216, 255]);

    await expect(
      analyzer.analyzeImage(image, "image/jpeg", "with avocado", "12:30"),
    ).resolves.toEqual(items);

    expect(gemini.generate).toHaveBeenCalledWith({
      kind: "analyze-image",
      image,
      mediaType: "image/jpeg",
      text: "with avocado",
      localTime: "12:30",
    });
  });

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

  it("uses Gemma without unsupported schema mode when external model keys are unavailable", async () => {
    const workersAi = {
      run: vi.fn(async () => ({ response: { items } })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("oatmeal for breakfast", "08:00")).resolves.toEqual(items);
    expect(workersAi.run).toHaveBeenCalledWith(
      "@cf/google/gemma-4-26b-a4b-it",
      expect.not.objectContaining({ response_format: expect.anything() }),
    );
    const firstRequest = workersAi.run.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(JSON.stringify(firstRequest?.[1])).toContain(
      "Do not invent ingredients or accompaniments",
    );
    expect(JSON.stringify(firstRequest?.[1])).toContain("least-composite interpretation");
    expect(JSON.stringify(firstRequest?.[1])).toContain(
      'valid JSON object with an \\"items\\" array',
    );
  });

  it("uses the Workers AI vision model for a meal photo without a Gemini key", async () => {
    const workersAi = {
      run: vi.fn(async () => ({ response: { items } })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "lunch", "12:00"),
    ).resolves.toEqual(items);

    expect(workersAi.run).toHaveBeenCalledWith("@cf/google/gemma-4-26b-a4b-it", {
      messages: [
        {
          role: "user",
          content: [
            expect.objectContaining({ type: "text", text: expect.stringContaining("lunch") }),
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ],
    });
  });

  it("parses the JSON content from a Workers AI chat completion", async () => {
    const workersAi = {
      run: vi.fn(async () => ({
        choices: [{ message: { content: JSON.stringify({ items }) } }],
      })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("oatmeal for breakfast", "08:00")).resolves.toEqual(items);
  });

  it("normalizes human-readable Workers AI enum labels", async () => {
    const workersAi = {
      run: vi.fn(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ ...items[0], category: "Breads and Cereals", meal: "Breakfast" }],
              }),
            },
          },
        ],
      })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("oatmeal for breakfast", "08:00")).resolves.toEqual(items);
  });
});
