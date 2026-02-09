import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { users, userIdentities } from "../lib/db/schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

async function updateDevEmail() {
  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    await db.update(users).set({ email: "admin@example.com" }).where(eq(users.id, "dev-admin-user"));
    await db.update(userIdentities).set({ email: "admin@example.com" }).where(eq(userIdentities.email, "admin@localhost"));
    console.log("Updated email to admin@example.com");
  } finally {
    await queryClient.end();
  }
}

updateDevEmail();
