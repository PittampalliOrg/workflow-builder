/**
 * Health Check Routes
 */
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /healthz - Liveness probe
   */
  app.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({ status: "healthy" });
  });

  /**
   * GET /readyz - Readiness probe
   */
  app.get("/readyz", async (_request, reply) => {
    return reply.status(200).send({ status: "ready" });
  });

  /**
   * GET /health - Alias for /healthz
   */
  app.get("/health", async (_request, reply) => {
    return reply.status(200).send({ status: "healthy" });
  });
}
