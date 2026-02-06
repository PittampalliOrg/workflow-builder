/**
 * Standalone Database Connection
 *
 * This module provides a database connection for the function-router service
 * without depending on Next.js or "server-only" imports.
 *
 * Uses drizzle without schema to avoid type conflicts in monorepo.
 * Raw SQL queries are used for execution logging.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

// Use singleton pattern for connection pooling
let queryClient: ReturnType<typeof postgres> | undefined;
let db: PostgresJsDatabase | undefined;

export function getDb(): PostgresJsDatabase {
  if (!db) {
    queryClient = postgres(connectionString, { max: 10 });
    db = drizzle(queryClient);
  }
  return db;
}

/**
 * Get raw SQL client for direct queries (e.g., health checks)
 */
export function getSql(): ReturnType<typeof postgres> {
  if (!queryClient) {
    queryClient = postgres(connectionString, { max: 10 });
    db = drizzle(queryClient);
  }
  return queryClient;
}

export async function closeDb(): Promise<void> {
  if (queryClient) {
    await queryClient.end();
    queryClient = undefined;
    db = undefined;
  }
}
