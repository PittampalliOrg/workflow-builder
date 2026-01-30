/**
 * Health Check Routes
 *
 * Provides /health and /ready endpoints for Kubernetes probes.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { getDb } from "../core/db.js";

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
}
