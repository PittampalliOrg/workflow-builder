import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/workflow";
const WORKFLOW_ID = process.argv[2] || "3hoeloryk2wtx2so3taxj";

async function checkWorkflow() {
  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    const result = await db.execute(sql`SELECT id, name, nodes FROM workflows WHERE id = ${WORKFLOW_ID}`);

    for (const row of result as any[]) {
      console.log("Workflow:", row.name, "(", row.id, ")");
      console.log("Nodes:", JSON.stringify(row.nodes, null, 2));
    }
  } finally {
    await queryClient.end();
  }
}

checkWorkflow();
