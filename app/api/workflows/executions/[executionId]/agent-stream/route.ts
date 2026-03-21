/**
 * GET /api/workflows/executions/[executionId]/agent-stream
 *
 * SSE proxy for real-time agent activity streaming.
 * Connects directly to the agent runtime (bypasses Dapr sidecar to avoid
 * SSE buffering — same pattern as workflow-streaming-status.md).
 */

import { getSession } from "@/lib/auth-helpers";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { db } from "@/lib/db";
import { workflowAgentRuns, workflowExecutions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { AgentStreamEvent } from "@/lib/types/agent-stream-events";

export const dynamic = "force-dynamic";

const DAPR_AGENT_RUNTIME_URL =
	process.env.DAPR_AGENT_RUNTIME_API_BASE_URL ||
	"http://dapr-agent-runtime.workflow-builder.svc.cluster.local:8082";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ executionId: string }> },
) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return new Response("Unauthorized", { status: 401 });
	}

	const { executionId } = await params;

	// Find the agent run's Dapr instance ID
	const instanceId = await resolveAgentInstanceId(executionId);
	if (!instanceId) {
		return new Response("Agent run not found", { status: 404 });
	}

	// Forward Last-Event-ID for reconnection
	const lastEventId = request.headers.get("Last-Event-ID");
	const upstreamHeaders: Record<string, string> = {
		Accept: "text/event-stream",
	};
	if (lastEventId) {
		upstreamHeaders["Last-Event-ID"] = lastEventId;
	}

	// Direct HTTP to agent runtime (bypasses Dapr to avoid SSE buffering)
	const streamUrl = `${DAPR_AGENT_RUNTIME_URL}/api/run/${instanceId}/stream`;
	let upstreamResponse: Response;
	try {
		upstreamResponse = await fetch(streamUrl, {
			headers: upstreamHeaders,
			signal: request.signal,
		});
	} catch (error) {
		console.error("[agent-stream] Failed to connect to agent runtime:", error);
		return new Response("Agent runtime unavailable", { status: 502 });
	}

	if (!upstreamResponse.ok) {
		const text = await upstreamResponse.text().catch(() => "");
		return new Response(text || "Upstream error", {
			status: upstreamResponse.status,
		});
	}

	if (!upstreamResponse.body) {
		return new Response("No stream body", { status: 502 });
	}

	// Re-emit the upstream SSE stream to the browser
	const encoder = new TextEncoder();
	const reader = upstreamResponse.body.getReader();
	const decoder = new TextDecoder();
	let closed = false;

	const stream = new ReadableStream({
		async pull(controller) {
			if (closed) {
				controller.close();
				return;
			}
			try {
				const { done, value } = await reader.read();
				if (done) {
					closed = true;
					controller.close();
					return;
				}
				// Pass through SSE data as-is
				controller.enqueue(value);
			} catch {
				closed = true;
				controller.close();
			}
		},
		cancel() {
			closed = true;
			reader.cancel().catch(() => {});
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Resolve the agent runtime Dapr instance ID from an execution ID.
 *
 * Resolution order:
 * 1. agent_runs by workflow_execution_id (most common — orchestrator creates agent child runs)
 * 2. agent_runs by parent_execution_id (legacy format)
 * 3. Agent runtime state store mapping: parent orchestrator ID → child workflow ID
 * 4. execution's own dapr_instance_id (when the orchestrator IS the agent runtime)
 */
async function resolveAgentInstanceId(
	executionId: string,
): Promise<string | null> {
	// Try agent_runs by workflow_execution_id
	const agentRunsByExecution = await db
		.select({ daprInstanceId: workflowAgentRuns.daprInstanceId })
		.from(workflowAgentRuns)
		.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
		.orderBy(workflowAgentRuns.createdAt)
		.limit(1);

	if (agentRunsByExecution.length > 0 && agentRunsByExecution[0].daprInstanceId) {
		return agentRunsByExecution[0].daprInstanceId;
	}

	// Get orchestrator's own dapr instance ID
	const executions = await db
		.select({ daprInstanceId: workflowExecutions.daprInstanceId })
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	const orchestratorInstanceId = executions[0]?.daprInstanceId ?? null;

	if (orchestratorInstanceId) {
		// Try agent_runs by parent_execution_id (legacy format)
		const agentRunsByParent = await db
			.select({ daprInstanceId: workflowAgentRuns.daprInstanceId })
			.from(workflowAgentRuns)
			.where(eq(workflowAgentRuns.parentExecutionId, orchestratorInstanceId))
			.orderBy(workflowAgentRuns.createdAt)
			.limit(1);

		if (agentRunsByParent.length > 0 && agentRunsByParent[0].daprInstanceId) {
			return agentRunsByParent[0].daprInstanceId;
		}

		// Query agent runtime's state store mapping (parent → child workflow ID)
		try {
			const resolveUrl = `${DAPR_AGENT_RUNTIME_URL}/api/run/resolve-child?parentId=${encodeURIComponent(orchestratorInstanceId)}`;
			const resp = await fetch(resolveUrl, {
				signal: AbortSignal.timeout(5000),
			});
			if (resp.ok) {
				const data = (await resp.json()) as { childInstanceId?: string };
				if (data.childInstanceId) {
					return data.childInstanceId;
				}
			}
		} catch {
			// Agent runtime unavailable or no mapping — fall through
		}
	}

	// Fall back to execution's own dapr_instance_id
	// (when the orchestrator IS the agent runtime, e.g. OpenShell LangGraph workflow)
	return orchestratorInstanceId;
}
