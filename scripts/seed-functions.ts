/**
 * Seed Functions Script
 *
 * Seeds the functions table with all built-in functions from the plugin registry.
 * This allows the function-runner to load function definitions from the database.
 *
 * Usage:
 *   pnpm tsx scripts/seed-functions.ts
 *
 * This script:
 * 1. Loads all registered plugins
 * 2. For each action in each plugin, creates a function record
 * 3. Sets executionType to "builtin" and isBuiltin to true
 * 4. Extracts input/output schemas from configFields/outputFields
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { customAlphabet } from "nanoid";

// Import plugin index to register all plugins
import "../plugins/index.js";

// Generate IDs matching the schema's generateId function
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 21);

// Import registry functions
import {
  getAllActions,
  getAllIntegrations,
  flattenConfigFields,
  type ActionWithFullId,
  type IntegrationPlugin,
} from "../plugins/registry.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

/**
 * Convert plugin config fields to JSON Schema
 */
function configFieldsToJsonSchema(action: ActionWithFullId): Record<string, unknown> {
  const flatFields = flattenConfigFields(action.configFields);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of flatFields) {
    const prop: Record<string, unknown> = {};

    switch (field.type) {
      case "number":
        prop.type = "number";
        if (field.min !== undefined) prop.minimum = field.min;
        break;
      case "select":
        prop.type = "string";
        if (field.options) {
          prop.enum = field.options.map((o) => o.value);
        }
        break;
      case "schema-builder":
        prop.type = "string";
        prop.description = "JSON Schema definition as a string";
        break;
      default:
        prop.type = "string";
    }

    if (field.placeholder) prop.description = field.placeholder;
    if (field.defaultValue !== undefined) prop.default = field.defaultValue;

    properties[field.key] = prop;

    if (field.required) {
      required.push(field.key);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Convert plugin output fields to JSON Schema
 */
function outputFieldsToJsonSchema(action: ActionWithFullId): Record<string, unknown> | null {
  if (!action.outputFields || action.outputFields.length === 0) {
    return null;
  }

  const properties: Record<string, unknown> = {};

  for (const field of action.outputFields) {
    properties[field.field] = {
      type: "string",
      description: field.description,
    };
  }

  return {
    type: "object",
    properties,
  };
}

/**
 * Get integration type for credential lookup
 */
function getIntegrationType(action: ActionWithFullId): string {
  return action.integration;
}

/**
 * Main seed function
 */
async function seedFunctions() {
  console.log("🌱 Seeding functions table with built-in functions...\n");

  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    // Get all registered actions
    const actions = getAllActions();
    const integrations = getAllIntegrations();

    console.log(`Found ${actions.length} actions across ${integrations.length} integrations\n`);

    // Track stats
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const action of actions) {
      const slug = action.id; // e.g., "openai/generate-text"
      const pluginId = action.integration;

      // Build JSON schemas from config fields
      const inputSchema = configFieldsToJsonSchema(action);
      const outputSchema = outputFieldsToJsonSchema(action);

      // Check if function already exists
      const existing = await db.execute<{ id: string }>(sql`
        SELECT id FROM functions WHERE slug = ${slug}
      `);

      if (existing.length > 0) {
        // Update existing record
        await db.execute(sql`
          UPDATE functions
          SET
            name = ${action.label},
            description = ${action.description},
            plugin_id = ${pluginId},
            version = '1.0.0',
            execution_type = 'builtin',
            input_schema = ${JSON.stringify(inputSchema)}::jsonb,
            output_schema = ${outputSchema ? JSON.stringify(outputSchema) : null}::jsonb,
            timeout_seconds = 300,
            integration_type = ${getIntegrationType(action)},
            is_builtin = true,
            is_enabled = true,
            is_deprecated = false,
            updated_at = NOW()
          WHERE slug = ${slug}
        `);
        updated++;
        console.log(`  ✓ Updated: ${slug}`);
      } else {
        // Insert new record
        const newId = nanoid();
        await db.execute(sql`
          INSERT INTO functions (
            id, name, slug, description, plugin_id, version,
            execution_type, input_schema, output_schema,
            timeout_seconds, integration_type,
            is_builtin, is_enabled, is_deprecated,
            created_at, updated_at
          ) VALUES (
            ${newId},
            ${action.label},
            ${slug},
            ${action.description},
            ${pluginId},
            '1.0.0',
            'builtin',
            ${JSON.stringify(inputSchema)}::jsonb,
            ${outputSchema ? JSON.stringify(outputSchema) : null}::jsonb,
            300,
            ${getIntegrationType(action)},
            true,
            true,
            false,
            NOW(),
            NOW()
          )
        `);
        inserted++;
        console.log(`  + Inserted: ${slug}`);
      }
    }

    // Also add the system HTTP Request function
    const httpRequestSlug = "system/http-request";
    const httpExisting = await db.execute<{ id: string }>(sql`
      SELECT id FROM functions WHERE slug = ${httpRequestSlug}
    `);

    const httpInputSchema = {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to send the request to" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          default: "GET",
        },
        headers: { type: "string", description: "JSON object of headers" },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH)" },
      },
      required: ["url"],
    };

    const httpOutputSchema = {
      type: "object",
      properties: {
        success: { type: "boolean" },
        data: { type: "object", description: "Response data" },
        status: { type: "number", description: "HTTP status code" },
        error: { type: "string", description: "Error message if failed" },
      },
    };

    if (httpExisting.length > 0) {
      await db.execute(sql`
        UPDATE functions
        SET
          name = 'HTTP Request',
          description = 'Make an HTTP request to any URL',
          plugin_id = 'system',
          version = '1.0.0',
          execution_type = 'builtin',
          input_schema = ${JSON.stringify(httpInputSchema)}::jsonb,
          output_schema = ${JSON.stringify(httpOutputSchema)}::jsonb,
          timeout_seconds = 60,
          integration_type = null,
          is_builtin = true,
          is_enabled = true,
          is_deprecated = false,
          updated_at = NOW()
        WHERE slug = ${httpRequestSlug}
      `);
      updated++;
      console.log(`  ✓ Updated: ${httpRequestSlug}`);
    } else {
      const httpId = nanoid();
      await db.execute(sql`
        INSERT INTO functions (
          id, name, slug, description, plugin_id, version,
          execution_type, input_schema, output_schema,
          timeout_seconds, integration_type,
          is_builtin, is_enabled, is_deprecated,
          created_at, updated_at
        ) VALUES (
          ${httpId},
          'HTTP Request',
          ${httpRequestSlug},
          'Make an HTTP request to any URL',
          'system',
          '1.0.0',
          'builtin',
          ${JSON.stringify(httpInputSchema)}::jsonb,
          ${JSON.stringify(httpOutputSchema)}::jsonb,
          60,
          null,
          true,
          true,
          false,
          NOW(),
          NOW()
        )
      `);
      inserted++;
      console.log(`  + Inserted: ${httpRequestSlug}`);
    }

    // Add system/database-query function
    const dbQuerySlug = "system/database-query";
    const dbQueryExisting = await db.execute<{ id: string }>(sql`
      SELECT id FROM functions WHERE slug = ${dbQuerySlug}
    `);

    const dbQueryInputSchema = {
      type: "object",
      properties: {
        dbQuery: { type: "string", description: "SQL query to execute" },
        dbSchema: { type: "string", description: "JSON Schema for typed results (optional)" },
      },
      required: ["dbQuery"],
    };

    const dbQueryOutputSchema = {
      type: "object",
      properties: {
        success: { type: "boolean" },
        rows: { type: "array", description: "Query result rows" },
        rowCount: { type: "number", description: "Number of rows returned" },
        error: { type: "string", description: "Error message if failed" },
      },
    };

    if (dbQueryExisting.length > 0) {
      await db.execute(sql`
        UPDATE functions
        SET
          name = 'Database Query',
          description = 'Execute a SQL query against the database',
          plugin_id = 'system',
          version = '1.0.0',
          execution_type = 'builtin',
          input_schema = ${JSON.stringify(dbQueryInputSchema)}::jsonb,
          output_schema = ${JSON.stringify(dbQueryOutputSchema)}::jsonb,
          timeout_seconds = 60,
          integration_type = 'database',
          is_builtin = true,
          is_enabled = true,
          is_deprecated = false,
          updated_at = NOW()
        WHERE slug = ${dbQuerySlug}
      `);
      updated++;
      console.log(`  ✓ Updated: ${dbQuerySlug}`);
    } else {
      const dbQueryId = nanoid();
      await db.execute(sql`
        INSERT INTO functions (
          id, name, slug, description, plugin_id, version,
          execution_type, input_schema, output_schema,
          timeout_seconds, integration_type,
          is_builtin, is_enabled, is_deprecated,
          created_at, updated_at
        ) VALUES (
          ${dbQueryId},
          'Database Query',
          ${dbQuerySlug},
          'Execute a SQL query against the database',
          'system',
          '1.0.0',
          'builtin',
          ${JSON.stringify(dbQueryInputSchema)}::jsonb,
          ${JSON.stringify(dbQueryOutputSchema)}::jsonb,
          60,
          'database',
          true,
          true,
          false,
          NOW(),
          NOW()
        )
      `);
      inserted++;
      console.log(`  + Inserted: ${dbQuerySlug}`);
    }

    // Add system/condition function
    const conditionSlug = "system/condition";
    const conditionExisting = await db.execute<{ id: string }>(sql`
      SELECT id FROM functions WHERE slug = ${conditionSlug}
    `);

    const conditionInputSchema = {
      type: "object",
      properties: {
        condition: { type: "string", description: "JavaScript expression that evaluates to boolean" },
      },
      required: ["condition"],
    };

    const conditionOutputSchema = {
      type: "object",
      properties: {
        result: { type: "boolean", description: "Result of condition evaluation" },
        expression: { type: "string", description: "The evaluated expression" },
      },
    };

    if (conditionExisting.length > 0) {
      await db.execute(sql`
        UPDATE functions
        SET
          name = 'Condition',
          description = 'Evaluate a conditional expression',
          plugin_id = 'system',
          version = '1.0.0',
          execution_type = 'builtin',
          input_schema = ${JSON.stringify(conditionInputSchema)}::jsonb,
          output_schema = ${JSON.stringify(conditionOutputSchema)}::jsonb,
          timeout_seconds = 10,
          integration_type = null,
          is_builtin = true,
          is_enabled = true,
          is_deprecated = false,
          updated_at = NOW()
        WHERE slug = ${conditionSlug}
      `);
      updated++;
      console.log(`  ✓ Updated: ${conditionSlug}`);
    } else {
      const conditionId = nanoid();
      await db.execute(sql`
        INSERT INTO functions (
          id, name, slug, description, plugin_id, version,
          execution_type, input_schema, output_schema,
          timeout_seconds, integration_type,
          is_builtin, is_enabled, is_deprecated,
          created_at, updated_at
        ) VALUES (
          ${conditionId},
          'Condition',
          ${conditionSlug},
          'Evaluate a conditional expression',
          'system',
          '1.0.0',
          'builtin',
          ${JSON.stringify(conditionInputSchema)}::jsonb,
          ${JSON.stringify(conditionOutputSchema)}::jsonb,
          10,
          null,
          true,
          true,
          false,
          NOW(),
          NOW()
        )
      `);
      inserted++;
      console.log(`  + Inserted: ${conditionSlug}`);
    }

    console.log("\n✅ Seed completed!");
    console.log(`   Inserted: ${inserted}`);
    console.log(`   Updated:  ${updated}`);
    console.log(`   Skipped:  ${skipped}`);
    console.log(`   Total:    ${inserted + updated + skipped}`);
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  } finally {
    await queryClient.end();
  }
}

// Run the seed
seedFunctions();
