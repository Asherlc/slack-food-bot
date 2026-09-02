import { describe, expect, it, vi } from "vitest";
import {
  createProductionNutritionAnalyzer,
  NoFoodDetectedError,
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

  it("prefers Workers AI over paid providers when the Cloudflare binding is available", async () => {
    const workersAi: NutritionGenerator = { generate: vi.fn(async () => ({ items })) };
    const gemini: NutritionGenerator = { generate: vi.fn(async () => ({ items: [] })) };
    const mistral: NutritionGenerator = { generate: vi.fn(async () => ({ items: [] })) };
    const analyzer = new NutritionAnalyzer({ workersAi, gemini, mistral });

    await expect(analyzer.analyze("oatmeal", "08:00")).resolves.toEqual(items);

    expect(workersAi.generate).toHaveBeenCalledTimes(1);
    expect(gemini.generate).not.toHaveBeenCalled();
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

  it("uses the fast Workers AI text model when external model keys are unavailable", async () => {
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
        max_tokens: 1024,
        temperature: 0,
      }),
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
      run: vi
        .fn()
        .mockResolvedValueOnce({ response: { isFood: true, visibleContents: "oatmeal" } })
        .mockResolvedValueOnce({
          response: `\`\`\`json\n${JSON.stringify({ items })}\n\`\`\``,
        }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "lunch", "12:00"),
    ).resolves.toEqual(items);

    expect(workersAi.run).toHaveBeenNthCalledWith(1, "@cf/meta/llama-4-scout-17b-16e-instruct", {
      messages: [
        {
          role: "user",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("objectively describe only what is visibly present"),
            }),
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ],
      response_format: expect.objectContaining({ type: "json_schema" }),
      temperature: 0,
      max_tokens: 128,
    });
    expect(workersAi.run).toHaveBeenNthCalledWith(2, "@cf/meta/llama-4-scout-17b-16e-instruct", {
      messages: [
        {
          role: "user",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining('return {"items":[]}'),
            }),
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 1024,
    });
  });

  it("rejects a photo that the vision model does not recognize as food", async () => {
    const workersAi = {
      run: vi.fn(async () => ({
        response: { isFood: false, visibleContents: "a bathroom toilet" },
      })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
    ).rejects.toBeInstanceOf(NoFoodDetectedError);
    expect(workersAi.run).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the food-image gate returns an invalid response", async () => {
    const workersAi = {
      run: vi.fn(async () => ({ response: { visibleContents: "unclear" } })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
    ).rejects.toBeInstanceOf(NoFoodDetectedError);
    expect(workersAi.run).toHaveBeenCalledTimes(1);
  });

  it("logs the vision gate decision and bounded visible description", async () => {
    const workersAi = {
      run: vi.fn(async () => ({
        response: { isFood: false, visibleContents: `toilet ${"x".repeat(300)}` },
      })),
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    try {
      await expect(
        analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
      ).rejects.toBeInstanceOf(NoFoodDetectedError);
      expect(info).toHaveBeenCalledWith("Workers AI image gate", {
        model: "@cf/meta/llama-4-scout-17b-16e-instruct",
        valid: true,
        isFood: false,
        visibleContents: `toilet ${"x".repeat(193)}`,
      });
    } finally {
      info.mockRestore();
    }
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

  it("maps Workers AI category aliases and unsupported meal labels to valid values", async () => {
    const workersAi = {
      run: vi.fn(async () => ({
        response: {
          items: [{ ...items[0], category: "grains", meal: "brunch" }],
        },
      })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("oatmeal", "11:00")).resolves.toEqual([
      { ...items[0], category: "breads_and_cereals", meal: "other" },
    ]);
  });

  it("falls back to other for unknown Workers AI category labels", async () => {
    const workersAi = {
      run: vi.fn(async () => ({
        response: {
          items: [{ ...items[0], category: "home cooking", meal: "Breakfast" }],
        },
      })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("oatmeal", "08:00")).resolves.toEqual([
      { ...items[0], category: "other" },
    ]);
  });
});
