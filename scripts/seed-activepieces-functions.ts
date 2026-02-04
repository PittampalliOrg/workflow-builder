/**
 * Seed ActivePieces Functions Script
 *
 * Discovers ActivePieces pieces from the AP API and seeds them to the functions table
 * as HTTP execution type. This enables using AP pieces as actions in workflows.
 *
 * Usage:
 *   pnpm tsx scripts/seed-activepieces-functions.ts
 *   pnpm tsx scripts/seed-activepieces-functions.ts --pieces=slack,github,notion
 *   pnpm tsx scripts/seed-activepieces-functions.ts --all
 *
 * Environment variables:
 *   ACTIVEPIECES_URL - Base URL of ActivePieces instance
 *   ACTIVEPIECES_API_KEY - API key for authentication (optional)
 *   DATABASE_URL - PostgreSQL connection string
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { customAlphabet } from "nanoid";
import {
  ActivePiecesClient,
  generatePieceWebhookUrl,
} from "../lib/activepieces/client.js";
import type { PieceSummary } from "../lib/activepieces/types.js";
import {
  POPULAR_PIECES,
  pieceActionToJsonSchema,
  type PieceMetadata,
  type PieceAction,
} from "../lib/activepieces/types.js";
import { getPieceIntegrationType } from "../lib/activepieces/credential-mapper.js";

// Generate IDs matching the schema's generateId function
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 21);

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow";
const ACTIVEPIECES_URL =
  process.env.ACTIVEPIECES_URL || "https://activepieces.cnoe.localtest.me:8443";

/**
 * Parse command line arguments
 */
function parseArgs(): { pieces: string[]; all: boolean } {
  const args = process.argv.slice(2);
  let pieces: string[] = [];
  let all = false;

  for (const arg of args) {
    if (arg === "--all") {
      all = true;
    } else if (arg.startsWith("--pieces=")) {
      pieces = arg.substring(9).split(",").map((p) => p.trim());
    }
  }

  // Default to popular pieces if no specific pieces requested
  if (!all && pieces.length === 0) {
    pieces = [...POPULAR_PIECES];
  }

  return { pieces, all };
}

/**
 * Extract short name from full package name
 * e.g., "@activepieces/piece-slack" -> "slack"
 */
function extractShortName(fullName: string): string {
  const match = fullName.match(/@activepieces\/piece-(.+)/);
  return match ? match[1] : fullName;
}

/**
 * Create a function slug for an AP action
 * Format: ap-{shortPieceName}/{actionName}
 */
function createFunctionSlug(pieceName: string, actionName: string): string {
  const shortName = extractShortName(pieceName);
  return `ap-${shortName}/${actionName}`;
}

/**
 * Create a function record from an AP piece action
 */
function createFunctionRecord(
  piece: PieceMetadata,
  actionName: string,
  action: PieceAction
): {
  slug: string;
  name: string;
  description: string;
  pluginId: string;
  version: string;
  executionType: string;
  webhookUrl: string;
  webhookMethod: string;
  webhookTimeoutSeconds: number;
  inputSchema: Record<string, unknown>;
  integrationType: string | null;
  isBuiltin: boolean;
} {
  const shortName = extractShortName(piece.name);
  const slug = createFunctionSlug(piece.name, actionName);
  const integrationType = getPieceIntegrationType(shortName);

  return {
    slug,
    name: action.displayName,
    description: action.description || `${action.displayName} via ActivePieces`,
    pluginId: `activepieces-${shortName}`,
    version: piece.version,
    executionType: "http",
    // Use full package name for the webhook URL - client will handle encoding
    webhookUrl: generatePieceWebhookUrl(ACTIVEPIECES_URL, piece.name, actionName),
    webhookMethod: "POST",
    webhookTimeoutSeconds: 60,
    inputSchema: pieceActionToJsonSchema(action),
    integrationType: integrationType || null,
    isBuiltin: false,
  };
}

/**
 * Main seed function
 */
async function seedActivePiecesFunctions() {
  const { pieces: requestedPieces, all } = parseArgs();

  console.log("🧩 Seeding ActivePieces functions...\n");
  console.log(`   ActivePieces URL: ${ACTIVEPIECES_URL}`);
  console.log(`   Database URL: ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}\n`);

  const client = new ActivePiecesClient({ baseUrl: ACTIVEPIECES_URL });
  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    // Check if ActivePieces is reachable
    console.log("📡 Checking ActivePieces connection...");
    const isHealthy = await client.healthCheck();

    if (!isHealthy) {
      console.warn("⚠️  ActivePieces is not reachable. Using mock data for popular pieces.\n");
      // Fall back to seeding with mock metadata if AP is not available
      await seedMockPieces(db, requestedPieces);
      return;
    }

    console.log("✓ ActivePieces is reachable\n");

    // Get list of pieces to seed
    let piecesToSeed: string[];

    if (all) {
      console.log("📋 Fetching all available pieces...");
      const allPieces = await client.listPieces();
      piecesToSeed = allPieces.map((p) => p.name);
      console.log(`   Found ${piecesToSeed.length} pieces\n`);
    } else {
      piecesToSeed = requestedPieces;
      console.log(`📋 Seeding ${piecesToSeed.length} requested pieces\n`);
    }

    // Track stats
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const pieceName of piecesToSeed) {
      try {
        console.log(`\n[${pieceName}] Fetching piece metadata...`);
        const piece = await client.getPieceMetadata(pieceName);

        if (!piece.actions || Object.keys(piece.actions).length === 0) {
          console.log(`   ⊘ No actions found, skipping`);
          skipped++;
          continue;
        }

        console.log(`   Found ${Object.keys(piece.actions).length} actions`);

        for (const [actionName, action] of Object.entries(piece.actions)) {
          const record = createFunctionRecord(piece, actionName, action);

          // Check if function already exists
          const existing = await db.execute<{ id: string }>(sql`
            SELECT id FROM functions WHERE slug = ${record.slug}
          `);

          if (existing.length > 0) {
            // Update existing record
            await db.execute(sql`
              UPDATE functions
              SET
                name = ${record.name},
                description = ${record.description},
                plugin_id = ${record.pluginId},
                version = ${record.version},
                execution_type = ${record.executionType},
                webhook_url = ${record.webhookUrl},
                webhook_method = ${record.webhookMethod},
                webhook_timeout_seconds = ${record.webhookTimeoutSeconds},
                input_schema = ${JSON.stringify(record.inputSchema)}::jsonb,
                integration_type = ${record.integrationType},
                is_builtin = ${record.isBuiltin},
                is_enabled = true,
                updated_at = NOW()
              WHERE slug = ${record.slug}
            `);
            updated++;
            console.log(`   ✓ Updated: ${record.slug}`);
          } else {
            // Insert new record
            const newId = nanoid();
            await db.execute(sql`
              INSERT INTO functions (
                id, name, slug, description, plugin_id, version,
                execution_type, webhook_url, webhook_method, webhook_timeout_seconds,
                input_schema, integration_type, is_builtin, is_enabled,
                created_at, updated_at
              ) VALUES (
                ${newId},
                ${record.name},
                ${record.slug},
                ${record.description},
                ${record.pluginId},
                ${record.version},
                ${record.executionType},
                ${record.webhookUrl},
                ${record.webhookMethod},
                ${record.webhookTimeoutSeconds},
                ${JSON.stringify(record.inputSchema)}::jsonb,
                ${record.integrationType},
                ${record.isBuiltin},
                true,
                NOW(),
                NOW()
              )
            `);
            inserted++;
            console.log(`   + Inserted: ${record.slug}`);
          }
        }
      } catch (error) {
        console.error(`   ✗ Error processing ${pieceName}:`, error);
        errors++;
      }
    }

    console.log("\n✅ Seed completed!");
    console.log(`   Inserted: ${inserted}`);
    console.log(`   Updated:  ${updated}`);
    console.log(`   Skipped:  ${skipped}`);
    console.log(`   Errors:   ${errors}`);
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  } finally {
    await queryClient.end();
  }
}

/**
 * Seed mock pieces when ActivePieces is not available
 * Uses predefined metadata for popular pieces
 */
async function seedMockPieces(
  db: ReturnType<typeof drizzle>,
  pieces: string[]
): Promise<void> {
  console.log("📋 Seeding mock pieces for offline development...\n");

  // Mock metadata for popular pieces
  const mockPieces: Record<string, { displayName: string; actions: Record<string, { displayName: string; description: string }> }> = {
    slack: {
      displayName: "Slack",
      actions: {
        send_message: { displayName: "Send Message", description: "Send a message to a Slack channel" },
        send_direct_message: { displayName: "Send Direct Message", description: "Send a direct message to a user" },
        create_channel: { displayName: "Create Channel", description: "Create a new Slack channel" },
        update_message: { displayName: "Update Message", description: "Update an existing message" },
      },
    },
    github: {
      displayName: "GitHub",
      actions: {
        create_issue: { displayName: "Create Issue", description: "Create a new issue in a repository" },
        create_pull_request: { displayName: "Create Pull Request", description: "Create a new pull request" },
        add_comment: { displayName: "Add Comment", description: "Add a comment to an issue or PR" },
        list_repos: { displayName: "List Repositories", description: "List repositories for the authenticated user" },
      },
    },
    notion: {
      displayName: "Notion",
      actions: {
        create_page: { displayName: "Create Page", description: "Create a new page in Notion" },
        update_page: { displayName: "Update Page", description: "Update an existing page" },
        append_block: { displayName: "Append Block", description: "Append content to a page" },
        query_database: { displayName: "Query Database", description: "Query a Notion database" },
      },
    },
    "google-sheets": {
      displayName: "Google Sheets",
      actions: {
        append_row: { displayName: "Append Row", description: "Append a row to a spreadsheet" },
        update_row: { displayName: "Update Row", description: "Update a row in a spreadsheet" },
        get_values: { displayName: "Get Values", description: "Get values from a range" },
        clear_sheet: { displayName: "Clear Sheet", description: "Clear a sheet" },
      },
    },
    gmail: {
      displayName: "Gmail",
      actions: {
        send_email: { displayName: "Send Email", description: "Send an email" },
        reply_to_email: { displayName: "Reply to Email", description: "Reply to an email thread" },
        get_email: { displayName: "Get Email", description: "Get email details" },
        search_emails: { displayName: "Search Emails", description: "Search for emails" },
      },
    },
    openai: {
      displayName: "OpenAI",
      actions: {
        chat_completion: { displayName: "Chat Completion", description: "Generate a chat completion" },
        text_to_speech: { displayName: "Text to Speech", description: "Convert text to speech" },
        create_image: { displayName: "Create Image", description: "Generate an image with DALL-E" },
        transcribe_audio: { displayName: "Transcribe Audio", description: "Transcribe audio with Whisper" },
      },
    },
    stripe: {
      displayName: "Stripe",
      actions: {
        create_customer: { displayName: "Create Customer", description: "Create a new customer" },
        create_invoice: { displayName: "Create Invoice", description: "Create a new invoice" },
        create_payment_link: { displayName: "Create Payment Link", description: "Create a payment link" },
        get_balance: { displayName: "Get Balance", description: "Get account balance" },
      },
    },
    hubspot: {
      displayName: "HubSpot",
      actions: {
        create_contact: { displayName: "Create Contact", description: "Create a new contact" },
        update_contact: { displayName: "Update Contact", description: "Update an existing contact" },
        create_deal: { displayName: "Create Deal", description: "Create a new deal" },
        add_note: { displayName: "Add Note", description: "Add a note to a record" },
      },
    },
  };

  let inserted = 0;
  let updated = 0;

  for (const pieceName of pieces) {
    const mockPiece = mockPieces[pieceName];
    if (!mockPiece) {
      console.log(`   ⊘ No mock data for ${pieceName}, skipping`);
      continue;
    }

    console.log(`[${pieceName}] ${mockPiece.displayName}`);

    for (const [actionName, action] of Object.entries(mockPiece.actions)) {
      const slug = createFunctionSlug(pieceName, actionName);
      const integrationType = getPieceIntegrationType(pieceName);

      // Simple input schema for mock
      const inputSchema = {
        type: "object",
        properties: {},
        description: `Input for ${action.displayName}`,
      };

      // Check if function already exists
      const existing = await db.execute<{ id: string }>(sql`
        SELECT id FROM functions WHERE slug = ${slug}
      `);

      if (existing.length > 0) {
        await db.execute(sql`
          UPDATE functions
          SET
            name = ${action.displayName},
            description = ${action.description},
            plugin_id = ${"activepieces-" + pieceName},
            version = '0.0.1',
            execution_type = 'http',
            webhook_url = ${generatePieceWebhookUrl(ACTIVEPIECES_URL, pieceName, actionName)},
            webhook_method = 'POST',
            webhook_timeout_seconds = 60,
            input_schema = ${JSON.stringify(inputSchema)}::jsonb,
            integration_type = ${integrationType || null},
            is_builtin = false,
            is_enabled = true,
            updated_at = NOW()
          WHERE slug = ${slug}
        `);
        updated++;
        console.log(`   ✓ Updated: ${slug}`);
      } else {
        const newId = nanoid();
        await db.execute(sql`
          INSERT INTO functions (
            id, name, slug, description, plugin_id, version,
            execution_type, webhook_url, webhook_method, webhook_timeout_seconds,
            input_schema, integration_type, is_builtin, is_enabled,
            created_at, updated_at
          ) VALUES (
            ${newId},
            ${action.displayName},
            ${slug},
            ${action.description},
            ${"activepieces-" + pieceName},
            '0.0.1',
            'http',
            ${generatePieceWebhookUrl(ACTIVEPIECES_URL, pieceName, actionName)},
            'POST',
            60,
            ${JSON.stringify(inputSchema)}::jsonb,
            ${integrationType || null},
            false,
            true,
            NOW(),
            NOW()
          )
        `);
        inserted++;
        console.log(`   + Inserted: ${slug}`);
      }
    }
  }

  console.log("\n✅ Mock seed completed!");
  console.log(`   Inserted: ${inserted}`);
  console.log(`   Updated:  ${updated}`);
}

// Run the seed
seedActivePiecesFunctions();
