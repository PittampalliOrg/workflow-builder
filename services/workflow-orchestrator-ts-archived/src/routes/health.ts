/**
 * Health Routes
 *
 * Kubernetes-compatible health check endpoints for the orchestrator service.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance
) => {
  /**
   * Liveness probe - returns 200 if the server is running
   */
  fastify.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  /**
   * Readiness probe - returns 200 if the server is ready to accept traffic
   */
  fastify.get("/readyz", async (_request, reply) => {
    // Could check Dapr sidecar connectivity here
    return reply.status(200).send({ status: "ready" });
  });

  /**
   * Health endpoint for general health checks
   */
  fastify.get("/health", async (_request, reply) => {
    return reply.status(200).send({
      status: "healthy",
      service: "workflow-orchestrator",
      timestamp: new Date().toISOString(),
    });
  });
};
