import "server-only";

import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import { getErrorMessageAsync } from "@/lib/utils";
import type { OpenAICredentials } from "../credentials";

type SchemaField = {
  name: string;
  type: string;
};

type GenerateTextResult =
  | { success: true; text: string }
  | { success: true; object: Record<string, unknown> }
  | { success: false; error: string };

export type GenerateTextCoreInput = {
  aiModel?: string;
  aiPrompt?: string;
  aiFormat?: string;
  aiSchema?: string;
};

export type GenerateTextInput = StepInput &
  GenerateTextCoreInput & {
    integrationId?: string;
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
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: GenerateTextCoreInput,
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
      const schema = JSON.parse(input.aiSchema) as SchemaField[];
      const zodSchema = buildZodSchema(schema);

      const { object } = await generateObject({
        model: openai(modelId),
        prompt: promptText,
        schema: zodSchema,
      });

      return { success: true, object };
    }

    const { text } = await generateText({
      model: openai(modelId),
      prompt: promptText,
    });

    return { success: true, text };
  } catch (error) {
    const message = await getErrorMessageAsync(error);
    return {
      success: false,
      error: `Text generation failed: ${message}`,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function generateTextStep(
  input: GenerateTextInput & { _credentials?: OpenAICredentials; OPENAI_API_KEY?: string }
): Promise<GenerateTextResult> {
  "use step";

  // Priority: injected credentials (from Dapr) > fetched credentials (from DB)
  let credentials: OpenAICredentials = {};

  // Check for Dapr-injected credentials first (activity-executor injects these)
  if (input._credentials?.OPENAI_API_KEY || input.OPENAI_API_KEY) {
    credentials = {
      OPENAI_API_KEY: input._credentials?.OPENAI_API_KEY || input.OPENAI_API_KEY,
    };
  } else if (input.integrationId) {
    // Fallback to database credentials
    credentials = await fetchCredentials(input.integrationId);
  }

  return withStepLogging(input, () => stepHandler(input, credentials));
}
generateTextStep.maxRetries = 0;

export const _integrationType = "openai";
