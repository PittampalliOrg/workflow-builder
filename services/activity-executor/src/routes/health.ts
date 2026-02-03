/**
 * Health Check Routes
 *
 * Provides /health and /ready endpoints for Kubernetes probes.
 * Also provides /status for detailed Dapr component status.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { getDb } from "../core/db.js";
import { getConfig } from "../core/config-service.js";

const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";

/**
 * Check if Dapr sidecar is available
 */
async function checkDaprSidecar(): Promise<{ available: boolean; metadata?: Record<string, unknown> }> {
  try {
    const response = await fetch(`http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/metadata`);
    if (response.ok) {
      const metadata = await response.json();
      return { available: true, metadata };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

/**
 * Check if a secret can be fetched from Dapr
 */
async function checkDaprSecrets(): Promise<{ available: boolean; store?: string }> {
  try {
    // Try to list secrets (just check if store is accessible)
    const response = await fetch(`http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/secrets/azure-keyvault/bulk`);
    if (response.ok || response.status === 403) {
      // 403 means auth works but bulk access denied (which is fine)
      return { available: true, store: "azure-keyvault" };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

/**
 * Check if configuration can be fetched from Dapr
 */
async function checkDaprConfig(): Promise<{ available: boolean; store?: string; sampleConfig?: string }> {
  try {
    const logLevel = await getConfig("log-level");
    if (logLevel) {
      return { available: true, store: "azureappconfig", sampleConfig: `log-level=${logLevel}` };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness probe - basic health check
   * Returns 200 if the service is alive
   */
  app.get("/health", async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  /**
   * Readiness probe - checks if service can handle requests
   * Verifies database connection is working
   */
  app.get("/ready", async (_request, reply) => {
    try {
      // Attempt a simple database query
      const db = getDb();
      await db.execute(sql`SELECT 1`);

      return reply.status(200).send({
        status: "ready",
        database: "connected",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.status(503).send({
        status: "not_ready",
        database: "disconnected",
        error: errorMessage,
      });
    }
  });

  /**
   * Detailed status endpoint - shows all component statuses
   * Useful for debugging and monitoring
   */
  app.get("/status", async (_request, reply) => {
    const [daprStatus, secretsStatus, configStatus] = await Promise.all([
      checkDaprSidecar(),
      checkDaprSecrets(),
      checkDaprConfig(),
    ]);

    let dbStatus: { connected: boolean; error?: string } = { connected: false };
    try {
      const db = getDb();
      await db.execute(sql`SELECT 1`);
      dbStatus = { connected: true };
    } catch (error) {
      dbStatus = { connected: false, error: error instanceof Error ? error.message : "Unknown" };
    }

    const allHealthy = daprStatus.available && dbStatus.connected;

    return reply.status(allHealthy ? 200 : 503).send({
      status: allHealthy ? "healthy" : "degraded",
      components: {
        database: dbStatus,
        dapr: {
          sidecar: daprStatus,
          secretStore: secretsStatus,
          configStore: configStatus,
        },
      },
      timestamp: new Date().toISOString(),
    });
  });
}
