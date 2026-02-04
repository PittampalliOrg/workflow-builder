/**
 * Migrate Workflow Nodes Script
 *
 * This script migrates existing workflows to use the new functionSlug field.
 * It normalizes actionType values to canonical function slugs.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-workflow-nodes.ts
 *   pnpm tsx scripts/migrate-workflow-nodes.ts --dry-run
 *
 * The script:
 * 1. Queries all workflows from the database
 * 2. For each action node, normalizes actionType to functionSlug
 * 3. Uses mapping rules for legacy action names
 * 4. Updates workflows in place (unless --dry-run is specified)
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";

// Import the legacy mappings
import { LEGACY_ACTION_MAPPINGS } from "../plugins/legacy-mappings.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * System action mappings
 * Maps system action IDs to their canonical function slugs
 */
const SYSTEM_ACTION_MAPPINGS: Record<string, string> = {
  "HTTP Request": "system/http-request",
  "Database Query": "system/database-query",
  Condition: "system/condition",
};

/**
 * Normalize an action type to a function slug
 *
 * Priority:
 * 1. Already a valid slug format (contains /)
 * 2. System action mapping
 * 3. Legacy action mapping
 * 4. Fuzzy match (lowercase, normalize separators)
 */
function normalizeToSlug(actionType: string): string | null {
  if (!actionType) return null;

  // Already a slug format (e.g., "openai/generate-text")
  if (actionType.includes("/")) {
    // Check if it's a legacy ai-gateway mapping
    if (LEGACY_ACTION_MAPPINGS[actionType]) {
      return LEGACY_ACTION_MAPPINGS[actionType];
    }
    return actionType;
  }

  // Check system actions
  if (SYSTEM_ACTION_MAPPINGS[actionType]) {
    return SYSTEM_ACTION_MAPPINGS[actionType];
  }

  // Check legacy mappings
  if (LEGACY_ACTION_MAPPINGS[actionType]) {
    return LEGACY_ACTION_MAPPINGS[actionType];
  }

  // Try fuzzy matching common patterns
  const normalized = actionType.toLowerCase().replace(/[_\s]+/g, "-");

  // Common patterns to try
  const patterns: Record<string, string> = {
    "generate-text": "openai/generate-text",
    "generate-image": "openai/generate-image",
    "send-email": "resend/send-email",
    "send-slack-message": "slack/send-message",
    "send-message": "slack/send-message",
    "create-ticket": "linear/create-ticket",
    "find-issues": "linear/find-issues",
    scrape: "firecrawl/scrape",
    search: "firecrawl/search",
    "http-request": "system/http-request",
    "database-query": "system/database-query",
    condition: "system/condition",
  };

  if (patterns[normalized]) {
    return patterns[normalized];
  }

  // Could not normalize - return null
  console.warn(`  ⚠ Could not normalize: "${actionType}"`);
  return null;
}

interface WorkflowNode {
  id: string;
  data: {
    type?: string;
    label?: string;
    config?: Record<string, unknown>;
  };
}

interface WorkflowRow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
}

/**
 * Migrate a single workflow's nodes
 */
function migrateWorkflowNodes(
  nodes: WorkflowNode[]
): { nodes: WorkflowNode[]; changes: number } {
  let changes = 0;

  const migratedNodes = nodes.map((node) => {
    // Handle both 'action' and 'activity' node types
    if (node.data?.type !== "action" && node.data?.type !== "activity") {
      return node;
    }

    const config = node.data.config || {};
    // Check activityName (for activity nodes) and actionType (for action nodes)
    const actionType = (config.activityName || config.actionType || node.data.label) as string | undefined;
    const existingSlug = config.functionSlug as string | undefined;

    // Skip if functionSlug already exists
    if (existingSlug) {
      return node;
    }

    // Skip if no actionType/activityName
    if (!actionType) {
      return node;
    }

    // Normalize to slug
    const functionSlug = normalizeToSlug(actionType);
    if (!functionSlug) {
      return node;
    }

    // Add functionSlug to config
    changes++;
    return {
      ...node,
      data: {
        ...node.data,
        config: {
          ...config,
          functionSlug,
        },
      },
    };
  });

  return { nodes: migratedNodes, changes };
}

/**
 * Main migration function
 */
async function migrateWorkflows() {
  console.log("🔄 Migrating workflow nodes to use functionSlug...\n");

  if (DRY_RUN) {
    console.log("📝 DRY RUN MODE - No changes will be saved\n");
  }

  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    // Get all workflows
    const workflows = (await db.execute(sql`
      SELECT id, name, nodes
      FROM workflows
      ORDER BY created_at ASC
    `)) as unknown as WorkflowRow[];

    console.log(`Found ${workflows.length} workflows to check\n`);

    let totalMigrated = 0;
    let totalChanges = 0;
    let skipped = 0;

    for (const workflow of workflows) {
      const nodes = workflow.nodes as WorkflowNode[];

      if (!Array.isArray(nodes) || nodes.length === 0) {
        skipped++;
        continue;
      }

      const { nodes: migratedNodes, changes } = migrateWorkflowNodes(nodes);

      if (changes === 0) {
        skipped++;
        continue;
      }

      totalMigrated++;
      totalChanges += changes;

      console.log(`📦 ${workflow.name} (${workflow.id})`);
      console.log(`   ${changes} node(s) to update`);

      // Log the changes
      for (const node of migratedNodes) {
        if (node.data?.type === "action" && node.data.config?.functionSlug) {
          const config = node.data.config;
          if (
            config.actionType &&
            config.functionSlug !== config.actionType
          ) {
            console.log(
              `   - "${config.actionType}" → "${config.functionSlug}"`
            );
          }
        }
      }

      if (!DRY_RUN) {
        // Update the workflow
        await db.execute(sql`
          UPDATE workflows
          SET nodes = ${JSON.stringify(migratedNodes)}::jsonb,
              updated_at = NOW()
          WHERE id = ${workflow.id}
        `);
        console.log("   ✓ Updated");
      }

      console.log("");
    }

    console.log("─".repeat(50));
    console.log("\n✅ Migration complete!");
    console.log(`   Workflows migrated: ${totalMigrated}`);
    console.log(`   Total nodes updated: ${totalChanges}`);
    console.log(`   Workflows skipped: ${skipped}`);

    if (DRY_RUN) {
      console.log("\n📝 This was a dry run. Run without --dry-run to apply changes.");
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  } finally {
    await queryClient.end();
  }
}

// Run the migration
migrateWorkflows();
