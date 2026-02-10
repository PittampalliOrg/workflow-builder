import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth-helpers";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

/**
 * GET /api/dapr/workflows/[id]/events - SSE event stream for Dapr workflow status
 *
 * Polls the Dapr orchestrator for status updates and streams them as SSE events.
 * The orchestrator returns a flat status response:
 *   { workflow_id, runtime_status, phase, progress, message, output }
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const session = await getSession(request);

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const execution = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, id),
  });

  if (!execution || execution.userId !== session.user.id) {
    return new Response("Not found", { status: 404 });
  }

  if (!execution.daprInstanceId) {
    return new Response("Not a Dapr workflow execution", { status: 400 });
  }

  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, execution.workflowId),
  });
  const defaultOrchestratorUrl = await getGenericOrchestratorUrl();
  const orchestratorUrl =
    workflow?.daprOrchestratorUrl || defaultOrchestratorUrl;
  const instanceId = execution.daprInstanceId;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let lastPhase = "";
      let terminated = false;

      const poll = async () => {
        while (!terminated) {
          try {
            // Generic orchestrator v2 API: { instanceId, runtimeStatus, phase, progress, message, outputs }
            const status = await genericOrchestratorClient.getWorkflowStatus(
              orchestratorUrl,
              instanceId
            );

            const phase = status.phase || "";
            const progress = status.progress ?? 0;
            const message = status.message || "";

            // Send update if phase changed or always send for running workflows
            if (phase !== lastPhase || status.runtimeStatus === "RUNNING") {
              sendEvent({
                type: "status",
                daprStatus: status.runtimeStatus,
                phase,
                progress,
                message,
              });
              lastPhase = phase;
            }

            // Update local DB - check phase and outputs.success for internal failures
            let localStatus: "running" | "success" | "error" = "running";
            let errorMessage: string | null = status.error || null;
            const outputs = status.outputs as
              | Record<string, unknown>
              | undefined;
            const outputSuccess = outputs?.success;

            if (status.runtimeStatus === "COMPLETED") {
              // Check if workflow actually succeeded or failed internally
              if (phase === "failed" || outputSuccess === false) {
                localStatus = "error";
                errorMessage =
                  errorMessage ||
                  message ||
                  (outputs?.error as string) ||
                  "Workflow failed";
              } else {
                localStatus = "success";
              }
            } else if (
              status.runtimeStatus === "FAILED" ||
              status.runtimeStatus === "TERMINATED"
            ) {
              localStatus = "error";
              errorMessage = errorMessage || message || "Workflow failed";
            } else if (status.runtimeStatus === "UNKNOWN") {
              // UNKNOWN typically means workflow completed and was purged from runtime
              // Check phase and outputs to determine actual status
              if (phase === "completed" || outputSuccess === true) {
                localStatus = "success";
              } else if (phase === "failed" || outputSuccess === false) {
                localStatus = "error";
                errorMessage =
                  errorMessage ||
                  message ||
                  (outputs?.error as string) ||
                  "Workflow failed";
              }
              // If phase/outputs don't indicate completion, keep as running
            }

            await db
              .update(workflowExecutions)
              .set({
                status: localStatus,
                phase: phase || null,
                progress: progress || null,
                ...(errorMessage ? { error: errorMessage } : {}),
                ...(localStatus !== "running"
                  ? { completedAt: new Date() }
                  : {}),
              })
              .where(eq(workflowExecutions.id, id));

            // Stop polling if workflow is done
            if (
              status.runtimeStatus === "COMPLETED" ||
              status.runtimeStatus === "FAILED" ||
              status.runtimeStatus === "TERMINATED"
            ) {
              sendEvent({
                type: "complete",
                daprStatus: status.runtimeStatus,
                phase,
                progress: status.runtimeStatus === "COMPLETED" ? 100 : progress,
                message,
                output: status.outputs,
              });
              terminated = true;
              controller.close();
              return;
            }
          } catch (error) {
            sendEvent({
              type: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to poll status",
            });
          }

          // Poll every 2 seconds
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      };

      poll();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
