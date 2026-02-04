import "server-only";

import OpenAI from "openai";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import { getErrorMessageAsync } from "@/lib/utils";
import type { OpenAICredentials } from "../credentials";

type GenerateImageResult =
  | { success: true; base64: string }
  | { success: false; error: string };

export type GenerateImageCoreInput = {
  imageModel?: string;
  imagePrompt?: string;
  imageSize?: string;
};

export type GenerateImageInput = StepInput &
  GenerateImageCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: GenerateImageCoreInput,
  credentials: OpenAICredentials
): Promise<GenerateImageResult> {
  const apiKey = credentials.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error:
        "OPENAI_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  const modelId = input.imageModel || "dall-e-3";
  const promptText = input.imagePrompt || "";
  const size = (input.imageSize || "1024x1024") as "1024x1024" | "1792x1024" | "1024x1792";

  if (!promptText || promptText.trim() === "") {
    return {
      success: false,
      error: "Prompt is required for image generation",
    };
  }

  try {
    const openai = new OpenAI({ apiKey });

    const response = await openai.images.generate({
      model: modelId,
      prompt: promptText,
      size,
      response_format: "b64_json",
      n: 1,
    });

    const imageData = response.data?.[0];

    if (!imageData?.b64_json) {
      return {
        success: false,
        error: "Failed to generate image: No image data returned",
      };
    }

    return { success: true, base64: imageData.b64_json };
  } catch (error) {
    const message = await getErrorMessageAsync(error);
    return {
      success: false,
      error: `Image generation failed: ${message}`,
    };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function generateImageStep(
  input: GenerateImageInput & { _credentials?: OpenAICredentials; OPENAI_API_KEY?: string }
): Promise<GenerateImageResult> {
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
generateImageStep.maxRetries = 0;

export const _integrationType = "openai";
