import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { daprClient } from "@/lib/dapr-client";

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

  const session = await auth.api.getSession({
    headers: request.headers,
  });

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
  const orchestratorUrl =
    workflow?.daprOrchestratorUrl ||
    process.env.DAPR_ORCHESTRATOR_URL ||
    "http://planner-orchestrator:8080";
  const instanceId = execution.daprInstanceId;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      let lastPhase = "";
      let terminated = false;

      const poll = async () => {
        while (!terminated) {
          try {
            // Orchestrator returns flat: { workflow_id, runtime_status, phase, progress, message, output }
            const status = await daprClient.getWorkflowStatus(
              orchestratorUrl,
              instanceId
            );

            const phase = status.phase || "";
            const progress = status.progress ?? 0;
            const message = status.message || "";

            // Send update if phase changed or always send for running workflows
            if (phase !== lastPhase || status.runtime_status === "RUNNING") {
              sendEvent({
                type: "status",
                daprStatus: status.runtime_status,
                phase,
                progress,
                message,
              });
              lastPhase = phase;
            }

            // Update local DB - check phase and output.success for internal failures
            let localStatus: "running" | "success" | "error" = "running";
            let errorMessage: string | null = null;

            if (status.runtime_status === "COMPLETED") {
              // Check if workflow actually succeeded or failed internally
              const outputSuccess = (status.output as Record<string, unknown>)?.success;
              if (phase === "failed" || outputSuccess === false) {
                localStatus = "error";
                errorMessage = message || (status.output as Record<string, unknown>)?.error as string || "Workflow failed";
              } else {
                localStatus = "success";
              }
            } else if (
              status.runtime_status === "FAILED" ||
              status.runtime_status === "TERMINATED"
            ) {
              localStatus = "error";
              errorMessage = message || "Workflow failed";
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
              status.runtime_status === "COMPLETED" ||
              status.runtime_status === "FAILED" ||
              status.runtime_status === "TERMINATED"
            ) {
              sendEvent({
                type: "complete",
                daprStatus: status.runtime_status,
                phase,
                progress:
                  status.runtime_status === "COMPLETED" ? 100 : progress,
                message,
                output: status.output,
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
