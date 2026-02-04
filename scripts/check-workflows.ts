import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

async function checkWorkflows() {
  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    const result = await db.execute(sql`SELECT id, name, nodes FROM workflows ORDER BY created_at DESC LIMIT 5`);

    for (const row of result as any[]) {
      console.log("---");
      console.log("Workflow:", row.name, "(", row.id, ")");
      const nodes = row.nodes as any[];
      for (const node of nodes) {
        if (node.data?.type === "action") {
          console.log("  Action node:", node.id);
          console.log("    actionType:", node.data?.config?.actionType);
          console.log("    functionSlug:", node.data?.config?.functionSlug);
        }
      }
    }
  } finally {
    await queryClient.end();
  }
}

checkWorkflows();
