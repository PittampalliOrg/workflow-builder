/**
 * Perplexity ask step
 */
import type { PerplexityCredentials } from "../types.js";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

type PerplexityMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type PerplexityCitation = {
  url: string;
  text?: string;
};

type PerplexityResponse = {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: PerplexityMessage;
    finish_reason: string;
  }>;
  citations?: PerplexityCitation[] | string[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type AskInput = {
  question: string;
  systemPrompt?: string;
  model?: string;
};

export type AskResult =
  | { success: true; answer: string; citations: string[]; model: string }
  | { success: false; error: string };

export async function askStep(
  input: AskInput,
  credentials: PerplexityCredentials
): Promise<AskResult> {
  const apiKey = credentials.PERPLEXITY_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "Perplexity API Key is not configured.",
    };
  }

  try {
    const messages: PerplexityMessage[] = [];

    if (input.systemPrompt) {
      messages.push({
        role: "system",
        content: input.systemPrompt,
      });
    } else {
      messages.push({
        role: "system",
        content:
          "You are a helpful AI assistant. Provide accurate, well-researched answers with citations when available.",
      });
    }

    messages.push({
      role: "user",
      content: input.question,
    });

    const response = await fetch(PERPLEXITY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.model || "sonar",
        messages,
        return_citations: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const result = (await response.json()) as PerplexityResponse;

    const answer = result.choices[0]?.message?.content || "";
    const citations = (result.citations || []).map((c) =>
      typeof c === "string" ? c : c.url
    );

    return {
      success: true,
      answer,
      citations,
      model: result.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to ask: ${message}`,
    };
  }
}
