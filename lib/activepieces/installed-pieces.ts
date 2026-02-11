/**
 * Installed Activepieces Pieces
 *
 * This array is the single source of truth for which AP pieces are available
 * at runtime in fn-activepieces. Only pieces listed here will appear in the
 * UI Service dropdown.
 *
 * To add a new piece:
 * 1. Add the normalized name here
 * 2. Add the npm dependency to services/fn-activepieces/package.json
 * 3. Add the import + PIECES entry to services/fn-activepieces/src/piece-registry.ts
 * 4. Rebuild and deploy fn-activepieces
 */
export const INSTALLED_PIECES: readonly string[] = [
	// Google Suite
	"google-sheets",
	"google-calendar",
	"google-docs",
	"gmail",
	"google-drive",

	// Productivity
	"notion",
	"airtable",
	"todoist",
	"monday",

	// Communication
	"discord",
	"microsoft-teams",
	"telegram-bot",

	// Microsoft Office
	"microsoft-outlook",
	"microsoft-excel-365",
	"microsoft-todo",
	"microsoft-onedrive",
	"microsoft-onenote",

	// Project Management
	"jira-cloud",
	"asana",
	"trello",
	"clickup",

	// CRM & Marketing
	"hubspot",
	"salesforce",
	"mailchimp",

	// E-commerce & Support
	"shopify",
	"zendesk",

	// Email
	"sendgrid",

	// Storage
	"dropbox",

	// AI & ML
	"openai",
	"claude",
	"azure-openai",
	"hugging-face",
	"perplexity-ai",
	"contextual-ai",

	// Developer Tools
	"linear",
	"postgres",
	"nocodb",
	"browserless",
	"browse-ai",
	"bitly",

	// Cloud
	"azure-blob-storage",

	// Communication (extended)
	"resend",
	"linkedin",

	// Media
	"youtube",
];

const INSTALLED_SET = new Set(
	INSTALLED_PIECES.map((name) => name.toLowerCase()),
);

/**
 * Normalize AP piece names to a canonical short slug.
 * Handles:
 * - full package names: "@activepieces/piece-google-sheets"
 * - short names: "google-sheets"
 * - underscore variants: "google_sheets"
 */
export function normalizePieceName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, "")
		.replace(/[_\s]+/g, "-")
		.replace(/-+/g, "-");
}

/**
 * Check if a piece name (raw or with @activepieces/piece- prefix) is installed.
 */
export function isPieceInstalled(name: string): boolean {
	const normalized = normalizePieceName(name);
	return INSTALLED_SET.has(normalized);
}
