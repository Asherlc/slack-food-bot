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
const pastaObservation = { result: { answer: "Pasta" } };

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

  it("calculates full nutrient totals for an explicit quantity in an image caption", async () => {
    const perBarEstimate = {
      foodName: "RX Bar",
      foodDescription: "One bar",
      category: "snacks" as const,
      meal: "snack" as const,
      nutrients: { calories: 210, carbohydrates: 24, fat: 9, protein: 12 },
    };
    const gemini: NutritionGenerator = {
      generate: vi.fn(async () => ({ items: [perBarEstimate] })),
    };
    const analyzer = new NutritionAnalyzer({ gemini });

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "two rx bars", "10:00"),
    ).resolves.toEqual([
      {
        ...perBarEstimate,
        foodDescription: "two rx bars",
        numberOfUnits: 2,
        nutrients: { calories: 420, carbohydrates: 48, fat: 18, protein: 24 },
      },
    ]);
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

  it("regenerates an all-zero Workers AI text estimate for collagen powder", async () => {
    const zeroEstimate = {
      foodName: "Collagen Powder",
      foodDescription: "30 g",
      category: "supplement" as const,
      meal: "snack" as const,
      nutrients: { calories: 0, carbohydrates: 0, fat: 0, protein: 0 },
    };
    const correctedEstimate = {
      ...zeroEstimate,
      nutrients: { calories: 110, carbohydrates: 0, fat: 0, protein: 27 },
    };
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ response: { items: [zeroEstimate] } })
        .mockResolvedValueOnce({ response: { items: [correctedEstimate] } }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("30g collagen powder", "10:07")).resolves.toEqual([
      correctedEstimate,
    ]);
    expect(workersAi.run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(workersAi.run.mock.calls[0]?.[1])).toMatch(
      /every item must have at least one positive nutrient estimate/i,
    );
    expect(JSON.stringify(workersAi.run.mock.calls[1]?.[1])).toMatch(
      /previous response.*all-zero/i,
    );
  });

  it("regenerates a Workers AI text estimate when zero calories conflict with protein", async () => {
    const inconsistentEstimate = {
      foodName: "Collagen Powder",
      foodDescription: "25 g protein",
      category: "supplement" as const,
      meal: "snack" as const,
      nutrients: { calories: 0, carbohydrates: 0, fat: 0, protein: 25 },
    };
    const correctedEstimate = {
      ...inconsistentEstimate,
      nutrients: { calories: 100, carbohydrates: 0, fat: 0, protein: 25 },
    };
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ response: { items: [inconsistentEstimate] } })
        .mockResolvedValueOnce({ response: { items: [correctedEstimate] } }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("collagen powder with 25g protein", "10:07")).resolves.toEqual([
      correctedEstimate,
    ]);
    expect(workersAi.run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(workersAi.run.mock.calls[1]?.[1])).toMatch(
      /previous response.*zero calories.*positive macronutrient/i,
    );
  });

  it("falls back to a stronger model when the fast model repeats an all-zero estimate", async () => {
    const zeroEstimate = {
      foodName: "Collagen Powder",
      foodDescription: "30 g",
      category: "supplement" as const,
      meal: "snack" as const,
      nutrients: { calories: 0, carbohydrates: 0, fat: 0, protein: 0 },
    };
    const correctedEstimate = {
      ...zeroEstimate,
      nutrients: { calories: 110, carbohydrates: 0, fat: 0, protein: 27 },
    };
    const workersAi = {
      run: vi.fn(async (model: string) => ({
        response: {
          items: [
            model === "@cf/meta/llama-3.1-8b-instruct-fast" ? zeroEstimate : correctedEstimate,
          ],
        },
      })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("30g collagen powder", "10:07")).resolves.toEqual([
      correctedEstimate,
    ]);
    expect(workersAi.run).toHaveBeenCalledTimes(2);
    expect(workersAi.run).toHaveBeenNthCalledWith(
      2,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      expect.any(Object),
    );
  });

  it("preserves and totals an explicit quantity when the model drops it", async () => {
    const oneBarEstimate = {
      foodName: "RX Bar",
      foodDescription: "One bar",
      category: "snacks" as const,
      meal: "snack" as const,
      nutrients: { calories: 210, carbohydrates: 24, fat: 9, protein: 12 },
    };
    const twoBarEstimate = {
      ...oneBarEstimate,
      foodDescription: "two rx bars",
      numberOfUnits: 2,
      nutrients: { calories: 420, carbohydrates: 48, fat: 18, protein: 24 },
    };
    const workersAi = {
      run: vi.fn(async () => ({ response: { items: [oneBarEstimate] } })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("two rx bars", "10:00")).resolves.toEqual([twoBarEstimate]);
    expect(workersAi.run).toHaveBeenCalledTimes(1);
  });

  it("calculates full nutrient totals when a model returns per-unit nutrients", async () => {
    const perBarEstimate = {
      foodName: "RX Bar",
      foodDescription: "One bar",
      category: "snacks" as const,
      meal: "snack" as const,
      numberOfUnits: 2,
      nutrients: { calories: 210, carbohydrates: 24, fat: 9, protein: 12 },
    };
    const workersAi = {
      run: vi.fn(async () => ({ response: { items: [perBarEstimate] } })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("two rx bars", "10:00")).resolves.toEqual([
      {
        ...perBarEstimate,
        foodDescription: "two rx bars",
        nutrients: { calories: 420, carbohydrates: 48, fat: 18, protein: 24 },
      },
    ]);
    expect(workersAi.run).toHaveBeenCalledTimes(1);
  });

  it("does not treat a leading percentage as an item count", async () => {
    const milkEstimate = {
      foodName: "2% Milk",
      foodDescription: "One glass",
      category: "cheese_milk_and_dairy" as const,
      meal: "snack" as const,
      nutrients: { calories: 120, carbohydrates: 12, fat: 5, protein: 8 },
    };
    const workersAi = {
      run: vi.fn(async () => ({ response: { items: [milkEstimate] } })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze("2% milk", "10:00")).resolves.toEqual([milkEstimate]);
    expect(workersAi.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    "30 g collagen powder",
    "12 oz soda",
    "12 oz. soda",
    "2 % milk",
    "2 percent milk",
    "two percent milk",
    "2 pct milk",
  ])("does not treat the measurement in %s as an item count", async (text) => {
    const estimate = {
      foodName: "Measured food",
      foodDescription: "One measured serving",
      category: "other" as const,
      meal: "snack" as const,
      nutrients: { calories: 120 },
    };
    const workersAi = {
      run: vi.fn(async () => ({ response: { items: [estimate] } })),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(analyzer.analyze(text, "10:00")).resolves.toEqual([estimate]);
    expect(workersAi.run).toHaveBeenCalledTimes(1);
  });

  it("grounds Gemma nutrition analysis with a Moondream geometry observation", async () => {
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce(pastaObservation)
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  isFood: true,
                  visibleContents: ["a bowl", "oatmeal"],
                  items,
                }),
              },
            },
          ],
        }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "lunch", "12:00"),
    ).resolves.toEqual(items);

    expect(workersAi.run).toHaveBeenCalledTimes(2);
    expect(workersAi.run).toHaveBeenNthCalledWith(1, "@cf/moondream/moondream3.1-9B-A2B", {
      task: "query",
      image: "data:image/jpeg;base64,/9j/",
      question: expect.stringContaining("primary prepared food category"),
      reasoning: false,
      temperature: 0,
      max_tokens: 128,
      stream: false,
    });
    expect(workersAi.run).toHaveBeenNthCalledWith(2, "@cf/google/gemma-4-26b-a4b-it", {
      messages: [
        {
          role: "user",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringMatching(/independent.*Pasta/i),
            }),
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 512,
      reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: false },
      stream: false,
    });
  });

  it("rejects a photo that the vision model does not recognize as food", async () => {
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ result: { answer: "No food; a bathroom toilet" } })
        .mockResolvedValueOnce({
          response: { isFood: false, visibleContents: "a bathroom toilet", items: [] },
        }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
    ).rejects.toBeInstanceOf(NoFoodDetectedError);
    expect(workersAi.run).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the food-image gate returns an invalid response", async () => {
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ result: { answer: "Unclear object" } })
        .mockResolvedValueOnce({ response: { visibleContents: "unclear" } }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
    ).rejects.toBeInstanceOf(NoFoodDetectedError);
    expect(workersAi.run).toHaveBeenCalledTimes(2);
  });

  it("logs the vision gate decision and bounded visible description", async () => {
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ result: { answer: "No food" } })
        .mockResolvedValueOnce({
          response: { isFood: false, visibleContents: `toilet ${"x".repeat(300)}`, items: [] },
        }),
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    try {
      await expect(
        analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
      ).rejects.toBeInstanceOf(NoFoodDetectedError);
      expect(info).toHaveBeenCalledWith("Workers AI image analysis", {
        model: "@cf/google/gemma-4-26b-a4b-it",
        valid: true,
        isFood: false,
        visibleContents: `toilet ${"x".repeat(193)}`,
      });
    } finally {
      info.mockRestore();
    }
  });

  it("allows a zero-calorie image beverage after normalizing its category alias", async () => {
    const water = {
      foodName: "Water",
      foodDescription: "One glass",
      category: "drink",
      meal: "snack",
      nutrients: { calories: 0 },
    };
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ result: { answer: "A glass of water" } })
        .mockResolvedValueOnce({
          response: { isFood: true, visibleContents: "a glass of water", items: [water] },
        }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
    ).resolves.toEqual([{ ...water, category: "beverages" }]);
  });

  it("rejects an image result whose nutrient estimates are all zero", async () => {
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce(pastaObservation)
        .mockResolvedValueOnce({
          response: {
            isFood: true,
            visibleContents: "a slice of pie",
            items: [
              {
                foodName: "Pie",
                foodDescription: "One slice",
                category: "sweets_candy_and_desserts",
                meal: "snack",
                nutrients: { calories: 0, protein_g: 0, fat_g: 0 },
              },
            ],
          },
        }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
    ).rejects.toThrow(/zero nutrient estimates/i);
  });

  it("rejects a generic image label instead of publishing a vague draft", async () => {
    const workersAi = {
      run: vi
        .fn()
        .mockResolvedValueOnce(pastaObservation)
        .mockResolvedValueOnce({
          response: {
            isFood: true,
            visibleContents: "tubular pasta topped with cheese",
            items: [{ ...items[0], foodName: "layered dish" }],
          },
        }),
    };
    const analyzer = createProductionNutritionAnalyzer({ workersAi } as Parameters<
      typeof createProductionNutritionAnalyzer
    >[0]);

    await expect(
      analyzer.analyzeImage(new Uint8Array([255, 216, 255]), "image/jpeg", "", "12:00"),
    ).rejects.toThrow(/generic food label/i);
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
