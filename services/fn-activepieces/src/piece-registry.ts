/**
 * Piece Registry
 *
 * Static imports of all 26 AP piece packages.
 * Each piece exports a Piece object with getAction(name) method.
 */
import type { Piece } from '@activepieces/pieces-framework';

// Google Suite
import { googleSheets } from '@activepieces/piece-google-sheets';
import { googleCalendar } from '@activepieces/piece-google-calendar';
import { googleDocs } from '@activepieces/piece-google-docs';
import { gmail } from '@activepieces/piece-gmail';
import { googleDrive } from '@activepieces/piece-google-drive';

// Productivity
import { notion } from '@activepieces/piece-notion';
import { airtable } from '@activepieces/piece-airtable';
import { todoist } from '@activepieces/piece-todoist';
import { monday } from '@activepieces/piece-monday';

// Communication
import { discord } from '@activepieces/piece-discord';
import { microsoftTeams } from '@activepieces/piece-microsoft-teams';
import { telegramBot } from '@activepieces/piece-telegram-bot';

// Microsoft Office
import { microsoftOutlook } from '@activepieces/piece-microsoft-outlook';
import { microsoftExcel365 } from '@activepieces/piece-microsoft-excel-365';
import { microsoftTodo } from '@activepieces/piece-microsoft-todo';

// Project Management
import { jiraCloud } from '@activepieces/piece-jira-cloud';
import { asana } from '@activepieces/piece-asana';
import { trello } from '@activepieces/piece-trello';
import { clickup } from '@activepieces/piece-clickup';

// CRM & Marketing
import { hubspot } from '@activepieces/piece-hubspot';
import { salesforce } from '@activepieces/piece-salesforce';
import { mailchimp } from '@activepieces/piece-mailchimp';

// E-commerce & Support
import { shopify } from '@activepieces/piece-shopify';
import { zendesk } from '@activepieces/piece-zendesk';

// Email
import { sendgrid } from '@activepieces/piece-sendgrid';

// Storage
import { dropbox } from '@activepieces/piece-dropbox';

/**
 * Map of piece name (normalized, without @activepieces/piece- prefix) to Piece instance.
 */
export const PIECES: Record<string, Piece> = {
  'google-sheets': googleSheets as unknown as Piece,
  'google-calendar': googleCalendar as unknown as Piece,
  'google-docs': googleDocs as unknown as Piece,
  'gmail': gmail as unknown as Piece,
  'google-drive': googleDrive as unknown as Piece,
  'notion': notion as unknown as Piece,
  'airtable': airtable as unknown as Piece,
  'discord': discord as unknown as Piece,
  'microsoft-teams': microsoftTeams as unknown as Piece,
  'microsoft-outlook': microsoftOutlook as unknown as Piece,
  'microsoft-excel-365': microsoftExcel365 as unknown as Piece,
  'microsoft-todo': microsoftTodo as unknown as Piece,
  'jira-cloud': jiraCloud as unknown as Piece,
  'asana': asana as unknown as Piece,
  'trello': trello as unknown as Piece,
  'clickup': clickup as unknown as Piece,
  'todoist': todoist as unknown as Piece,
  'monday': monday as unknown as Piece,
  'hubspot': hubspot as unknown as Piece,
  'salesforce': salesforce as unknown as Piece,
  'mailchimp': mailchimp as unknown as Piece,
  'shopify': shopify as unknown as Piece,
  'zendesk': zendesk as unknown as Piece,
  'sendgrid': sendgrid as unknown as Piece,
  'dropbox': dropbox as unknown as Piece,
  'telegram-bot': telegramBot as unknown as Piece,
};

/**
 * Get a piece by normalized name.
 */
export function getPiece(name: string): Piece | undefined {
  return PIECES[name];
}

/**
 * List all registered piece names.
 */
export function listPieceNames(): string[] {
  return Object.keys(PIECES);
}
