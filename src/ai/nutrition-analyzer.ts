import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { generateObject } from "ai";
import { z } from "zod";
import { parseNutritionItems } from "../nutrition/parser.js";
import { type NutritionItem, nutritionItemSchema } from "../targets/types.js";

const nutritionResultSchema = z.object({ items: z.array(nutritionItemSchema).min(1) }).strict();
const nutritionResultJsonSchema = removeUnsupportedWorkersAiSchemaKeywords(
  z.toJSONSchema(nutritionResultSchema),
);

export type NutritionGeneration =
  | { kind: "analyze"; text: string; localTime: string }
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
  run(model: string, input: Record<string, unknown>): Promise<{ response?: unknown }>;
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
      const result = await binding.run("@cf/meta/llama-3.1-8b-instruct-fast", {
        messages: [{ role: "user", content: promptFor(input) }],
        response_format: { type: "json_schema", json_schema: nutritionResultJsonSchema },
      });
      if (typeof result.response === "string") return JSON.parse(result.response);
      return result.response;
    },
  };
}

function removeUnsupportedWorkersAiSchemaKeywords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUnsupportedWorkersAiSchemaKeywords);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "propertyNames")
      .map(([key, nested]) => [key, removeUnsupportedWorkersAiSchemaKeywords(nested)]),
  );
}

function createAiSdkGenerator(
  model: Parameters<typeof generateObject>[0]["model"],
): NutritionGenerator {
  return {
    async generate(input) {
      const result = await generateObject({
        model,
        schema: nutritionResultSchema,
        prompt: promptFor(input),
      });
      return result.object;
    },
  };
}

function promptFor(input: NutritionGeneration): string {
  const instruction =
    "Return only food intake items. Do not include exercise, energy expenditure, or non-food activity. Do not invent ingredients or accompaniments that are not explicitly described. Do not expand a food name into a recipe or default serving format. When a name is ambiguous between a standalone item and a composite dish, use the least-composite interpretation. Nutrient values must be non-negative. Use the supplied local time to infer meal when needed.";
  if (input.kind === "analyze") {
    return `${instruction}\nLocal time: ${input.localTime}\nFood description: ${input.text}`;
  }
  return `${instruction}\nLocal time: ${input.localTime}\nExisting items: ${JSON.stringify(input.items)}\nRefinement: ${input.instruction}`;
}

function isRateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const statusCode = "status" in error ? error.status : undefined;
  if (statusCode === 429) return true;
  return error instanceof Error && /(?:^|\D)429(?:\D|$)|rate limit/i.test(error.message);
}
