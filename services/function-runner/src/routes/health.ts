/**
 * Health Routes
 *
 * Provides health check endpoints for Kubernetes liveness and readiness probes.
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../core/db.js";

let isReady = false;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /health - Simple health check
   */
  app.get("/health", async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  /**
   * GET /healthz - Kubernetes liveness probe
   * Returns 200 if the service is alive
   */
  app.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  /**
   * GET /readyz - Kubernetes readiness probe
   * Returns 200 if the service is ready to accept traffic
   * Checks database connectivity
   */
  app.get("/readyz", async (_request, reply) => {
    try {
      // Check database connection using raw SQL client
      const sql = getSql();
      await sql`SELECT 1`;

      isReady = true;
      return reply.status(200).send({
        status: "ok",
        ready: true,
        checks: {
          database: "ok",
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.status(503).send({
        status: "error",
        ready: false,
        checks: {
          database: errorMessage,
        },
      });
    }
  });

  /**
   * GET /status - Detailed status information
   */
  app.get("/status", async (_request, reply) => {
    const { getRegisteredActivityIds } = await import("../registry/step-registry.js");
    const builtinCount = getRegisteredActivityIds().length;

    return reply.status(200).send({
      status: "ok",
      service: "function-runner",
      version: "1.0.0",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      builtinFunctions: builtinCount,
      ready: isReady,
    });
  });
}

/**
 * Mark the service as ready
 */
export function setReady(ready: boolean): void {
  isReady = ready;
}
