/**
 * Piece Registry
 *
 * Static imports of all AP piece packages used by workflow-builder.
 * Each piece exports a Piece object with getAction(name) method.
 *
 * Copied from fn-activepieces/src/piece-registry.ts (minus custom pieces).
 */

import { airtable } from "@activepieces/piece-airtable";
import { asana } from "@activepieces/piece-asana";
import { azureBlobStorage } from "@activepieces/piece-azure-blob-storage";
import { azureOpenai } from "@activepieces/piece-azure-openai";
import { bitly } from "@activepieces/piece-bitly";
import { browseAi } from "@activepieces/piece-browse-ai";
import { browserless } from "@activepieces/piece-browserless";
import { claude } from "@activepieces/piece-claude";
import { clickup } from "@activepieces/piece-clickup";
import { contextualAi } from "@activepieces/piece-contextual-ai";
import { discord } from "@activepieces/piece-discord";
import { dropbox } from "@activepieces/piece-dropbox";
import { gmail } from "@activepieces/piece-gmail";
import { googleCalendar } from "@activepieces/piece-google-calendar";
import { googleDocs } from "@activepieces/piece-google-docs";
import { googleDrive } from "@activepieces/piece-google-drive";
import { googleSheets } from "@activepieces/piece-google-sheets";
import { hubspot } from "@activepieces/piece-hubspot";
import { huggingface } from "@activepieces/piece-hugging-face";
import { jiraCloud } from "@activepieces/piece-jira-cloud";
import { linear } from "@activepieces/piece-linear";
import { linkedin } from "@activepieces/piece-linkedin";
import { mailchimp } from "@activepieces/piece-mailchimp";
import { microsoftExcel } from "@activepieces/piece-microsoft-excel-365";
import { microsoftOneDrive } from "@activepieces/piece-microsoft-onedrive";
import { microsoftOnenote } from "@activepieces/piece-microsoft-onenote";
import { microsoftOutlook } from "@activepieces/piece-microsoft-outlook";
import { microsoftTeams } from "@activepieces/piece-microsoft-teams";
import { microsoftTodo } from "@activepieces/piece-microsoft-todo";
import { monday } from "@activepieces/piece-monday";
import { nocodb } from "@activepieces/piece-nocodb";
import { notion } from "@activepieces/piece-notion";
import { openai } from "@activepieces/piece-openai";
import { perplexityAi } from "@activepieces/piece-perplexity-ai";
import { postgres } from "@activepieces/piece-postgres";
import { resend } from "@activepieces/piece-resend";
import { salesforce } from "@activepieces/piece-salesforce";
import { sendgrid } from "@activepieces/piece-sendgrid";
import { shopify } from "@activepieces/piece-shopify";
import { telegramBot } from "@activepieces/piece-telegram-bot";
import { todoist } from "@activepieces/piece-todoist";
import { trello } from "@activepieces/piece-trello";
import { youtube } from "@activepieces/piece-youtube";
import { zendesk } from "@activepieces/piece-zendesk";
import type { Piece } from "@activepieces/pieces-framework";

/**
 * Map of piece name (normalized, without @activepieces/piece- prefix) to Piece instance.
 */
export const PIECES: Record<string, Piece> = {
	"google-sheets": googleSheets as unknown as Piece,
	"google-calendar": googleCalendar as unknown as Piece,
	"google-docs": googleDocs as unknown as Piece,
	gmail: gmail as unknown as Piece,
	"google-drive": googleDrive as unknown as Piece,
	notion: notion as unknown as Piece,
	airtable: airtable as unknown as Piece,
	discord: discord as unknown as Piece,
	"microsoft-teams": microsoftTeams as unknown as Piece,
	"microsoft-outlook": microsoftOutlook as unknown as Piece,
	"microsoft-excel-365": microsoftExcel as unknown as Piece,
	"microsoft-todo": microsoftTodo as unknown as Piece,
	"microsoft-onedrive": microsoftOneDrive as unknown as Piece,
	"microsoft-onenote": microsoftOnenote as unknown as Piece,
	"jira-cloud": jiraCloud as unknown as Piece,
	asana: asana as unknown as Piece,
	trello: trello as unknown as Piece,
	clickup: clickup as unknown as Piece,
	todoist: todoist as unknown as Piece,
	monday: monday as unknown as Piece,
	hubspot: hubspot as unknown as Piece,
	salesforce: salesforce as unknown as Piece,
	mailchimp: mailchimp as unknown as Piece,
	shopify: shopify as unknown as Piece,
	zendesk: zendesk as unknown as Piece,
	sendgrid: sendgrid as unknown as Piece,
	dropbox: dropbox as unknown as Piece,
	"telegram-bot": telegramBot as unknown as Piece,
	openai: openai as unknown as Piece,
	claude: claude as unknown as Piece,
	"azure-openai": azureOpenai as unknown as Piece,
	"hugging-face": huggingface as unknown as Piece,
	"perplexity-ai": perplexityAi as unknown as Piece,
	"contextual-ai": contextualAi as unknown as Piece,
	linear: linear as unknown as Piece,
	postgres: postgres as unknown as Piece,
	nocodb: nocodb as unknown as Piece,
	browserless: browserless as unknown as Piece,
	"browse-ai": browseAi as unknown as Piece,
	bitly: bitly as unknown as Piece,
	"azure-blob-storage": azureBlobStorage as unknown as Piece,
	resend: resend as unknown as Piece,
	linkedin: linkedin as unknown as Piece,
	youtube: youtube as unknown as Piece,
};

function normalizePieceName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, "")
		.replace(/[_\s]+/g, "-")
		.replace(/-+/g, "-");
}

/**
 * Get a piece by normalized name.
 */
export function getPiece(name: string): Piece | undefined {
	return PIECES[normalizePieceName(name)];
}

/**
 * List all registered piece names.
 */
export function listPieceNames(): string[] {
	return Object.keys(PIECES);
}
