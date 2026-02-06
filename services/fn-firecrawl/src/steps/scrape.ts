/**
 * Firecrawl scrape step
 */
import type { FirecrawlCredentials } from "../types.js";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1";

type FirecrawlScrapeResponse = {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
};

export type ScrapeInput = {
  url: string;
  formats?: ("markdown" | "html" | "rawHtml" | "links" | "screenshot")[];
};

export type ScrapeResult =
  | { success: true; markdown?: string; metadata?: Record<string, unknown> }
  | { success: false; error: string };

export async function scrapeStep(
  input: ScrapeInput,
  credentials: FirecrawlCredentials
): Promise<ScrapeResult> {
  const apiKey = credentials.FIRECRAWL_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "Firecrawl API Key is not configured.",
    };
  }

  try {
    const response = await fetch(`${FIRECRAWL_API_URL}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: input.url,
        formats: input.formats || ["markdown"],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const result = (await response.json()) as FirecrawlScrapeResponse;

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Scrape failed",
      };
    }

    return {
      success: true,
      markdown: result.data?.markdown,
      metadata: result.data?.metadata,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to scrape: ${message}`,
    };
  }
}
