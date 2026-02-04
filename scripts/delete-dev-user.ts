import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

async function deleteDevUser() {
  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    await db.execute(sql`DELETE FROM accounts WHERE id = 'dev-admin-account'`);
    await db.execute(sql`DELETE FROM users WHERE id = 'dev-admin-user'`);
    console.log("✅ Deleted dev user");
  } finally {
    await queryClient.end();
  }
}

deleteDevUser();
