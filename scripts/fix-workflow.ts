import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow";
const WORKFLOW_ID = process.argv[2] || "3hoeloryk2wtx2so3taxj";

// Activity name to function slug mapping
const ACTIVITY_MAPPINGS: Record<string, string> = {
  generate_text: "openai/generate-text",
  "generate-text": "openai/generate-text",
  generate_image: "openai/generate-image",
  "generate-image": "openai/generate-image",
  send_email: "resend/send-email",
  "send-email": "resend/send-email",
  send_message: "slack/send-message",
  "send-message": "slack/send-message",
  scrape: "firecrawl/scrape",
  search: "firecrawl/search",
};

async function fixWorkflow() {
  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    const result = await db.execute(
      sql`SELECT id, name, nodes FROM workflows WHERE id = ${WORKFLOW_ID}`
    );

    if (result.length === 0) {
      console.log("Workflow not found:", WORKFLOW_ID);
      return;
    }

    const row = result[0] as any;
    console.log("Fixing workflow:", row.name, "(", row.id, ")");

    let changed = false;
    const nodes = row.nodes as any[];

    for (const node of nodes) {
      // Handle both 'action' and 'activity' node types
      if (node.data?.type === "action" || node.data?.type === "activity") {
        const config = node.data.config || {};

        // Skip if functionSlug already set
        if (config.functionSlug) {
          console.log(
            `  Node ${node.id}: already has functionSlug = ${config.functionSlug}`
          );
          continue;
        }

        // Try to resolve from activityName or actionType
        const activityName =
          config.activityName || config.actionType || node.data.label;

        if (activityName) {
          // Check if it's already a slug format
          let functionSlug = activityName;

          if (!activityName.includes("/")) {
            // Try to map it
            functionSlug =
              ACTIVITY_MAPPINGS[activityName] ||
              ACTIVITY_MAPPINGS[activityName.toLowerCase()];

            if (!functionSlug) {
              console.log(
                `  Node ${node.id}: WARNING - no mapping for "${activityName}"`
              );
              continue;
            }
          }

          node.data.config = {
            ...config,
            functionSlug,
          };
          changed = true;
          console.log(
            `  Node ${node.id}: set functionSlug = ${functionSlug} (from ${activityName})`
          );
        }
      }
    }

    if (changed) {
      await db.execute(sql`
        UPDATE workflows
        SET nodes = ${JSON.stringify(nodes)}::jsonb, updated_at = NOW()
        WHERE id = ${WORKFLOW_ID}
      `);
      console.log("\n✅ Workflow updated!");
    } else {
      console.log("\nNo changes needed.");
    }
  } finally {
    await queryClient.end();
  }
}

fixWorkflow();
