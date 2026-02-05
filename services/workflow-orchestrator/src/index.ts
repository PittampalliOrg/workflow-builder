/**
 * Workflow Orchestrator Service
 *
 * A TypeScript microservice that runs the Dapr Workflow Runtime for executing
 * workflow definitions from the visual workflow builder.
 *
 * Architecture:
 * - Fastify HTTP server for REST API endpoints
 * - Dapr Workflow Runtime for durable workflow execution
 * - Dapr service invocation to call function-router for OpenFunction execution
 * - Dapr state store for workflow state persistence
 * - Dapr pub/sub for event publishing
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { WorkflowRuntime } from "@dapr/dapr";
import { healthRoutes } from "./routes/health.js";
import { workflowRoutes } from "./routes/workflows.js";
import { configRoutes } from "./routes/config.js";
import { dynamicWorkflow } from "./workflows/dynamic-workflow.js";
import {
  executeAction,
  persistState,
  getState,
  deleteState,
  publishEvent,
  publishPhaseChanged,
  publishWorkflowStarted,
  publishWorkflowCompleted,
  publishWorkflowFailed,
  publishApprovalRequested,
} from "./activities/index.js";

// Configuration from environment
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_GRPC_PORT = process.env.DAPR_GRPC_PORT || "50001";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// Track runtime for graceful shutdown
let workflowRuntime: WorkflowRuntime | null = null;

/**
 * Initialize and start the Dapr Workflow Runtime
 */
async function startWorkflowRuntime(): Promise<WorkflowRuntime> {
  console.log(
    `[Workflow Orchestrator] Initializing Dapr Workflow Runtime (${DAPR_HOST}:${DAPR_GRPC_PORT})`
  );

  const runtime = new WorkflowRuntime({
    daprHost: DAPR_HOST,
    daprPort: DAPR_GRPC_PORT,
  });

  // Register the dynamic workflow
  runtime.registerWorkflow(dynamicWorkflow);
  console.log("[Workflow Orchestrator] Registered workflow: dynamicWorkflow");

  // Register all activities
  runtime.registerActivity(executeAction);
  runtime.registerActivity(persistState);
  runtime.registerActivity(getState);
  runtime.registerActivity(deleteState);
  runtime.registerActivity(publishEvent);
  runtime.registerActivity(publishPhaseChanged);
  runtime.registerActivity(publishWorkflowStarted);
  runtime.registerActivity(publishWorkflowCompleted);
  runtime.registerActivity(publishWorkflowFailed);
  runtime.registerActivity(publishApprovalRequested);
  console.log("[Workflow Orchestrator] Registered all activities");

  // Start the runtime
  await runtime.start();
  console.log("[Workflow Orchestrator] Dapr Workflow Runtime started");

  return runtime;
}

/**
 * Main entry point
 */
async function main() {
  console.log("=== Workflow Orchestrator Service ===");
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Dapr Host: ${DAPR_HOST}:${DAPR_GRPC_PORT}`);
  console.log("");

  // Create Fastify server
  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport:
        process.env.NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: {
                translateTime: "HH:MM:ss Z",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
  });

  // Enable CORS
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  // Register routes
  await app.register(healthRoutes);
  await app.register(workflowRoutes);
  await app.register(configRoutes);

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n[Workflow Orchestrator] Received ${signal}, shutting down...`);

    // Stop workflow runtime first
    if (workflowRuntime) {
      try {
        await workflowRuntime.stop();
        console.log("[Workflow Orchestrator] Workflow runtime stopped");
      } catch (error) {
        console.error("[Workflow Orchestrator] Error stopping workflow runtime:", error);
      }
    }

    // Close HTTP server
    await app.close();
    console.log("[Workflow Orchestrator] HTTP server closed");

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    // Start the Dapr Workflow Runtime
    // Note: In production, the Dapr sidecar must be ready before this succeeds
    try {
      workflowRuntime = await startWorkflowRuntime();
    } catch (error) {
      console.warn(
        "[Workflow Orchestrator] Failed to start workflow runtime (Dapr sidecar may not be ready):",
        error instanceof Error ? error.message : error
      );
      console.warn("[Workflow Orchestrator] Will retry when processing requests...");
    }

    // Start HTTP server
    await app.listen({ port: PORT, host: HOST });
    console.log(`[Workflow Orchestrator] Server listening on http://${HOST}:${PORT}`);
    console.log("[Workflow Orchestrator] Ready to accept workflow requests");

    // If runtime failed initially, try to start it after a delay
    if (!workflowRuntime) {
      setTimeout(async () => {
        try {
          workflowRuntime = await startWorkflowRuntime();
        } catch (error) {
          console.error(
            "[Workflow Orchestrator] Retry failed, workflow execution may not work:",
            error instanceof Error ? error.message : error
          );
        }
      }, 5000);
    }
  } catch (error) {
    console.error("[Workflow Orchestrator] Failed to start server:", error);
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error("[Workflow Orchestrator] Unhandled error:", error);
  process.exit(1);
});
