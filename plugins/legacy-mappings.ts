/**
 * Legacy Action Mappings
 *
 * Maps legacy action names to modern actionType values (function slugs).
 * Used during migration to convert old workflows to the new format.
 *
 * Migration path:
 * 1. Old activity nodes (with activityName) → action nodes (with actionType)
 * 2. Old action nodes (with functionSlug) → action nodes (with actionType)
 * 3. Legacy labels → standardized function slugs
 *
 * Format: "Legacy Name" -> "namespace/function-slug"
 *
 * Examples:
 * - "Generate Text" → "openai/generate-text"
 * - "generate_text" → "openai/generate-text"
 * - "ai-gateway/generate-text" → "openai/generate-text"
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
  // Legacy activity names (snake_case)
  generate_text: "openai/generate-text",
  generate_image: "openai/generate-image",
  clone_repository: "github/clone-repository",
  create_issue: "github/create-issue",
  list_issues: "github/list-issues",
  get_issue: "github/get-issue",
  send_message: "slack/send-message",
  send_email: "resend/send-email",
  create_ticket: "linear/create-ticket",
  find_issues: "linear/find-issues",

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

