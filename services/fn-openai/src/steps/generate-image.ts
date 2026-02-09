/**
 * Generate Image Step
 *
 * Uses OpenAI's DALL-E models to generate images from text prompts.
 */
import OpenAI from "openai";
import type { OpenAICredentials } from "../types.js";

type GenerateImageResult =
  | { success: true; base64: string }
  | { success: false; error: string };

export type GenerateImageInput = {
  imageModel?: string;
  imagePrompt?: string;
  imageSize?: string;
};

/**
 * Generate image using OpenAI DALL-E
 */
export async function generateImageStep(
  input: GenerateImageInput,
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
  const size = (input.imageSize || "1024x1024") as
    | "1024x1024"
    | "1792x1024"
    | "1024x1792";

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
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Image generation failed: ${message}`,
    };
  }
}
