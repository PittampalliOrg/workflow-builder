/**
 * Activity Executor Service
 *
 * A Node.js/TypeScript microservice that enables Dapr workflows to execute
 * all 35+ existing plugin step handlers. Runs in Kubernetes with a Dapr sidecar.
 *
 * Configuration is loaded from Dapr Configuration Store (Azure App Configuration).
 * Secrets are fetched from Dapr Secret Store (Azure Key Vault).
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { healthRoutes } from "./routes/health.js";
import { executeRoutes } from "./routes/execute.js";
import { closeDb } from "./core/db.js";
import { loadActivityExecutorConfig, type ActivityExecutorConfig } from "./core/config-service.js";

// Initialize plugins by importing the index (which registers all plugins)
import "@/plugins/index.js";

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

// Global config loaded from Dapr
let appConfig: ActivityExecutorConfig;

export function getAppConfig(): ActivityExecutorConfig {
  return appConfig;
}

async function main() {
  // Load configuration from Dapr Configuration Store (Azure App Configuration)
  console.log("[Activity Executor] Loading configuration from Dapr...");
  try {
    appConfig = await loadActivityExecutorConfig();
    console.log("[Activity Executor] Configuration loaded:", {
      logLevel: appConfig.logLevel,
      maxConcurrentActivities: appConfig.maxConcurrentActivities,
      aiGatewayModel: appConfig.aiGateway.defaultModel,
      features: appConfig.features,
    });
  } catch (error) {
    console.warn("[Activity Executor] Failed to load Dapr config, using defaults:", error);
    appConfig = {
      logLevel: process.env.LOG_LEVEL || "info",
      maxConcurrentActivities: 10,
      activityTimeoutSeconds: 300,
      retryMaxAttempts: 3,
      retryDelaySeconds: 5,
      aiGateway: {
        defaultModel: "gpt-4o",
        defaultProvider: "openai",
        maxTokens: 4096,
      },
      features: {
        daprSecretsEnabled: true,
        databaseFallback: true,
        otelTracing: true,
      },
    };
  }

  const app = Fastify({
    logger: {
      level: appConfig.logLevel,
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
    console.log("[Activity Executor] Shutting down...");
    await app.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start server
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[Activity Executor] Server listening on http://${HOST}:${PORT}`);
    console.log("[Activity Executor] Ready to execute workflow activities");
  } catch (error) {
    console.error("[Activity Executor] Failed to start server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[Activity Executor] Unhandled error:", error);
  process.exit(1);
});
