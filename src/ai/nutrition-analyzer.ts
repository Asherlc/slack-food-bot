import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { generateObject, type UserContent } from "ai";
import { z } from "zod";
import { findNutritionEstimateIssue, parseNutritionItems } from "../nutrition/parser.js";
import { type NutritionItem, nutritionItemSchema } from "../targets/types.js";

const nutritionResultSchema = z.object({ items: z.array(nutritionItemSchema).min(1) }).strict();
const workersAiTextModel = "@cf/meta/llama-3.1-8b-instruct-fast";
const workersAiTextFallbackModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const workersAiObserverModel = "@cf/moondream/moondream3.1-9B-A2B";
const workersAiVisionModel = "@cf/google/gemma-4-26b-a4b-it";
const workersAiCategories = new Set<NutritionItem["category"]>([
  "beans_and_legumes",
  "beverages",
  "breads_and_cereals",
  "cheese_milk_and_dairy",
  "eggs",
  "fast_food",
  "fish_and_seafood",
  "fruit",
  "meat",
  "nuts_and_seeds",
  "pasta_rice_and_noodles",
  "salads",
  "sauces_spices_and_spreads",
  "snacks",
  "soups",
  "sweets_candy_and_desserts",
  "vegetables",
  "supplement",
  "other",
]);
const workersAiMeals = new Set<NutritionItem["meal"]>([
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "other",
]);
const workersAiCategoryAliases: Record<string, NutritionItem["category"]> = {
  bean: "beans_and_legumes",
  beans: "beans_and_legumes",
  legume: "beans_and_legumes",
  legumes: "beans_and_legumes",
  beverage: "beverages",
  drink: "beverages",
  drinks: "beverages",
  bread: "breads_and_cereals",
  breads: "breads_and_cereals",
  cereal: "breads_and_cereals",
  cereals: "breads_and_cereals",
  grain: "breads_and_cereals",
  grains: "breads_and_cereals",
  dairy: "cheese_milk_and_dairy",
  cheese_and_dairy: "cheese_milk_and_dairy",
  fish: "fish_and_seafood",
  seafood: "fish_and_seafood",
  nut: "nuts_and_seeds",
  nuts: "nuts_and_seeds",
  seed: "nuts_and_seeds",
  seeds: "nuts_and_seeds",
  pasta: "pasta_rice_and_noodles",
  rice: "pasta_rice_and_noodles",
  noodles: "pasta_rice_and_noodles",
  salad: "salads",
  sauce: "sauces_spices_and_spreads",
  sauces: "sauces_spices_and_spreads",
  spice: "sauces_spices_and_spreads",
  spices: "sauces_spices_and_spreads",
  spread: "sauces_spices_and_spreads",
  spreads: "sauces_spices_and_spreads",
  sweet: "sweets_candy_and_desserts",
  sweets: "sweets_candy_and_desserts",
  candy: "sweets_candy_and_desserts",
  dessert: "sweets_candy_and_desserts",
  desserts: "sweets_candy_and_desserts",
  vegetable: "vegetables",
  veggie: "vegetables",
  veggies: "vegetables",
  supplements: "supplement",
};

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

export class NoFoodDetectedError extends Error {
  constructor() {
    super("No food or beverage was confidently detected in the image");
    this.name = "NoFoodDetectedError";
  }
}

export type WorkersAiBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
  ): Promise<{
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    answer?: unknown;
    result?: { answer?: unknown; caption?: unknown };
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
    if (workersAi) return parseNutritionItems(await workersAi.generate(input));
    if (!gemini) {
      if (mistral) return parseNutritionItems(await mistral.generate(input));
      throw new Error("A nutrition model is required");
    }
    try {
      return parseNutritionItems(await gemini.generate(input));
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      if (mistral) return parseNutritionItems(await mistral.generate(input));
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
      let result: Awaited<ReturnType<WorkersAiBinding["run"]>>;
      if (input.kind === "analyze-image") {
        result = await analyzeWorkersAiImage(binding, input);
      } else {
        const prompt = promptFor(input) as string;
        result = await runWorkersAiText(binding, prompt);
        const firstResponse =
          result.response ?? result.answer ?? result.choices?.[0]?.message?.content;
        const firstOutput = normalizeWorkersAiOutput(parseWorkersAiResponse(firstResponse));
        const estimateIssue =
          isRecord(firstOutput) && Array.isArray(firstOutput.items)
            ? firstOutput.items.map(findNutritionEstimateIssue).find((issue) => issue !== undefined)
            : undefined;
        if (estimateIssue) {
          const reason =
            estimateIssue === "all-zero"
              ? "it contained an all-zero nutrient estimate"
              : "it reported zero calories alongside a positive macronutrient estimate";
          result = await runWorkersAiText(
            binding,
            `${prompt}\nThe previous response was invalid because ${reason}. Re-estimate realistic nutrition for the described quantity; do not use zero as a placeholder for an unknown value.`,
            workersAiTextFallbackModel,
          );
        }
      }
      const response = result.response ?? result.answer ?? result.choices?.[0]?.message?.content;
      const parsedResponse = parseWorkersAiResponse(response);
      const normalized = normalizeWorkersAiOutput(parsedResponse);
      if (
        input.kind === "analyze-image" &&
        isRecord(normalized) &&
        Array.isArray(normalized.items) &&
        normalized.items.length === 0
      )
        throw new NoFoodDetectedError();
      return normalized;
    },
  };
}

function runWorkersAiText(
  binding: WorkersAiBinding,
  prompt: string,
  model = workersAiTextModel,
): Promise<Awaited<ReturnType<WorkersAiBinding["run"]>>> {
  return binding.run(model, {
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 1024,
  });
}

async function analyzeWorkersAiImage(
  binding: WorkersAiBinding,
  input: Extract<NutritionGeneration, { kind: "analyze-image" }>,
): Promise<Awaited<ReturnType<WorkersAiBinding["run"]>>> {
  const image = imageDataUrl(input.image, input.mediaType);
  let observation: string | undefined;
  try {
    const observerResult = await binding.run(workersAiObserverModel, {
      task: "query",
      image,
      question:
        "Identify the primary prepared food category strictly from its visible geometry and structure. Distinguish individual tubular pasta pieces or casserole from pie. Do not identify toppings or infer ingredients. If there is no edible food or drink, say so plainly.",
      reasoning: false,
      temperature: 0,
      max_tokens: 128,
      stream: false,
    });
    observation = extractWorkersAiText(observerResult);
  } catch (error) {
    console.warn("Workers AI image observer unavailable", {
      model: workersAiObserverModel,
      error: error instanceof Error ? error.message.slice(0, 200) : "Unknown error",
    });
  }
  const result = await binding.run(workersAiVisionModel, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: workerPromptFor(input, observation) },
          { type: "image_url", image_url: { url: image } },
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
  const response = result.response ?? result.answer ?? result.choices?.[0]?.message?.content;
  const analysis = normalizeWorkersAiOutput(parseWorkersAiResponse(response));
  const items = isRecord(analysis) && Array.isArray(analysis.items) ? analysis.items : undefined;
  const visibleContents = normalizeVisibleContents(
    isRecord(analysis) ? analysis.visibleContents : undefined,
  );
  const validAnalysis =
    isRecord(analysis) &&
    typeof analysis.isFood === "boolean" &&
    visibleContents !== undefined &&
    items !== undefined;
  console.info("Workers AI image analysis", {
    model: workersAiVisionModel,
    valid: validAnalysis,
    isFood: isRecord(analysis) && analysis.isFood === true,
    visibleContents: visibleContents?.slice(0, 200),
  });
  if (!validAnalysis || !isRecord(analysis) || analysis.isFood !== true || !items?.length)
    throw new NoFoodDetectedError();
  const estimateIssue = items.map(findNutritionEstimateIssue).find((issue) => issue !== undefined);
  if (estimateIssue === "all-zero")
    throw new Error("Workers AI image analysis returned all-zero nutrient estimates");
  if (estimateIssue === "zero-calories-with-positive-macronutrient")
    throw new Error(
      "Workers AI image analysis returned zero calories with a positive macronutrient estimate",
    );
  if (items.some(hasGenericFoodLabel))
    throw new Error("Workers AI image analysis returned a generic food label");
  return { response: { items } };
}

function normalizeVisibleContents(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string"))
    return value.join(", ");
  return undefined;
}

function extractWorkersAiText(
  result: Awaited<ReturnType<WorkersAiBinding["run"]>>,
): string | undefined {
  const value =
    result.result?.answer ??
    result.result?.caption ??
    result.answer ??
    result.response ??
    result.choices?.[0]?.message?.content;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function parseWorkersAiResponse(response: unknown): unknown {
  if (typeof response !== "string") return response;
  const unfenced = response
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch (error) {
    const firstBrace = unfenced.indexOf("{");
    const lastBrace = unfenced.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(unfenced.slice(firstBrace, lastBrace + 1));
    }
    throw error;
  }
}

function imageDataUrl(image: Uint8Array, mediaType: string): string {
  let binary = "";
  for (const byte of image) binary += String.fromCharCode(byte);
  return `data:${mediaType};base64,${btoa(binary)}`;
}

function workerPromptFor(
  input: Extract<NutritionGeneration, { kind: "analyze-image" }>,
  observation?: string,
): string {
  return `Objectively analyze the image using visible shape and structure. An independent observer supplied this primary-food geometry hint; verify it against the image and determine toppings yourself: ${observation ?? "(observer unavailable)"}. Do not infer food from colors, context, or the fact that this prompt concerns nutrition. Toilets, waste, bodily substances, packaging without visible food, household objects, and ambiguous scenes are not food.\nReturn only one valid JSON object with isFood (boolean), visibleContents (a concise objective description), and items (an array). If edible food or a beverage is not clearly visible, set isFood to false and items to []. If food is visible, set isFood to true and populate prepared foods as served, not separate toppings, seasonings, or inferred ingredients. For a single container, return one composite item unless multiple separately served foods are clearly visible. Use a specific food name supported by visible structure; never use generic names such as dish, layered dish, meal, or food. Do not invent meat or ingredients. Follow these item rules: ${nutritionInstruction()} For visible food other than zero-calorie beverages, nutrient estimates must contain realistic positive values and must not all be zero.\nLocal time: ${input.localTime}\nOptional photo caption: ${input.text || "(none)"}`;
}

function hasGenericFoodLabel(value: unknown): boolean {
  if (!isRecord(value) || typeof value.foodName !== "string") return false;
  return /^(?:layered\s+)?(?:dish|food|meal)$/i.test(value.foodName.trim());
}

function normalizeWorkersAiOutput(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) return value;
  return {
    ...value,
    items: value.items.map((item) => {
      if (!isRecord(item)) return item;
      return {
        ...item,
        category: normalizeWorkersAiCategory(item.category),
        meal: normalizeWorkersAiMeal(item.meal),
      };
    }),
  };
}

function normalizeWorkersAiCategory(value: unknown): unknown {
  const label = normalizeWorkersAiLabel(value);
  if (typeof label !== "string") return label;
  if (workersAiCategories.has(label as NutritionItem["category"])) return label;
  return workersAiCategoryAliases[label] ?? "other";
}

function normalizeWorkersAiMeal(value: unknown): unknown {
  const label = normalizeWorkersAiLabel(value);
  if (typeof label !== "string") return label;
  return workersAiMeals.has(label as NutritionItem["meal"]) ? label : "other";
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
  return 'Return only a valid JSON object with an "items" array. Each item must have foodName, foodDescription, category, meal, and a nutrients object with non-negative numeric values. Estimate realistic nutrients for the described quantity, and never use zero as a placeholder for an unknown value. Except for an explicitly zero-calorie beverage, every item must have at least one positive nutrient estimate. Calories must be positive whenever protein, carbohydrate, or fat is positive. Category must be exactly one of: beans_and_legumes, beverages, breads_and_cereals, cheese_milk_and_dairy, eggs, fast_food, fish_and_seafood, fruit, meat, nuts_and_seeds, pasta_rice_and_noodles, salads, sauces_spices_and_spreads, snacks, soups, sweets_candy_and_desserts, vegetables, supplement, other. Meal must be exactly one of: breakfast, lunch, dinner, snack, other. Do not include Markdown or explanatory text. Return only food intake items. Do not include exercise, energy expenditure, or non-food activity. Do not invent ingredients or accompaniments that are not explicitly described. Do not expand a food name into a recipe or default serving format. When a name is ambiguous between a standalone item and a composite dish, use the least-composite interpretation. Use the supplied local time to infer meal when needed.';
}

function isRateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const statusCode = "status" in error ? error.status : undefined;
  if (statusCode === 429) return true;
  return error instanceof Error && /(?:^|\D)429(?:\D|$)|rate limit/i.test(error.message);
}
