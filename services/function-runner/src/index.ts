/**
 * Function Runner Service
 *
 * A Node.js/TypeScript microservice that executes functions for Dapr workflows.
 * Supports three execution types:
 * - builtin: Statically compiled TypeScript handlers
 * - oci: Container images executed as Kubernetes Jobs
 * - http: External HTTP webhooks
 *
 * This service replaces the activity-executor for more flexible function execution
 * with support for dynamic function registration.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { healthRoutes, setReady } from "./routes/health.js";
import { executeRoutes } from "./routes/execute.js";
import { closeDb } from "./core/db.js";

// Initialize plugins by importing the index (which registers all plugins)
import "@/plugins/index.js";

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

async function main() {
  console.log("[Function Runner] Starting service...");
  console.log("[Function Runner] Configuration:", {
    port: PORT,
    host: HOST,
    logLevel: LOG_LEVEL,
    k8sNamespace: process.env.K8S_NAMESPACE || "workflow-builder",
    daprHost: process.env.DAPR_HOST || "localhost",
    daprPort: process.env.DAPR_HTTP_PORT || "3500",
  });

  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport:
        process.env.NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: {
                translateTime: "HH:MM:ss Z",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
  });

  // Enable CORS
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
  });

  // Register routes
  await app.register(healthRoutes);
  await app.register(executeRoutes);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Function Runner] Shutting down...");
    await app.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start server
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[Function Runner] Server listening on http://${HOST}:${PORT}`);
    console.log("[Function Runner] Ready to execute functions");
    setReady(true);
  } catch (error) {
    console.error("[Function Runner] Failed to start server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[Function Runner] Unhandled error:", error);
  process.exit(1);
});
