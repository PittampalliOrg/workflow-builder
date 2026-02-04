/**
 * Legacy Action Mappings
 *
 * This file maps old action type names to new namespaced action IDs.
 * Used for backward compatibility with existing workflows.
 *
 * Format: "Old Label" -> "plugin-type/action-slug"
 *
 * TODO: Remove this file once all workflows have been migrated to the new format.
 */
export const LEGACY_ACTION_MAPPINGS: Record<string, string> = {
  // Firecrawl
  Scrape: "firecrawl/scrape",
  Search: "firecrawl/search",

  // OpenAI (formerly AI Gateway)
  "Generate Text": "openai/generate-text",
  "Generate Image": "openai/generate-image",
  // Legacy ai-gateway mappings for old workflows
  "ai-gateway/generate-text": "openai/generate-text",
  "ai-gateway/generate-image": "openai/generate-image",

  // Resend
  "Send Email": "resend/send-email",

  // Linear
  "Create Ticket": "linear/create-ticket",
  "Find Issues": "linear/find-issues",

  // Slack
  "Send Slack Message": "slack/send-message",

  // v0
  "Create Chat": "v0/create-chat",
  "Send Message": "v0/send-message",
};

