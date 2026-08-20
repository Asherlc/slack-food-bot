import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { generateObject } from "ai";
import { z } from "zod";
import { parseNutritionItems } from "../nutrition/parser.js";
import { type NutritionItem, nutritionItemSchema } from "../targets/types.js";

const nutritionResultSchema = z.object({ items: z.array(nutritionItemSchema).min(1) }).strict();

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

export class NutritionAnalyzer {
  readonly #gemini: NutritionGenerator | undefined;
  readonly #mistral: NutritionGenerator | undefined;

  constructor(input: { gemini?: NutritionGenerator; mistral?: NutritionGenerator }) {
    if (!input.gemini && !input.mistral) throw new Error("A nutrition model is required");
    this.#gemini = input.gemini;
    this.#mistral = input.mistral;
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
    if (!gemini) {
      if (!mistral) throw new Error("A nutrition model is required");
      return parseNutritionItems(await mistral.generate(input));
    }
    try {
      return parseNutritionItems(await gemini.generate(input));
    } catch (error) {
      if (!mistral || !isRateLimited(error)) throw error;
      return parseNutritionItems(await mistral.generate(input));
    }
  }
}

export function createProductionNutritionAnalyzer(input: {
  geminiApiKey?: string;
  mistralApiKey?: string;
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
  });
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
    "Return only food intake items. Do not include exercise, energy expenditure, or non-food activity. Nutrient values must be non-negative. Use the supplied local time to infer meal when needed.";
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
