/**
 * Firecrawl search step
 */
import type { FirecrawlCredentials } from "../types.js";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1";

type FirecrawlSearchResponse = {
  success: boolean;
  data?: unknown[];
  error?: string;
};

export type SearchInput = {
  query: string;
  limit?: number;
  scrapeOptions?: {
    formats?: ("markdown" | "html" | "rawHtml" | "links" | "screenshot")[];
  };
};

export type SearchResult =
  | { success: true; data?: unknown[] }
  | { success: false; error: string };

export async function searchStep(
  input: SearchInput,
  credentials: FirecrawlCredentials
): Promise<SearchResult> {
  const apiKey = credentials.FIRECRAWL_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "Firecrawl API Key is not configured.",
    };
  }

  try {
    const response = await fetch(`${FIRECRAWL_API_URL}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: input.query,
        limit: input.limit ? Number(input.limit) : undefined,
        scrapeOptions: input.scrapeOptions,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const result = (await response.json()) as FirecrawlSearchResponse;

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Search failed",
      };
    }

    return {
      success: true,
      data: result.data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to search: ${message}`,
    };
  }
}
