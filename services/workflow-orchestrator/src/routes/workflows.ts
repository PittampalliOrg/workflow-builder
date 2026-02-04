/**
 * Workflows Routes
 *
 * REST API endpoints for managing workflow executions.
 * These are the v2 API endpoints that accept WorkflowDefinitions.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { DaprWorkflowClient } from "@dapr/dapr";
import { z } from "zod";
import type {
  WorkflowDefinition,
  DynamicWorkflowInput,
  WorkflowCustomStatus,
} from "../core/types.js";
import { dynamicWorkflow } from "../workflows/dynamic-workflow.js";

// Environment configuration
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_GRPC_PORT = process.env.DAPR_GRPC_PORT || "50001";

// Request/Response schemas using Zod
const StartWorkflowSchema = z.object({
  definition: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
    executionOrder: z.array(z.string()),
    metadata: z.object({
      description: z.string().optional(),
      author: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
  triggerData: z.record(z.string(), z.unknown()),
  integrations: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

const RaiseEventSchema = z.object({
  eventName: z.string(),
  eventData: z.unknown(),
});

const TerminateSchema = z.object({
  reason: z.string().optional(),
});

/**
 * Get the Dapr workflow client
 */
function getWorkflowClient(): DaprWorkflowClient {
  return new DaprWorkflowClient({
    daprHost: DAPR_HOST,
    daprPort: DAPR_GRPC_PORT,
  });
}

/**
 * Map Dapr runtime status to our status format
 */
function mapRuntimeStatus(
  daprStatus: string
): string {
  const statusMap: Record<string, string> = {
    WORKFLOW_RUNTIME_STATUS_UNSPECIFIED: "UNKNOWN",
    WORKFLOW_RUNTIME_STATUS_RUNNING: "RUNNING",
    WORKFLOW_RUNTIME_STATUS_COMPLETED: "COMPLETED",
    WORKFLOW_RUNTIME_STATUS_FAILED: "FAILED",
    WORKFLOW_RUNTIME_STATUS_TERMINATED: "TERMINATED",
    WORKFLOW_RUNTIME_STATUS_PENDING: "PENDING",
    WORKFLOW_RUNTIME_STATUS_SUSPENDED: "SUSPENDED",
    // Handle string values
    RUNNING: "RUNNING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    TERMINATED: "TERMINATED",
    PENDING: "PENDING",
    SUSPENDED: "SUSPENDED",
  };

  return statusMap[daprStatus] || "UNKNOWN";
}

export const workflowRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance
) => {
  /**
   * Start a new workflow instance
   * POST /api/v2/workflows
   */
  fastify.post("/api/v2/workflows", async (request, reply) => {
    try {
      const body = StartWorkflowSchema.parse(request.body);
      const { definition, triggerData, integrations } = body;

      const client = getWorkflowClient();

      // Build the input for the dynamic workflow
      const input: DynamicWorkflowInput = {
        definition: definition as WorkflowDefinition,
        triggerData,
        integrations,
      };

      // Generate a unique instance ID
      const instanceId = `${definition.id}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      console.log(
        `[Workflow Routes] Starting workflow: ${definition.name} (${instanceId})`
      );

      // Schedule the workflow
      const id = await client.scheduleNewWorkflow(
        dynamicWorkflow,
        input,
        instanceId
      );

      console.log(`[Workflow Routes] Workflow scheduled: ${id}`);

      return reply.status(201).send({
        instanceId: id,
        workflowId: definition.id,
        status: "started",
      });
    } catch (error) {
      console.error("[Workflow Routes] Failed to start workflow:", error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: error.issues,
        });
      }

      return reply.status(500).send({
        error: "Failed to start workflow",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * Get workflow status
   * GET /api/v2/workflows/:instanceId/status
   */
  fastify.get<{ Params: { instanceId: string } }>(
    "/api/v2/workflows/:instanceId/status",
    async (request, reply) => {
      try {
        const { instanceId } = request.params;

        const client = getWorkflowClient();
        const state = await client.getWorkflowState(instanceId, true);

        if (!state) {
          return reply.status(404).send({
            error: "Workflow not found",
            instanceId,
          });
        }

        // Cast state to access properties safely
        const stateAny = state as unknown as Record<string, unknown>;

        // Extract custom status from serializedOutput
        const serializedOutput = stateAny.serializedOutput as string | undefined;
        let customStatus: WorkflowCustomStatus = { phase: "pending", progress: 0 };
        if (serializedOutput) {
          try {
            customStatus = JSON.parse(serializedOutput) as WorkflowCustomStatus;
          } catch {
            // Ignore parse errors
          }
        }

        // Map runtime status
        const runtimeStatus = mapRuntimeStatus(
          stateAny.runtimeStatus?.toString() || "UNKNOWN"
        );

        // Extract failure details if present
        const failureDetails = stateAny.failureDetails as { message?: string } | undefined;

        return reply.send({
          instanceId,
          workflowId: stateAny.name || instanceId.split("-")[0],
          runtimeStatus,
          phase: customStatus.phase || (runtimeStatus === "RUNNING" ? "running" : "pending"),
          progress: customStatus.progress || 0,
          message: customStatus.message,
          currentNodeId: customStatus.currentNodeId,
          currentNodeName: customStatus.currentNodeName,
          outputs: serializedOutput ? JSON.parse(serializedOutput) : undefined,
          error: failureDetails?.message,
          startedAt: (stateAny.createdAt as Date)?.toISOString(),
          completedAt:
            runtimeStatus === "COMPLETED" || runtimeStatus === "FAILED"
              ? (stateAny.lastUpdatedAt as Date)?.toISOString()
              : undefined,
        });
      } catch (error) {
        console.error("[Workflow Routes] Failed to get workflow status:", error);

        return reply.status(500).send({
          error: "Failed to get workflow status",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  /**
   * Raise an external event to a workflow
   * POST /api/v2/workflows/:instanceId/events
   */
  fastify.post<{ Params: { instanceId: string } }>(
    "/api/v2/workflows/:instanceId/events",
    async (request, reply) => {
      try {
        const { instanceId } = request.params;
        const body = RaiseEventSchema.parse(request.body);
        const { eventName, eventData } = body;

        const client = getWorkflowClient();

        console.log(
          `[Workflow Routes] Raising event "${eventName}" for workflow: ${instanceId}`
        );

        await client.raiseEvent(instanceId, eventName, eventData);

        return reply.send({
          success: true,
          instanceId,
          eventName,
        });
      } catch (error) {
        console.error("[Workflow Routes] Failed to raise event:", error);

        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: "Invalid request body",
            details: error.issues,
          });
        }

        return reply.status(500).send({
          error: "Failed to raise event",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  /**
   * Terminate a running workflow
   * POST /api/v2/workflows/:instanceId/terminate
   */
  fastify.post<{ Params: { instanceId: string } }>(
    "/api/v2/workflows/:instanceId/terminate",
    async (request, reply) => {
      try {
        const { instanceId } = request.params;
        const body = TerminateSchema.parse(request.body || {});

        const client = getWorkflowClient();

        console.log(
          `[Workflow Routes] Terminating workflow: ${instanceId}`,
          body.reason ? `Reason: ${body.reason}` : ""
        );

        await client.terminateWorkflow(instanceId, body.reason);

        return reply.send({
          success: true,
          instanceId,
        });
      } catch (error) {
        console.error("[Workflow Routes] Failed to terminate workflow:", error);

        return reply.status(500).send({
          error: "Failed to terminate workflow",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  /**
   * Purge a completed workflow
   * DELETE /api/v2/workflows/:instanceId
   */
  fastify.delete<{ Params: { instanceId: string } }>(
    "/api/v2/workflows/:instanceId",
    async (request, reply) => {
      try {
        const { instanceId } = request.params;

        const client = getWorkflowClient();

        console.log(`[Workflow Routes] Purging workflow: ${instanceId}`);

        await client.purgeWorkflow(instanceId);

        return reply.send({
          success: true,
          instanceId,
        });
      } catch (error) {
        console.error("[Workflow Routes] Failed to purge workflow:", error);

        return reply.status(500).send({
          error: "Failed to purge workflow",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  /**
   * Suspend (pause) a running workflow
   * POST /api/v2/workflows/:instanceId/pause
   */
  fastify.post<{ Params: { instanceId: string } }>(
    "/api/v2/workflows/:instanceId/pause",
    async (request, reply) => {
      try {
        const { instanceId } = request.params;

        const client = getWorkflowClient();

        console.log(`[Workflow Routes] Suspending workflow: ${instanceId}`);

        await client.suspendWorkflow(instanceId);

        return reply.send({
          success: true,
          instanceId,
        });
      } catch (error) {
        console.error("[Workflow Routes] Failed to suspend workflow:", error);

        return reply.status(500).send({
          error: "Failed to suspend workflow",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  /**
   * Resume a paused workflow
   * POST /api/v2/workflows/:instanceId/resume
   */
  fastify.post<{ Params: { instanceId: string } }>(
    "/api/v2/workflows/:instanceId/resume",
    async (request, reply) => {
      try {
        const { instanceId } = request.params;

        const client = getWorkflowClient();

        console.log(`[Workflow Routes] Resuming workflow: ${instanceId}`);

        await client.resumeWorkflow(instanceId);

        return reply.send({
          success: true,
          instanceId,
        });
      } catch (error) {
        console.error("[Workflow Routes] Failed to resume workflow:", error);

        return reply.status(500).send({
          error: "Failed to resume workflow",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );
};
