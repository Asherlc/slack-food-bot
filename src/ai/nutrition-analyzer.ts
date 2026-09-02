import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { generateObject, type UserContent } from "ai";
import { z } from "zod";
import { parseNutritionItems } from "../nutrition/parser.js";
import { type NutritionItem, nutritionItemSchema } from "../targets/types.js";

const nutritionResultSchema = z.object({ items: z.array(nutritionItemSchema).min(1) }).strict();
const workersAiModel = "@cf/google/gemma-4-26b-a4b-it";

export type NutritionGeneration =
  | { kind: "analyze"; text: string; localTime: string }
  | {
      kind: "analyze-image";
      image: Uint8Array;
      mediaType: string;
      text: string;
      localTime: string;
    }
  | {
      kind: "refine";
      items: ReadonlyArray<NutritionItem>;
      instruction: string;
      localTime: string;
    };

export type NutritionGenerator = {
  generate(input: NutritionGeneration): Promise<unknown>;
};

export type WorkersAiBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
  ): Promise<{
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  }>;
};

export class NutritionAnalyzer {
  readonly #gemini: NutritionGenerator | undefined;
  readonly #mistral: NutritionGenerator | undefined;
  readonly #workersAi: NutritionGenerator | undefined;

  constructor(input: {
    gemini?: NutritionGenerator;
    mistral?: NutritionGenerator;
    workersAi?: NutritionGenerator;
  }) {
    if (!input.gemini && !input.mistral && !input.workersAi)
      throw new Error("A nutrition model is required");
    this.#gemini = input.gemini;
    this.#mistral = input.mistral;
    this.#workersAi = input.workersAi;
  }

  async analyze(text: string, localTime: string): Promise<NutritionItem[]> {
    return this.#generate({ kind: "analyze", text, localTime });
  }

  async analyzeImage(
    image: Uint8Array,
    mediaType: string,
    text: string,
    localTime: string,
  ): Promise<NutritionItem[]> {
    return this.#generate({ kind: "analyze-image", image, mediaType, text, localTime });
  }

  async refine(
    items: ReadonlyArray<NutritionItem>,
    instruction: string,
    localTime: string,
  ): Promise<NutritionItem[]> {
    return this.#generate({ kind: "refine", items, instruction, localTime });
  }

  async #generate(input: NutritionGeneration): Promise<NutritionItem[]> {
    const gemini = this.#gemini;
    const mistral = this.#mistral;
    const workersAi = this.#workersAi;
    if (!gemini) {
      if (mistral) return parseNutritionItems(await mistral.generate(input));
      if (workersAi) return parseNutritionItems(await workersAi.generate(input));
      throw new Error("A nutrition model is required");
    }
    try {
      return parseNutritionItems(await gemini.generate(input));
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      if (mistral) return parseNutritionItems(await mistral.generate(input));
      if (workersAi) return parseNutritionItems(await workersAi.generate(input));
      throw error;
    }
  }
}

export function createProductionNutritionAnalyzer(input: {
  geminiApiKey?: string;
  mistralApiKey?: string;
  workersAi?: WorkersAiBinding;
}): NutritionAnalyzer {
  return new NutritionAnalyzer({
    ...(input.geminiApiKey
      ? {
          gemini: createAiSdkGenerator(
            createGoogleGenerativeAI({ apiKey: input.geminiApiKey })("gemini-2.5-flash"),
          ),
        }
      : {}),
    ...(input.mistralApiKey
      ? {
          mistral: createAiSdkGenerator(
            createMistral({ apiKey: input.mistralApiKey })("mistral-small-latest"),
          ),
        }
      : {}),
    ...(input.workersAi ? { workersAi: createWorkersAiGenerator(input.workersAi) } : {}),
  });
}

function createWorkersAiGenerator(binding: WorkersAiBinding): NutritionGenerator {
  return {
    async generate(input) {
      const content =
        input.kind === "analyze-image"
          ? [
              { type: "text", text: workerPromptFor(input) },
              {
                type: "image_url",
                image_url: { url: imageDataUrl(input.image, input.mediaType) },
              },
            ]
          : (promptFor(input) as string);
      const result = await binding.run(workersAiModel, {
        messages: [{ role: "user", content }],
      });
      const response = result.response ?? result.choices?.[0]?.message?.content;
      const parsedResponse = typeof response === "string" ? JSON.parse(response) : response;
      return normalizeWorkersAiOutput(parsedResponse);
    },
  };
}

function imageDataUrl(image: Uint8Array, mediaType: string): string {
  let binary = "";
  for (const byte of image) binary += String.fromCharCode(byte);
  return `data:${mediaType};base64,${btoa(binary)}`;
}

function workerPromptFor(input: NutritionGeneration): string {
  if (input.kind !== "analyze-image") return promptFor(input) as string;
  return `${nutritionInstruction()}\nLocal time: ${input.localTime}\nOptional photo caption: ${input.text || "(none)"}`;
}

function normalizeWorkersAiOutput(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) return value;
  return {
    ...value,
    items: value.items.map((item) => {
      if (!isRecord(item)) return item;
      return {
        ...item,
        category: normalizeWorkersAiLabel(item.category),
        meal: normalizeWorkersAiLabel(item.meal),
      };
    }),
  };
}

function normalizeWorkersAiLabel(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAiSdkGenerator(
  model: Parameters<typeof generateObject>[0]["model"],
): NutritionGenerator {
  return {
    async generate(input) {
      const prompt = promptFor(input);
      const result =
        typeof prompt === "string"
          ? await generateObject({ model, schema: nutritionResultSchema, prompt })
          : await generateObject({
              model,
              schema: nutritionResultSchema,
              messages: [{ role: "user", content: prompt }],
            });
      return result.object;
    },
  };
}

function promptFor(input: NutritionGeneration): string | UserContent {
  const instruction = nutritionInstruction();
  if (input.kind === "analyze") {
    return `${instruction}\nLocal time: ${input.localTime}\nFood description: ${input.text}`;
  }
  if (input.kind === "analyze-image") {
    return [
      {
        type: "text",
        text: `${instruction}\nLocal time: ${input.localTime}\nOptional photo caption: ${input.text || "(none)"}`,
      },
      { type: "image", image: input.image, mediaType: input.mediaType },
    ];
  }
  return `${instruction}\nLocal time: ${input.localTime}\nExisting items: ${JSON.stringify(input.items)}\nRefinement: ${input.instruction}`;
}

function nutritionInstruction(): string {
  return 'Return only a valid JSON object with an "items" array. Each item must have foodName, foodDescription, category, meal, and a nutrients object with non-negative numeric values. Do not include Markdown or explanatory text. Return only food intake items. Do not include exercise, energy expenditure, or non-food activity. Do not invent ingredients or accompaniments that are not explicitly described. Do not expand a food name into a recipe or default serving format. When a name is ambiguous between a standalone item and a composite dish, use the least-composite interpretation. Use the supplied local time to infer meal when needed.';
}

function isRateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const statusCode = "status" in error ? error.status : undefined;
  if (statusCode === 429) return true;
  return error instanceof Error && /(?:^|\D)429(?:\D|$)|rate limit/i.test(error.message);
}
