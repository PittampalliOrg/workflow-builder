/**
 * Step Registry
 *
 * Static registry of all step handler functions.
 * This is needed because esbuild bundles everything and dynamic imports don't work.
 *
 * Each step function is imported statically and registered here.
 */

// Import all step handlers
import { generateTextStep } from "@/plugins/openai/steps/generate-text.js";
import { generateImageStep } from "@/plugins/openai/steps/generate-image.js";
import { putBlobStep } from "@/plugins/blob/steps/put.js";
import { listBlobsStep } from "@/plugins/blob/steps/list.js";
import { clerkGetUserStep } from "@/plugins/clerk/steps/get-user.js";
import { clerkCreateUserStep } from "@/plugins/clerk/steps/create-user.js";
import { clerkUpdateUserStep } from "@/plugins/clerk/steps/update-user.js";
import { clerkDeleteUserStep } from "@/plugins/clerk/steps/delete-user.js";
import { falGenerateImageStep } from "@/plugins/fal/steps/generate-image.js";
import { falGenerateVideoStep } from "@/plugins/fal/steps/generate-video.js";
import { falUpscaleImageStep } from "@/plugins/fal/steps/upscale-image.js";
import { falRemoveBackgroundStep } from "@/plugins/fal/steps/remove-background.js";
import { falImageToImageStep } from "@/plugins/fal/steps/image-to-image.js";
import { firecrawlScrapeStep } from "@/plugins/firecrawl/steps/scrape.js";
import { firecrawlSearchStep } from "@/plugins/firecrawl/steps/search.js";
import { createIssueStep } from "@/plugins/github/steps/create-issue.js";
import { listIssuesStep } from "@/plugins/github/steps/list-issues.js";
import { getIssueStep } from "@/plugins/github/steps/get-issue.js";
import { updateIssueStep } from "@/plugins/github/steps/update-issue.js";
import { cloneRepositoryStep } from "@/plugins/github/steps/clone-repository.js";
import { createTicketStep } from "@/plugins/linear/steps/create-ticket.js";
import { findIssuesStep } from "@/plugins/linear/steps/find-issues.js";
import { perplexitySearchStep } from "@/plugins/perplexity/steps/search.js";
import { perplexityAskStep } from "@/plugins/perplexity/steps/ask.js";
import { perplexityResearchStep } from "@/plugins/perplexity/steps/research.js";
import { sendEmailStep } from "@/plugins/resend/steps/send-email.js";
import { sendSlackMessageStep } from "@/plugins/slack/steps/send-slack-message.js";
import { createCustomerStep } from "@/plugins/stripe/steps/create-customer.js";
import { getCustomerStep } from "@/plugins/stripe/steps/get-customer.js";
import { createInvoiceStep } from "@/plugins/stripe/steps/create-invoice.js";
import { superagentGuardStep } from "@/plugins/superagent/steps/guard.js";
import { superagentRedactStep } from "@/plugins/superagent/steps/redact.js";
import { createChatStep } from "@/plugins/v0/steps/create-chat.js";
import { sendMessageStep } from "@/plugins/v0/steps/send-message.js";
import { listSitesStep } from "@/plugins/webflow/steps/list-sites.js";
import { getSiteStep } from "@/plugins/webflow/steps/get-site.js";
import { publishSiteStep } from "@/plugins/webflow/steps/publish-site.js";

// Step function type - use any to allow different input types
// biome-ignore lint/suspicious/noExplicitAny: Step functions have different input types
type StepFunction = (input: any) => Promise<unknown>;

/**
 * System HTTP Request Step
 * Makes an HTTP request to any endpoint
 */
async function systemHttpRequestStep(input: {
  url?: string;
  endpoint?: string;
  httpMethod?: string;
  method?: string;
  headers?: string | Record<string, string>;
  body?: string | Record<string, unknown>;
  httpHeaders?: string;
  httpBody?: string;
}): Promise<{ success: boolean; data?: unknown; error?: string; status?: number }> {
  const url = input.url || input.endpoint;
  if (!url) {
    return { success: false, error: "HTTP request failed: URL is required" };
  }

  const method = (input.method || input.httpMethod || "GET").toUpperCase();

  // Parse headers
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  const headerInput = input.headers || input.httpHeaders;
  if (headerInput) {
    if (typeof headerInput === "string") {
      try { headers = { ...headers, ...JSON.parse(headerInput) }; } catch {}
    } else {
      headers = { ...headers, ...headerInput };
    }
  }

  // Parse body
  let body: string | undefined;
  const bodyInput = input.body || input.httpBody;
  if (method !== "GET" && bodyInput) {
    body = typeof bodyInput === "string" ? bodyInput : JSON.stringify(bodyInput);
  }

  try {
    const response = await fetch(url, { method, headers, body });
    const contentType = response.headers.get("content-type");
    const data = contentType?.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
        status: response.status
      };
    }

    return { success: true, data, status: response.status };
  } catch (error) {
    return {
      success: false,
      error: `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// Registry mapping activity IDs to step functions
const stepRegistry: Record<string, StepFunction> = {
  // OpenAI
  "openai/generate-text": generateTextStep,
  "openai/generate-image": generateImageStep,
  // AI plugin aliases (used by visual workflow builder)
  "ai/generate-text": generateTextStep,
  "ai/generate-image": generateImageStep,
  // Legacy AI Gateway mappings for backwards compatibility
  "ai-gateway/generate-text": generateTextStep,
  "ai-gateway/generate-image": generateImageStep,

  // Blob
  "blob/put": putBlobStep,
  "blob/list": listBlobsStep,

  // Clerk
  "clerk/get-user": clerkGetUserStep,
  "clerk/create-user": clerkCreateUserStep,
  "clerk/update-user": clerkUpdateUserStep,
  "clerk/delete-user": clerkDeleteUserStep,

  // fal.ai
  "fal/generate-image": falGenerateImageStep,
  "fal/generate-video": falGenerateVideoStep,
  "fal/upscale-image": falUpscaleImageStep,
  "fal/remove-background": falRemoveBackgroundStep,
  "fal/image-to-image": falImageToImageStep,

  // Firecrawl
  "firecrawl/scrape": firecrawlScrapeStep,
  "firecrawl/search": firecrawlSearchStep,

  // GitHub
  "github/create-issue": createIssueStep,
  "github/list-issues": listIssuesStep,
  "github/get-issue": getIssueStep,
  "github/update-issue": updateIssueStep,
  "github/clone-repository": cloneRepositoryStep,
  // Legacy activity name for backwards compatibility
  "clone_repository": cloneRepositoryStep,

  // Linear
  "linear/create-ticket": createTicketStep,
  "linear/find-issues": findIssuesStep,

  // Perplexity
  "perplexity/search": perplexitySearchStep,
  "perplexity/ask": perplexityAskStep,
  "perplexity/research": perplexityResearchStep,

  // Resend
  "resend/send-email": sendEmailStep,

  // Slack
  "slack/send-message": sendSlackMessageStep,

  // Stripe
  "stripe/create-customer": createCustomerStep,
  "stripe/get-customer": getCustomerStep,
  "stripe/create-invoice": createInvoiceStep,

  // Superagent
  "superagent/guard": superagentGuardStep,
  "superagent/redact": superagentRedactStep,

  // v0
  "v0/create-chat": createChatStep,
  "v0/send-message": sendMessageStep,

  // Webflow
  "webflow/list-sites": listSitesStep,
  "webflow/get-site": getSiteStep,
  "webflow/publish-site": publishSiteStep,

  // System - HTTP Request (display name format used by System plugin)
  "HTTP Request": systemHttpRequestStep,
  "system/http-request": systemHttpRequestStep,
};

/**
 * Get a step function by activity ID
 */
export function getStepFunction(activityId: string): StepFunction | undefined {
  return stepRegistry[activityId];
}

/**
 * Get all registered activity IDs
 */
export function getRegisteredActivityIds(): string[] {
  return Object.keys(stepRegistry);
}

/**
 * Check if an activity ID is registered
 */
export function isActivityRegistered(activityId: string): boolean {
  return activityId in stepRegistry;
}
