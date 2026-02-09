/**
 * Generate Text Step
 *
 * Uses OpenAI's GPT models to generate text responses.
 * Supports both plain text and structured object generation.
 *
 * Updated for AI SDK 6.x
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { OpenAICredentials } from "../types.js";

type SchemaField = {
  name: string;
  type: string;
};

type GenerateTextResult =
  | { success: true; text: string }
  | { success: true; object: Record<string, unknown> }
  | { success: false; error: string };

export type GenerateTextInput = {
  aiModel?: string;
  aiPrompt?: string;
  aiFormat?: string;
  aiSchema?: string;
};

/**
 * Builds a Zod schema from a field definition array
 */
function buildZodSchema(
  fields: SchemaField[]
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const schemaShape: Record<string, z.ZodTypeAny> = {};

  for (const field of fields) {
    if (field.type === "string") {
      schemaShape[field.name] = z.string();
    } else if (field.type === "number") {
      schemaShape[field.name] = z.number();
    } else if (field.type === "boolean") {
      schemaShape[field.name] = z.boolean();
    }
  }

  return z.object(schemaShape);
}

/**
 * Generate text using OpenAI (AI SDK 6.x)
 */
export async function generateTextStep(
  input: GenerateTextInput,
  credentials: OpenAICredentials
): Promise<GenerateTextResult> {
  const apiKey = credentials.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error:
        "OPENAI_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  const modelId = input.aiModel || "gpt-4o";
  const promptText = input.aiPrompt || "";

  if (!promptText || promptText.trim() === "") {
    return {
      success: false,
      error: "Prompt is required for text generation",
    };
  }

  try {
    const openai = createOpenAI({ apiKey });

    if (input.aiFormat === "object" && input.aiSchema) {
      // AI SDK 6: Use generateText with output setting for structured data
      const schema = JSON.parse(input.aiSchema) as SchemaField[];
      const zodSchema = buildZodSchema(schema);

      const { output } = await generateText({
        model: openai(modelId),
        prompt: promptText,
        output: Output.object({ schema: zodSchema }),
      });

      return { success: true, object: output as Record<string, unknown> };
    }

    const { text } = await generateText({
      model: openai(modelId),
      prompt: promptText,
    });

    return { success: true, text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Text generation failed: ${message}`,
    };
  }
}
