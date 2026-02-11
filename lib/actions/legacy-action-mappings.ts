/**
 * Legacy Action Mappings
 *
 * Maps legacy action names to modern actionType values (function slugs).
 * Used to keep older workflows working after migrating away from the
 * legacy Next.js plugin registry.
 *
 * Format: "Legacy Name" -> "namespace/function-slug"
 *
 * Examples:
 * - "Generate Text" -> "openai/generate-text"
 * - "generate_text" -> "openai/generate-text"
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

	// AI Planner
	"Run Planner Workflow": "planner/run-workflow",
	"Plan Tasks Only": "planner/plan",
	"Execute Tasks Only": "planner/execute",
	"Execute Plan Tasks Only": "planner/execute",
	"Clone Repository": "planner/clone",
	"Clone, Plan & Execute in Sandbox": "planner/multi-step",
	"Approve Plan": "planner/approve",
	"Check Plan Status": "planner/status",
	"Run Planning Agent": "planner/plan",
	"Run Execution Agent": "planner/execute",

	// v0
	"Create Chat": "v0/create-chat",
	"Send Message": "v0/send-message",
};
