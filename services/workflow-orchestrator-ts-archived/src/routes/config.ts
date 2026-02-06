/**
 * Configuration Routes
 *
 * Exposes Dapr Configuration Store (Azure App Configuration) to the Next.js app.
 * The Next.js app doesn't have a Dapr sidecar, so it proxies config requests through here.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const CONFIG_STORE = process.env.DAPR_CONFIG_STORE || "azureappconfig";
const CONFIG_LABEL = process.env.CONFIG_LABEL || "workflow-builder";

function daprUrl(path: string): string {
  return `http://${DAPR_HOST}:${DAPR_HTTP_PORT}${path}`;
}

interface ConfigurationItem {
  value: string;
  version?: string;
  metadata?: Record<string, string>;
}

/**
 * Get configuration values from Dapr Configuration Store
 */
async function getConfiguration(
  keys?: string[],
  label?: string
): Promise<Record<string, ConfigurationItem>> {
  try {
    const url = new URL(daprUrl(`/v1.0/configuration/${CONFIG_STORE}`));

    // Add keys as query parameters if specified
    if (keys && keys.length > 0) {
      keys.forEach((k) => url.searchParams.append("key", k));
    }

    // Add label if provided (defaults to "workflow-builder")
    if (label) {
      url.searchParams.set("metadata.label", label);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Configuration get failed: ${response.status} - ${errorText}`);
    }

    return (await response.json()) as Record<string, ConfigurationItem>;
  } catch (error) {
    console.error(`[Config] Failed to get configuration from Dapr:`, error);
    throw error;
  }
}

export const configRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance
) => {
  /**
   * GET /api/config - Get all configuration values
   * Query params:
   *   - label: Optional label filter (defaults to "workflow-builder")
   */
  fastify.get<{
    Querystring: { label?: string };
  }>("/api/config", async (request, reply) => {
    try {
      const label = request.query.label ?? CONFIG_LABEL;

      // Fetch all configs with the label filter
      const allConfigs = await getConfiguration(undefined, label);

      // Transform to a simple key-value map for the client
      const result: Record<string, string> = {};
      for (const [key, item] of Object.entries(allConfigs)) {
        result[key] = item.value;
      }

      return reply.status(200).send(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to get configuration";
      console.error("[Config] Error fetching all configs:", errorMessage);

      // Return empty object on error (client will use env var fallbacks)
      return reply.status(200).send({});
    }
  });

  /**
   * GET /api/config/:key - Get a specific configuration value
   * Query params:
   *   - label: Optional label filter (defaults to "workflow-builder")
   */
  fastify.get<{
    Params: { key: string };
    Querystring: { label?: string };
  }>("/api/config/:key", async (request, reply) => {
    try {
      const { key } = request.params;
      const label = request.query.label ?? CONFIG_LABEL;

      // First try to get the specific key
      const configs = await getConfiguration([key], label);

      if (configs[key]) {
        return reply.status(200).send({
          key,
          value: configs[key].value,
          version: configs[key].version,
        });
      }

      // If not found with label, try without label as fallback
      const allConfigs = await getConfiguration([key]);
      if (allConfigs[key]) {
        return reply.status(200).send({
          key,
          value: allConfigs[key].value,
          version: allConfigs[key].version,
        });
      }

      // Not found
      return reply.status(404).send({
        error: "Configuration not found",
        key,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to get configuration";
      console.error(`[Config] Error fetching config ${request.params.key}:`, errorMessage);

      // Return 404 on error (client will use env var fallbacks)
      return reply.status(404).send({
        error: errorMessage,
        key: request.params.key,
      });
    }
  });

  /**
   * GET /api/config/health - Check if Dapr Configuration Store is available
   */
  fastify.get("/api/config/health", async (_request, reply) => {
    try {
      // Try to get any config to verify connectivity
      await getConfiguration(undefined, CONFIG_LABEL);
      return reply.status(200).send({
        status: "ok",
        store: CONFIG_STORE,
        label: CONFIG_LABEL,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.status(503).send({
        status: "unavailable",
        store: CONFIG_STORE,
        error: errorMessage,
      });
    }
  });
};
