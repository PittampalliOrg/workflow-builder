import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  agents,
  apiKeys,
  appConnections,
  mcpRuns,
  mcpServers,
  pieceMetadata,
  platformOauthApps,
  platforms,
  projectMembers,
  projects,
  signingKeys,
  userIdentities,
  users,
  workflowConnectionRefs,
  workflowExecutionLogs,
  workflowExecutions,
  workflowExecutionsRelations,
  workflows,
} from "./schema";

// Construct schema object for drizzle
const schema = {
  users,
  platforms,
  platformOauthApps,
  signingKeys,
  userIdentities,
  projects,
  projectMembers,
  workflows,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionsRelations,
  mcpServers,
  mcpRuns,
  apiKeys,
  pieceMetadata,
  appConnections,
  workflowConnectionRefs,
  agents,
};

const envUrl = process.env.DATABASE_URL;
const isProd = process.env.NODE_ENV === "production";
const isNextBuild = process.env.NEXT_PHASE === "phase-production-build";

let connectionString = envUrl;
if (!connectionString) {
  if (isProd && !isNextBuild) {
    throw new Error("DATABASE_URL is required in production runtime");
  }
  // Dev + Next build: safe fallback to keep module evaluation from crashing.
  connectionString = "postgres://localhost:5432/workflow";
}

// For migrations
export const migrationClient = postgres(connectionString, { max: 1 });

// Use global singleton to prevent connection exhaustion during HMR
const globalForDb = globalThis as unknown as {
  queryClient: ReturnType<typeof postgres> | undefined;
  db: PostgresJsDatabase<typeof schema> | undefined;
};

// For queries - reuse connection in development
const queryClient =
  globalForDb.queryClient ?? postgres(connectionString, { max: 10 });
export const db = globalForDb.db ?? drizzle(queryClient, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.queryClient = queryClient;
  globalForDb.db = db;
}
