/**
 * Execute Route
 *
 * Routes function execution requests to the appropriate service:
 * - OpenFunctions (fn-openai, fn-slack, etc.) via direct HTTP to Knative services
 * - function-runner via Dapr service invocation for builtin fallback
 *
 * This route also pre-fetches credentials from Dapr secret store
 * to pass along to OpenFunctions.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DaprClient, HttpMethod } from "@dapr/dapr";
import { lookupFunction } from "../core/registry.js";
import { fetchCredentials } from "../core/credential-service.js";
import { resolveOpenFunctionUrl } from "../core/openfunction-resolver.js";
import { logExecutionStart, logExecutionComplete } from "../core/execution-logger.js";
import type { ExecuteRequest, ExecuteResponse, OpenFunctionRequest } from "../core/types.js";

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || "60000", 10);

// Request body schema using Zod
const ExecuteRequestSchema = z.object({
  function_id: z.string().optional(),
  function_slug: z.string().optional(),
  execution_id: z.string().min(1),
  workflow_id: z.string().min(1),
  node_id: z.string().min(1),
  node_name: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  node_outputs: z
    .record(
      z.string(),
      z.object({
        label: z.string(),
        data: z.unknown(),
      })
    )
    .optional(),
  integration_id: z.string().optional(),
  integrations: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  db_execution_id: z.string().optional(),
});

export async function executeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /execute - Route function execution to appropriate service
   */
  app.post<{ Body: ExecuteRequest }>("/execute", async (request, reply) => {
    // Validate request body
    const parseResult = ExecuteRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: "Validation failed",
        details: parseResult.error.issues,
        duration_ms: 0,
      } as ExecuteResponse);
    }

    const body = parseResult.data as ExecuteRequest;
    const functionSlug = body.function_slug || body.function_id;

    if (!functionSlug) {
      return reply.status(400).send({
        success: false,
        error: "Either function_id or function_slug is required",
        duration_ms: 0,
      } as ExecuteResponse);
    }

    console.log(`[Execute Route] Received request for function: ${functionSlug}`);
    console.log(`[Execute Route] Workflow: ${body.workflow_id}, Node: ${body.node_name}`);

    const startTime = Date.now();

    // Log execution start (only if we have a valid database execution ID)
    let logId: string | undefined;
    if (body.db_execution_id) {
      try {
        logId = await logExecutionStart({
          executionId: body.db_execution_id,
          nodeId: body.node_id,
          nodeName: body.node_name,
          nodeType: "action",
          actionType: functionSlug,
          input: body.input,
        });
      } catch (logError) {
        console.error(`[Execute Route] Failed to log execution start:`, logError);
      }
    }

    // Step 1: Look up the target service
    const target = await lookupFunction(functionSlug);
    console.log(`[Execute Route] Routing ${functionSlug} to ${target.appId} (${target.type})`);

    // Step 2: Create Dapr client for service invocation
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    try {
      let response: ExecuteResponse;

      if (target.type === "openfunction") {
        // Route to OpenFunction via direct HTTP to Knative service
        // Extract the step name from the slug (e.g., "openai/generate-text" -> "generate-text")
        const stepName = functionSlug.split("/")[1] || functionSlug;
        const pluginId = functionSlug.split("/")[0];

        // Pre-fetch credentials from Dapr secret store
        const credentials = await fetchCredentials(pluginId, body.integrations);

        const openFunctionRequest: OpenFunctionRequest = {
          step: stepName,
          execution_id: body.execution_id,
          workflow_id: body.workflow_id,
          node_id: body.node_id,
          input: body.input as Record<string, unknown>,
          node_outputs: body.node_outputs,
          credentials,
        };

        // Resolve the OpenFunction URL dynamically (queries K8s API, cached for 30s)
        const functionUrl = await resolveOpenFunctionUrl(target.appId);
        console.log(`[Execute Route] Invoking OpenFunction ${target.appId} step: ${stepName} at ${functionUrl}`);

        // Make direct HTTP call to the Knative service
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

        try {
          const httpResponse = await fetch(`${functionUrl}/execute`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(openFunctionRequest),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!httpResponse.ok) {
            const errorText = await httpResponse.text();
            throw new Error(`HTTP ${httpResponse.status}: ${errorText}`);
          }

          const result = await httpResponse.json();
          response = result as ExecuteResponse;
        } catch (httpError) {
          clearTimeout(timeoutId);
          if (httpError instanceof Error && httpError.name === "AbortError") {
            throw new Error(`Request to ${target.appId} timed out after ${HTTP_TIMEOUT_MS}ms`);
          }
          throw httpError;
        }

        response.routed_to = target.appId;
      } else {
        // Route to function-runner (builtin fallback)
        console.log(`[Execute Route] Routing to function-runner for builtin execution`);

        const result = await client.invoker.invoke(
          target.appId,
          "execute",
          HttpMethod.POST,
          body
        );

        response = result as ExecuteResponse;
        response.routed_to = target.appId;
      }

      const duration_ms = Date.now() - startTime;
      response.duration_ms = duration_ms;

      console.log(
        `[Execute Route] Function ${functionSlug} completed via ${target.appId}: success=${response.success}, duration=${duration_ms}ms`
      );

      // Log execution completion (only if we started logging)
      if (logId && body.db_execution_id) {
        try {
          await logExecutionComplete(logId, {
            success: response.success,
            output: response.data,
            error: response.error,
            durationMs: duration_ms,
          });
        } catch (logError) {
          console.error(`[Execute Route] Failed to log execution completion:`, logError);
        }
      }

      const statusCode = response.success ? 200 : 500;
      return reply.status(statusCode).send(response);
    } catch (error) {
      const duration_ms = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`[Execute Route] Failed to route ${functionSlug} to ${target.appId}:`, error);

      // Log execution failure (only if we started logging)
      if (logId && body.db_execution_id) {
        try {
          await logExecutionComplete(logId, {
            success: false,
            error: `Function routing failed: ${errorMessage}`,
            durationMs: duration_ms,
          });
        } catch (logError) {
          console.error(`[Execute Route] Failed to log execution failure:`, logError);
        }
      }

      return reply.status(500).send({
        success: false,
        error: `Function routing failed: ${errorMessage}`,
        duration_ms,
        routed_to: target.appId,
      } as ExecuteResponse);
    }
  });

  /**
   * GET /registry - List current function registry (for debugging)
   */
  app.get("/registry", async (_request, reply) => {
    const { loadRegistry } = await import("../core/registry.js");
    const registry = await loadRegistry();

    return reply.status(200).send({
      success: true,
      registry,
      count: Object.keys(registry).length,
    });
  });
}
