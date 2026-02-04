/**
 * Execute Route
 *
 * POST /execute - Execute a function by ID or slug
 *
 * This endpoint is called by the workflow-orchestrator via Dapr service invocation.
 * It dispatches to the appropriate handler based on the function's execution type.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadFunction, loadFunctionBySlug, listFunctions } from "../core/function-loader.js";
import { fetchCredentials } from "../core/credential-service.js";
import { resolveTemplates, type NodeOutputs } from "../core/template-resolver.js";
import { executeBuiltin, builtinExists } from "../handlers/builtin.js";
import { executeOci } from "../handlers/oci.js";
import { executeHttp } from "../handlers/http.js";
import type { ExecuteFunctionResult, FunctionDefinition } from "../core/types.js";
import { logExecutionStart, logExecutionComplete } from "../core/execution-logger.js";

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
  // User's integrations passed from the orchestrator
  // Format: { "openai": { "apiKey": "..." }, "slack": { "botToken": "..." } }
  integrations: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  // Database execution ID for logging (links to workflow_executions.id)
  // This is different from execution_id which is the Dapr instance ID
  db_execution_id: z.string().optional(),
});

type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

export async function executeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /execute - Execute a function
   *
   * This endpoint is called by the workflow-orchestrator via Dapr service invocation.
   * It dispatches to the appropriate handler based on the function's execution type.
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
      });
    }

    const body = parseResult.data;
    const identifier = body.function_slug || body.function_id;

    if (!identifier) {
      return reply.status(400).send({
        success: false,
        error: "Either function_id or function_slug is required",
        duration_ms: 0,
      });
    }

    console.log(`[Execute Route] Received request for function: ${identifier}`);
    console.log(`[Execute Route] Workflow: ${body.workflow_id}, Node: ${body.node_name}`);

    const startTime = Date.now();

    // Step 1: Load function definition
    let fn: FunctionDefinition | null = null;

    // First try to load from database
    fn = await loadFunction(identifier);

    // If not found in database and looks like a builtin slug, create a synthetic definition
    if (!fn && body.function_slug && builtinExists(body.function_slug)) {
      const pluginId = body.function_slug.split("/")[0];
      fn = {
        id: `builtin-${body.function_slug}`,
        name: body.function_slug,
        slug: body.function_slug,
        description: null,
        pluginId,
        version: "1.0.0",
        executionType: "builtin",
        imageRef: null,
        command: null,
        workingDir: null,
        containerEnv: null,
        webhookUrl: null,
        webhookMethod: null,
        webhookHeaders: null,
        webhookTimeoutSeconds: null,
        inputSchema: null,
        outputSchema: null,
        timeoutSeconds: 300,
        retryPolicy: null,
        maxConcurrency: null,
        integrationType: pluginId,
        isBuiltin: true,
        isEnabled: true,
        isDeprecated: false,
      };
      console.log(`[Execute Route] Using synthetic builtin definition for ${body.function_slug}`);
    }

    if (!fn) {
      return reply.status(404).send({
        success: false,
        error: `Function not found: ${identifier}`,
        duration_ms: Date.now() - startTime,
      });
    }

    if (!fn.isEnabled) {
      return reply.status(400).send({
        success: false,
        error: `Function is disabled: ${fn.slug}`,
        duration_ms: Date.now() - startTime,
      });
    }

    // Step 2: Resolve template variables in input
    const resolvedInput = body.node_outputs
      ? resolveTemplates(body.input as Record<string, unknown>, body.node_outputs as NodeOutputs)
      : body.input;

    // Step 3: Fetch credentials
    // Priority: 1) Passed integrations, 2) Dapr secrets, 3) Database lookup
    const integrationType = fn.integrationType || fn.pluginId;
    const credentials = await fetchCredentials(
      body.integration_id,
      integrationType,
      body.integrations
    );

    // Step 4: Execute based on execution type
    // Use db_execution_id for logging to workflow_execution_logs (FK to workflow_executions.id)
    // Fall back to execution_id (Dapr instance ID) if not provided
    const context = {
      executionId: body.db_execution_id || body.execution_id,
      workflowId: body.workflow_id,
      nodeId: body.node_id,
      nodeName: body.node_name,
    };

    // Log execution start (only if we have a valid database execution ID)
    let logId: string | undefined;
    if (body.db_execution_id) {
      try {
        logId = await logExecutionStart({
          executionId: body.db_execution_id,
          nodeId: body.node_id,
          nodeName: body.node_name,
          nodeType: "action",
          activityName: fn.slug,
          input: resolvedInput,
        });
      } catch (logError) {
        console.error(`[Execute Route] Failed to log execution start:`, logError);
      }
    }

    let result: ExecuteFunctionResult;

    switch (fn.executionType) {
      case "builtin":
        result = await executeBuiltin({
          fn,
          input: resolvedInput as Record<string, unknown>,
          credentials,
          context,
        });
        break;

      case "oci":
        result = await executeOci({
          fn,
          input: resolvedInput as Record<string, unknown>,
          credentials,
          context,
        });
        break;

      case "http":
        result = await executeHttp({
          fn,
          input: resolvedInput as Record<string, unknown>,
          credentials,
          context,
        });
        break;

      default:
        result = {
          success: false,
          error: `Unknown execution type: ${fn.executionType}`,
          duration_ms: Date.now() - startTime,
        };
    }

    console.log(
      `[Execute Route] Function ${fn.slug} completed: success=${result.success}, duration=${result.duration_ms}ms`
    );

    // Log execution completion (only if we started logging)
    if (logId && body.db_execution_id) {
      try {
        await logExecutionComplete(logId, {
          success: result.success,
          output: result.data,
          error: result.error,
          durationMs: result.duration_ms,
        });
      } catch (logError) {
        console.error(`[Execute Route] Failed to log execution completion:`, logError);
      }
    }

    // Return result with appropriate status code
    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(result);
  });

  /**
   * GET /functions - List all available functions
   *
   * Returns a list of all registered functions that can be executed.
   * Useful for discovery and debugging.
   */
  app.get("/functions", async (_request, reply) => {
    try {
      const functions = await listFunctions();

      // Also include builtin functions not yet in database
      const { getRegisteredActivityIds } = await import("../registry/step-registry.js");
      const builtinSlugs = getRegisteredActivityIds();
      const dbSlugs = new Set(functions.map((f) => f.slug));

      const builtinsNotInDb = builtinSlugs.filter((slug) => !dbSlugs.has(slug));

      return reply.status(200).send({
        success: true,
        functions: functions.map((f) => ({
          id: f.id,
          slug: f.slug,
          name: f.name,
          description: f.description,
          pluginId: f.pluginId,
          executionType: f.executionType,
          isBuiltin: f.isBuiltin,
        })),
        builtins_not_in_db: builtinsNotInDb,
        count: functions.length,
        builtin_count: builtinsNotInDb.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  /**
   * GET /functions/:slugOrId - Get function details
   */
  app.get<{ Params: { slugOrId: string } }>(
    "/functions/:slugOrId",
    async (request, reply) => {
      try {
        const fn = await loadFunction(request.params.slugOrId);

        if (!fn) {
          // Check if it's a builtin
          if (builtinExists(request.params.slugOrId)) {
            return reply.status(200).send({
              success: true,
              function: {
                slug: request.params.slugOrId,
                executionType: "builtin",
                isBuiltin: true,
                inDatabase: false,
              },
            });
          }

          return reply.status(404).send({
            success: false,
            error: `Function not found: ${request.params.slugOrId}`,
          });
        }

        return reply.status(200).send({
          success: true,
          function: {
            id: fn.id,
            slug: fn.slug,
            name: fn.name,
            description: fn.description,
            pluginId: fn.pluginId,
            version: fn.version,
            executionType: fn.executionType,
            inputSchema: fn.inputSchema,
            outputSchema: fn.outputSchema,
            timeoutSeconds: fn.timeoutSeconds,
            isBuiltin: fn.isBuiltin,
            isEnabled: fn.isEnabled,
            inDatabase: true,
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return reply.status(500).send({
          success: false,
          error: errorMessage,
        });
      }
    }
  );
}
