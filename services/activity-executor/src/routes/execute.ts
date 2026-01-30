/**
 * Execute Route
 *
 * POST /execute - Execute a workflow step/activity
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  executeStep,
  listAvailableActivities,
  type StepExecutionInput,
} from "../core/step-executor.js";
import type { NodeOutputs } from "../core/template-resolver.js";

// Request body schema using Zod v4
const ExecuteRequestSchema = z.object({
  activity_id: z.string().min(1),
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
});

type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

export async function executeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /execute - Execute a workflow activity
   *
   * This endpoint is called by the Python Dapr orchestrator via service invocation.
   * It executes the appropriate step handler based on the activity_id.
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

    console.log(`[Execute Route] Received request for activity: ${body.activity_id}`);
    console.log(`[Execute Route] Workflow: ${body.workflow_id}, Node: ${body.node_name}`);

    // Build step execution input
    const stepInput: StepExecutionInput = {
      activity_id: body.activity_id,
      execution_id: body.execution_id,
      workflow_id: body.workflow_id,
      node_id: body.node_id,
      node_name: body.node_name,
      input: body.input as Record<string, unknown>,
      node_outputs: body.node_outputs as NodeOutputs | undefined,
      integration_id: body.integration_id,
    };

    // Execute the step
    const result = await executeStep(stepInput);

    console.log(
      `[Execute Route] Activity ${body.activity_id} completed: success=${result.success}, duration=${result.duration_ms}ms`
    );

    // Return result with appropriate status code
    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(result);
  });

  /**
   * GET /activities - List all available activities
   *
   * Returns a list of all registered plugin actions that can be executed.
   * Useful for discovery and debugging.
   */
  app.get("/activities", async (_request, reply) => {
    try {
      const activities = await listAvailableActivities();
      return reply.status(200).send({
        success: true,
        activities,
        count: activities.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });
}
