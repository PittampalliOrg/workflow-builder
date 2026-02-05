/**
 * Perplexity search step
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

export type SearchInput = {
  query: string;
  searchFocus?: "internet" | "academic" | "news" | "youtube" | "reddit";
};

export type SearchResult =
  | { success: true; answer: string; citations: string[]; model: string }
  | { success: false; error: string };

function getSearchDomains(focus?: string): string[] | undefined {
  switch (focus) {
    case "academic":
      return [
        "scholar.google.com",
        "arxiv.org",
        "pubmed.ncbi.nlm.nih.gov",
        "researchgate.net",
      ];
    case "news":
      return [
        "reuters.com",
        "apnews.com",
        "bbc.com",
        "nytimes.com",
        "theguardian.com",
      ];
    case "youtube":
      return ["youtube.com"];
    case "reddit":
      return ["reddit.com"];
    default:
      return undefined;
  }
}

export async function searchStep(
  input: SearchInput,
  credentials: PerplexityCredentials
): Promise<SearchResult> {
  const apiKey = credentials.PERPLEXITY_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "Perplexity API Key is not configured.",
    };
  }

  try {
    const response = await fetch(PERPLEXITY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful search assistant. Provide concise, accurate answers with relevant sources.",
          },
          {
            role: "user",
            content: input.query,
          },
        ],
        search_domain_filter: getSearchDomains(input.searchFocus),
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
      error: `Failed to search: ${message}`,
    };
  }
}
